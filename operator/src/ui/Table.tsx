import type { ReactNode } from "react";
import { Spinner } from "./Icon";

export type Column<Row> = {
  key: string;
  header: ReactNode;
  cell(row: Row): ReactNode;
  align?: "left" | "right";
  /** CSS width such as "120px" or "30%". */
  width?: string;
};

/**
 * A plain data table. Rows are clickable when onRowClick is given, and the table scrolls
 * sideways inside its own box on narrow screens instead of widening the page.
 */
export function Table<Row>({ columns, rows, rowKey, onRowClick, empty, loading, caption }: {
  columns: Column<Row>[];
  rows: Row[] | null;
  rowKey(row: Row): string;
  onRowClick?(row: Row): void;
  empty?: ReactNode;
  /** Shown while rows is null. */
  loading?: ReactNode;
  caption?: string;
}) {
  return (
    <div className="table-wrap">
      <table className={`table${onRowClick ? " table--clickable" : ""}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={{ width: column.width, textAlign: column.align ?? "left" }}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows === null && (
            <tr><td colSpan={columns.length} className="table__state">{loading ?? <><Spinner small /> Loading...</>}</td></tr>
          )}
          {rows?.length === 0 && (
            <tr><td colSpan={columns.length} className="table__state">{empty ?? "Nothing here yet."}</td></tr>
          )}
          {rows?.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (event) => { if (event.key === "Enter") onRowClick(row); } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((column) => <td key={column.key} style={{ textAlign: column.align ?? "left" }}>{column.cell(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
