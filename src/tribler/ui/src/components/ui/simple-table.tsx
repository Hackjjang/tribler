import { SetStateAction, useEffect, useRef, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getCoreRowModel, useReactTable, flexRender, getFilteredRowModel, getPaginationRowModel, getExpandedRowModel, getSortedRowModel } from '@tanstack/react-table';
import type { ColumnDef, Row, PaginationState, RowSelectionState, ColumnFiltersState, ExpandedState, ColumnDefTemplate, HeaderContext, SortingState, VisibilityState, Header, Column } from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel } from './select';
import { Button } from './button';
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, DotsHorizontalIcon, DoubleArrowLeftIcon, DoubleArrowRightIcon } from '@radix-ui/react-icons';
import * as SelectPrimitive from "@radix-ui/react-select"
import type { Table as ReactTable } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { useResizeObserver } from '@/hooks/useResizeObserver';
import useKeyboardShortcut from 'use-keyboard-shortcut';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './dropdown-menu';
import { triblerService } from '@/services/tribler.service';


declare module '@tanstack/table-core/build/lib/types' {
    export interface ColumnMeta<TData extends RowData, TValue> {
        hide_by_default: boolean;
    }
}


export function getHeader<T>(name: string, translate: boolean = true, addSorting: boolean = true): ColumnDefTemplate<HeaderContext<T, unknown>> | undefined {
    if (!addSorting) {
        return () => {
            const { t } = useTranslation();
            return <span className='select-none'>{translate ? t(name) : name}</span>;
        }
    }

    return ({ column }) => {
        const { t } = useTranslation();
        return (
            <div className='select-none flex'>
                <span
                    className="cursor-pointer hover:text-black dark:hover:text-white flex flex-row items-center"
                    onClick={(e) => column.toggleSorting(undefined, e.shiftKey)}>
                    {translate ? t(name) : name}
                    {column.getIsSorted() === "desc" ? (
                        <ArrowDownIcon className="ml-2" />
                    ) : column.getIsSorted() === "asc" ? (
                        <ArrowUpIcon className="ml-2" />
                    ) : (
                        <></>
                    )}
                </span>
            </div>
        )
    }
}

function getState(type: "columns" | "sorting", name?: string) {
    let stateString = triblerService.guiSettings[type];
    if (stateString && name) {
        return JSON.parse(stateString)[name];
    }
}

function setState(type: "columns" | "sorting", name: string, state: SortingState | VisibilityState) {
    let stateString = triblerService.guiSettings[type];
    let stateSettings = stateString ? JSON.parse(stateString) : {};
    stateSettings[name] = state;

    triblerService.guiSettings[type] = JSON.stringify(stateSettings);
    triblerService.setSettings({ ui: triblerService.guiSettings });
}

interface ReactTableProps<T extends object> {
    data: T[];
    columns: ColumnDef<T>[];
    renderSubComponent?: (props: { row: Row<T> }) => React.ReactElement;
    pageIndex?: number;
    pageSize?: number;
    pageCount?: number;
    onPaginationChange?: (pagination: PaginationState) => void;
    onRowDoubleClick?: (rowDoubleClicked: T) => void;
    onSelectedRowsChange?: (rowSelection: T[]) => void;
    initialRowSelection?: Record<string, boolean>;
    allowSelect?: boolean;
    allowSelectCheckbox?: boolean;
    allowMultiSelect?: boolean;
    allowColumnToggle?: string;
    filters?: { id: string, value: string }[];
    maxHeight?: string | number;
    expandable?: boolean;
    storeSortingState?: string;
    rowId?: (originalRow: T, index: number, parent?: Row<T>) => string,
}

