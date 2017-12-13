import os
import logging

from glob import glob
from binascii import unhexlify, hexlify
from twisted.internet.task import LoopingCall
from twisted.internet.defer import Deferred, DeferredList, succeed

from Tribler.Core.CreditMining.CreditMiningSource import ChannelSource
from Tribler.Core.CreditMining.CreditMiningPolicy import UploadPolicy, RandomPolicy
from Tribler.Core.DownloadConfig import DefaultDownloadStartupConfig, DownloadStartupConfig
from Tribler.Core.simpledefs import DLSTATUS_DOWNLOADING, DLSTATUS_STOPPED, DLSTATUS_SEEDING, DLSTATUS_STOPPED_ON_ERROR
from Tribler.Core.TorrentDef import TorrentDefNoMetainfo
from Tribler.dispersy.taskmanager import TaskManager


class CreditMiningTorrent(object):
    def __init__(self, infohash, name, download=None, state=None):
        self.infohash = infohash
        self.name = name
        self.download = download
        self.state = state
        self.sources = set()
        self.force_checked = False


class CreditMiningSettings(object):
    """
    This class contains settings used by the credit mining manager
    """
    def __init__(self):
        self.max_torrents_active = 8
        self.max_torrents_listed = 100
        # Note: be sure to set this interval to something that gives torrents a fair chance of
        # discovering peers and uploading data
        self.auto_manage_interval = 600
        self.hops = 1
        self.save_path = os.path.join(DefaultDownloadStartupConfig.getInstance().get_dest_dir(), 'credit_mining')


