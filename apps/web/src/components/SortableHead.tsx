import { ArrowDown, ArrowUp } from "lucide-react";
import type { SortDir } from "../lib/useTableSort";

export interface SortableColumn {
  /** Matches the accessor key passed to `useTableSort`. */
  key: string;
  label: string;
  /** Set false for columns with nothing to order by (the actions gutter). */
  sortable?: boolean;
  /** Accessible name for columns whose label is empty. */
  ariaLabel?: string;
}

/**
 * Header row for the listing tables, with click-to-sort on every sortable
 * column. Pair with `lib/useTableSort`, which owns the state and the ordering.
 *
 * A sortable cell is a `columnheader` span wrapping a plain button — the role
 * has to stay on the span so the button keeps its own semantics, and `aria-sort`
 * belongs on the header, not the control. The cell gives its padding up to the
 * button (`.is-sortable`), which is what makes the hover tint and the hit area
 * cover the whole cell instead of just the text.
 *
 * Modelled on the admin database browser's sortable headers: the active column
 * shows its direction, and the rest show a ghost arrow on hover that previews
 * what a click would do.
 */
export function SortableHead({
  columns,
  sortKey,
  dir,
  onSort,
  className = "data-grid__head",
}: {
  columns: SortableColumn[];
  sortKey: string;
  dir: SortDir;
  onSort: (key: string) => void;
  /** The head class for the table in question (some tables aren't `.data-grid`). */
  className?: string;
}) {
  return (
    <div className={className} role="row">
      {columns.map((c) =>
        c.sortable === false ? (
          <span key={c.key} role="columnheader" aria-label={c.ariaLabel}>
            {c.label}
          </span>
        ) : (
          <span
            key={c.key}
            role="columnheader"
            className="is-sortable"
            aria-sort={sortKey === c.key ? (dir === "asc" ? "ascending" : "descending") : "none"}
          >
            <button type="button" className="table-sort" onClick={() => onSort(c.key)}>
              <span className="table-sort__label">{c.label}</span>
              {sortKey === c.key ? (
                dir === "asc" ? (
                  <ArrowUp size={11} aria-hidden />
                ) : (
                  <ArrowDown size={11} aria-hidden />
                )
              ) : (
                // Always rendered so selecting a column never shifts the label.
                <ArrowUp size={11} className="table-sort__hint" aria-hidden />
              )}
            </button>
          </span>
        ),
      )}
    </div>
  );
}