function SimpleTable<T extends object>({
    data,
    columns,
    pageIndex,
    pageSize,
    pageCount,
    onPaginationChange,
    onRowDoubleClick,
    onSelectedRowsChange,
    initialRowSelection,
    allowSelect,
    allowSelectCheckbox,
    allowMultiSelect,
    allowColumnToggle,
    filters,
    maxHeight,
    expandable,
    storeSortingState,
    rowId
}: ReactTableProps<T>) {
    const [pagination, setPagination] = useState<PaginationState>({
        pageIndex: pageIndex ?? 0,
        pageSize: pageSize ?? 20,
    });
    const [rowSelection, setRowSelection] = useState<RowSelectionState>(initialRowSelection || {});
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(filters || [])
    const [expanded, setExpanded] = useState<ExpandedState>({});
    const [sorting, setSorting] = useState<SortingState>(getState("sorting", storeSortingState) || []);

    //Get stored column visibility and add missing visibilities with their defaults.
    const visibilityState = getState("columns", allowColumnToggle) || {};
    let col: any;
    for (col of columns) {
        if (col.accessorKey && col.accessorKey in visibilityState === false) {
            visibilityState[col.accessorKey] = col.meta?.hide_by_default !== true;
        }
    }
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(visibilityState);

    useKeyboardShortcut(["Control", "A"], () => {
        if (allowMultiSelect) {
            table.toggleAllRowsSelected(true);
        }
    }, { overrideSystem: true, repeatOnHold: false });
    useKeyboardShortcut(["ArrowUp"], () => {
        let ids = Object.keys(rowSelection);
        let rows = table.getSortedRowModel().rows;
        let index = rows.findIndex((row) => ids.includes(row.id));
        let next = rows[index - 1] || rows[0];

        let selection: any = {};
        selection[next.id.toString()] = true;
        table.setRowSelection(selection);

        document.querySelector("[data-state='selected']")?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    });
    useKeyboardShortcut(["ArrowDown"], () => {
        let ids = Object.keys(rowSelection);
        let rows = table.getSortedRowModel().rows;
        let index = rows.findLastIndex((row) => ids.includes(row.id));
        let next = rows[index + 1] || rows[rows.length - 1];

        let selection: any = {};
        selection[next.id.toString()] = true;
        table.setRowSelection(selection);

        document.querySelector("[data-state='selected']")?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    });

    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getPaginationRowModel: !!pageSize ? getPaginationRowModel() : undefined,
        getExpandedRowModel: expandable ? getExpandedRowModel() : undefined,
        enableRowSelection: true,
        pageCount,
        state: {
            pagination,
            rowSelection,
            columnFilters,
            columnVisibility,
            expanded,
            sorting
        },
        getFilteredRowModel: getFilteredRowModel(),
        onColumnFiltersChange: setColumnFilters,
        onColumnVisibilityChange: setColumnVisibility,
        onPaginationChange: setPagination,
        onRowSelectionChange: (arg: SetStateAction<RowSelectionState>) => {
            if (allowSelect || allowSelectCheckbox || allowMultiSelect) setRowSelection(arg);
        },
        onExpandedChange: setExpanded,
        onSortingChange: setSorting,
        getSubRows: (row: any) => row?.subRows,
        getRowId: rowId,
        autoResetPageIndex: false,
    });

    // If we're on an empty page, reset the pageIndex to 0
    if (table.getRowModel().rows.length == 0 && table.getExpandedRowModel().rows.length != 0) {
        setPagination(p => ({ ...p, pageIndex: 0 }));
    }

    const { t } = useTranslation();

    useEffect(() => {
        if (onPaginationChange) {
            onPaginationChange(pagination);
        }
    }, [pagination, onPaginationChange]);

    useEffect(() => {
        if (onSelectedRowsChange)
            onSelectedRowsChange(
                table.getSelectedRowModel().flatRows.map((row) => row.original),
            )
    }, [rowSelection, table, onSelectedRowsChange])

    useEffect(() => {
        if (filters) {
            for (let filter of filters) {
                table.getColumn(filter.id)?.setFilterValue(filter.value);
            }
        }
    }, [filters])

    useEffect(() => {
        if (storeSortingState) {
            setState("sorting", storeSortingState, sorting);
        }
    }, [sorting]);

    useEffect(() => {
        if (allowColumnToggle) {
            setState("columns", allowColumnToggle, columnVisibility);
        }
    }, [columnVisibility]);

    // For some reason the ScrollArea scrollbar is only shown when it's set to a specific height.
    // So, we wrap it in a parent div, monitor its size, and set the height of the table accordingly.
    const parentRef = useRef<HTMLTableElement>(null);
    const parentRect = (!maxHeight) ? useResizeObserver({ ref: parentRef }) : undefined;

    return (
        <>
            <div ref={parentRef} className='flex-grow flex'>
                <Table maxHeight={maxHeight ?? (parentRect?.height ?? 200)}>
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id} className="bg-neutral-100 hover:bg-neutral-100 dark:bg-neutral-900 dark:hover:bg-neutral-900">
                                {headerGroup.headers.map((header, index) => {
                                    return (
                                        <TableHead key={header.id} className={cn({
                                            'pl-4': index === 0,
                                            'pr-4': !allowColumnToggle && index + 1 === headerGroup.headers.length,
                                            'pr-0': !!allowColumnToggle
                                        })}>
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                        </TableHead>
                                    )
                                })}
                                {allowColumnToggle && <TableHead key="toggleColumns" className="w-2 pl-1 pr-3 cursor-pointer hover:text-black dark:hover:text-white">
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <DotsHorizontalIcon className="h-4 w-4" />
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuLabel>{t('Toggle columns')}</DropdownMenuLabel>
                                            <DropdownMenuSeparator />
                                            {table.getAllLeafColumns().map(column => {
                                                const fakeColumn = {
                                                    ...column,
                                                    toggleSorting: () => { },
                                                    getIsSorted: () => { },
                                                } as Column<any, unknown>;
                                                return (
                                                    <DropdownMenuItem key={`toggleColumns-${column.id}`}>
                                                        <label onClick={(evt) => evt.stopPropagation()} className='flex space-x-1'>
                                                            <input
                                                                {...{
                                                                    type: 'checkbox',
                                                                    checked: column.getIsVisible(),
                                                                    onChange: column.getToggleVisibilityHandler(),
                                                                }}
                                                            />{flexRender(column.columnDef.header, {
                                                                table,
                                                                column: fakeColumn,
                                                                header: { column: fakeColumn } as Header<any, unknown>,
                                                            })}
                                                        </label>
                                                    </DropdownMenuItem>
                                                )
                                            })}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </TableHead>}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {table.getRowModel().rows?.length ? (
                            table.getPaginationRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && "selected"}
                                    className={`${allowSelect || allowMultiSelect ? "cursor-pointer" : ""}`}
                                    onClick={(event) => {
                                        if (!allowSelect && !allowMultiSelect)
                                            return

                                        if (allowMultiSelect && (event.ctrlKey || event.shiftKey)) {
                                            row.toggleSelected(!row.getIsSelected());
                                        } else {
                                            const selected = row.getIsSelected()
                                            table.resetRowSelection();
                                            row.toggleSelected(!selected);
                                        }
                                    }}
                                    onDoubleClick={() => {
                                        if (onRowDoubleClick) {
                                            onRowDoubleClick(row.original)
                                        }
                                    }}>
                                    {row.getVisibleCells().map((cell, index) => (
                                        <TableCell key={cell.id} className={cn({ 'pl-4': index === 0, 'pr-4': index + 1 === row.getVisibleCells().length, })}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                                    {t('NoResults')}
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>

            {!!pageSize && table.getPageCount() > 1 && <Pagination table={table} />}
        </>
    )
}

function Pagination<T>({ table }: React.PropsWithChildren<{ table: ReactTable<T> }>) {
    const pageIndex = table.getState().pagination.pageIndex;
    const pageSize = table.getState().pagination.pageSize;
    const rowCount = table.getExpandedRowModel().rows.length;

    const { t } = useTranslation();

    return (
        <div className="flex items-center justify-end px-4 py-0.5">
            <div className="flex items-center space-x-4">
                <Select defaultValue="0"
                    value={`${pageSize}`}
                    onValueChange={(value) => {
                        let size = Number(value);
                        if (size === 0) {
                            for (let row of table.getExpandedRowModel().rows) {
                                size += row.getLeafRows().length;
                            }
                        }
                        table.setPageSize(size);
                    }}>
                    <SelectPrimitive.Trigger>
                        <div className="px-1 py-0 hover:bg-inherit text-muted-foreground text-xs">
                            {pageIndex * pageSize}&nbsp;-&nbsp;
                            {Math.min((pageIndex + 1) * pageSize, rowCount)}&nbsp;of&nbsp;
                            {rowCount}
                        </div>
                    </SelectPrimitive.Trigger>
                    <SelectContent side="top">
                        <SelectGroup>
                            <SelectLabel>Rows per page</SelectLabel>
                            {[10, 20, 30, 40, 50, 0].map((pageSize) => (
                                <SelectItem key={pageSize} value={`${pageSize}`}>
                                    {pageSize > 0 ? pageSize : 'disable pagination'}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    </SelectContent>
                </Select>
                <div className="flex items-center space-x-2">
                    <Button
                        variant="outline"
                        className="hidden h-8 w-8 p-0 lg:flex"
                        onClick={() => table.setPageIndex(0)}
                        disabled={!table.getCanPreviousPage()}>
                        <span className="sr-only">{t('GotoFirst')}</span>
                        <DoubleArrowLeftIcon className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="outline"
                        className="h-8 w-8 p-0"
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}>
                        <span className="sr-only">{t('GotoPrev')}</span>
                        <ChevronLeftIcon className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="outline"
                        className="h-8 w-8 p-0"
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}>
                        <span className="sr-only">{t('GotoNext')}</span>
                        <ChevronRightIcon className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="outline"
                        className="hidden h-8 w-8 p-0 lg:flex"
                        onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                        disabled={!table.getCanNextPage()}>
                        <span className="sr-only">{t('GotoLast')}</span>
                        <DoubleArrowRightIcon className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    )
}

export default SimpleTable;