class CreditMiningManager(TaskManager):
    """
    Class to manage all the credit mining activities
    """

    def __init__(self, session, settings=None):
        super(CreditMiningManager, self).__init__()
        self._logger = logging.getLogger(self.__class__.__name__)

        self.session = session
        self.settings = settings or CreditMiningSettings()

        self.sources = {}
        self.torrents = {}
        self.policies = []
        self.num_checkpoints = 0

        self.select_lc = self.register_task('select_torrents', LoopingCall(self.select_torrents))
        self.session_ready = Deferred()

    def initialize(self, policies=None):
        self._logger.info('Starting CreditMiningManager')

        # Our default policy: 50% of torrents are selected by upload, 50% of torrents are selected randomly
        self.policies = policies or [UploadPolicy(), RandomPolicy()]

        if not os.path.exists(self.settings.save_path):
            os.makedirs(self.settings.save_path)

        self.num_checkpoints = len(glob(os.path.join(self.session.get_downloads_pstate_dir(), '*.state')))

        def add_sources(_):
            for source in self.session.get_credit_mining_sources():
                self.add_source(source)

        self.session_ready.addCallback(add_sources)

    def shutdown(self, remove_downloads=False):
        """
        Shutting down credit mining manager. It also stops and remove all the sources.
        """
        self._logger.info('Shutting down CreditMiningManager')

        deferreds = []
        if remove_downloads:
            sources = self.sources.keys()
            for source in sources:
                deferreds.append(self.remove_source(source))

        self.cancel_all_pending_tasks()

        # shutil.rmtree(self.settings.save_path, ignore_errors=True)

        return DeferredList(deferreds)

    def add_source(self, source_str):
        """
        Add new source into the credit mining manager
        """
        if source_str not in self.sources:
            num_torrents = len(self.torrents)

            if isinstance(source_str, basestring) and len(source_str) == 40:
                source = ChannelSource(self.session, source_str, self.on_torrent_insert)
            else:
                self._logger.error('Cannot add unknown source %s', source_str)
                return

            self.sources[source_str] = source
            source.start()
            self._logger.info('Added source %s', source_str)

            # If we don't have any torrents and the select LoopingCall is running, stop it.
            # It will restart immediately after we have enough torrents.
            if num_torrents == 0 and self.select_lc.running:
                self.select_lc.stop()
        else:
            self._logger.info('Already have source %s', source_str)

    def remove_source(self, source_str):
        """
        remove source by stop the downloading and remove its metainfo for all its swarms
        """
        if source_str in self.sources:
            source = self.sources.pop(source_str)
            source.stop()
            self._logger.info('Removed source %s', source_str)

            deferreds = []
            for infohash, torrent in self.torrents.items():
                if source_str in torrent.sources:
                    torrent.sources.remove(source_str)
                    if not torrent.sources:
                        del self.torrents[infohash]

                        if torrent.download:
                            deferreds.append(self.session.remove_download(torrent.download,
                                                                          removestate=True, hidden=True))
                            self._logger.info('Removing torrent %s', torrent.infohash)
            self._logger.info('Removing %s download(s)', len(deferreds))

            self.cancel_all_pending_tasks()

            # shutil.rmtree(self.settings.save_path, ignore_errors=True)

            return DeferredList(deferreds)

        self._logger.error('Cannot remove non-existing source %s', source)
        return succeed(None)

    def on_torrent_insert(self, source_str, infohash, name):
        """
        Callback function called by the source when a new torrent is discovered
        """
        self._logger.debug('Received torrent %s from %s', infohash, source_str)

        if source_str not in self.sources:
            self._logger.debug('Skipping torrent %s (unknown source %s)', infohash, source_str)
            return

        # Did we already get this torrent from another source?
        if infohash in self.torrents:
            self.torrents[infohash].sources.add(source_str)
            self._logger.debug('Skipping torrent %s (already known)', infohash)
            return

        # If a download already exists or already has a checkpoint, skip this torrent
        if self.session.get_download(unhexlify(infohash)) or \
           os.path.exists(os.path.join(self.session.get_downloads_pstate_dir(), infohash + '.state')):
            self._logger.debug('Skipping torrent %s (download already running or scheduled to run)', infohash)
            return

        if len(self.torrents) >= self.settings.max_torrents_listed:
            self._logger.debug('Skipping torrent %s (limit reached)', infohash)
            return

        self.torrents[infohash] = CreditMiningTorrent(infohash, name)
        self.torrents[infohash].sources.add(source_str)
        self._logger.info('Starting torrent %s', infohash)

        magnet = u'magnet:?xt=urn:btih:%s&dn=%s' % (infohash, name)

        dl_config = DownloadStartupConfig()
        dl_config.set_hops(self.settings.hops)
        dl_config.set_dest_dir(self.settings.save_path)
        dl_config.set_credit_mining(True)
        dl_config.set_user_stopped(True)

        self.session.lm.add(TorrentDefNoMetainfo(unhexlify(infohash), name, magnet), dl_config, hidden=True)

    def select_torrents(self):
        """
        Function to select which torrent in the torrent list will be downloaded in the
        next iteration. It depends on the source and applied policy
        """
        if self.policies and self.torrents:
            # Determine which torrent to start and which to stop.
            loaded_torrents = [torrent for torrent in self.torrents.itervalues() if torrent.download]

            policy_results = [iter(policy.sort(loaded_torrents)) for policy in self.policies]

            to_start = []
            while len(to_start) < self.settings.max_torrents_active and \
                  len(to_start) < len(self.torrents):
                index = len(to_start) % len(self.policies)
                policy_result = policy_results[index]
                for torrent in policy_result:
                    if torrent not in to_start:
                        to_start.append(torrent)
                        break

            started = stopped = 0
            for infohash, torrent in self.torrents.items():
                if torrent in to_start and torrent.download.get_status() == DLSTATUS_STOPPED:
                    self._logger.info('Starting torrent %s', torrent.infohash)
                    torrent.download.restart()
                    started += 1
                elif torrent not in to_start and \
                     torrent.download.get_status() not in [DLSTATUS_STOPPED, DLSTATUS_STOPPED_ON_ERROR]:
                    # If the swarm appears to be dead, remove it altogether
                    if torrent.state and torrent.state.get_availability() < 1:
                        self._logger.info('Removing torrent %s', torrent.infohash)
                        del self.torrents[infohash]
                        self.session.remove_download(torrent.download, removestate=True, hidden=True)
                    else:
                        self._logger.info('Stopping torrent %s', torrent.infohash)
                        torrent.download.stop()
                    stopped += 1
            self._logger.info('Started %d torrent(s), stopped %d torrent(s)', started, stopped)

    def monitor_downloads(self, dslist):
        active = 0
        stopped = 0
        uploaded = 0
        for ds in dslist:
            download = ds.get_download()

            if download.get_credit_mining():
                tdef = download.get_def()
                infohash = hexlify(tdef.get_infohash())

                if infohash not in self.torrents:
                    self.torrents[infohash] = CreditMiningTorrent(infohash, tdef.get_name())

                self.torrents[infohash].download = download
                self.torrents[infohash].state = ds

                if ds.get_status() in [DLSTATUS_DOWNLOADING, DLSTATUS_SEEDING]:
                    active += 1
                if ds.get_status() in [DLSTATUS_STOPPED, DLSTATUS_STOPPED_ON_ERROR]:
                    stopped += 1
                uploaded += ds.seeding_uploaded

                if ds.get_status() == DLSTATUS_STOPPED_ON_ERROR:
                    self._logger.error('Got an error for credit mining download %s', infohash)
                    if infohash in self.torrents and not self.torrents[infohash].force_checked:
                        self._logger.info('Attempting to recheck download %s', infohash)
                        download.force_recheck()
                        self.torrents[infohash].force_checked = True

        self._logger.info('%d active download(s), %d bytes uploaded', active, uploaded)

        if not self.session_ready.called and len(dslist) == self.num_checkpoints:
            self.session_ready.callback(None)

        # We start the looping call when all torrents have been loaded
        total = active + stopped
        if not self.select_lc.running and total == len(self.torrents) and total >= self.settings.max_torrents_active:
            self.select_lc.start(self.settings.auto_manage_interval, now=True)
