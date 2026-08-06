import { useMemo, useRef, useState } from "react";

export type SortDir = "asc" | "desc";

/** Value a column sorts on. `null`/`undefined` always sort last. */
export type SortValue = string | number | null | undefined;

/**
 * Client-side column sorting for the listing tables, paired with
 * `components/SortableHead` for the header UI.
 *
 * Sort the **full** list with this and paginate the result — sorting only the
 * visible page would reorder within the page and leave the pages themselves in
 * the old order.
 *
 * Clicking the active column flips direction; clicking a new one selects it
 * ascending. Tables open on `defaultKey` — usually the first column, A→Z, but
 * pass `defaultDir: "desc"` where newest-first is the more useful landing state.
 */
export function useTableSort<T>(
  rows: T[],
  /** One accessor per sortable column key. Columns with no entry can't be sorted. */
  accessors: Record<string, (row: T) => SortValue>,
  defaultKey: string,
  defaultDir: SortDir = "asc",
): {
  sorted: T[];
  sortKey: string;
  dir: SortDir;
  onSort: (key: string) => void;
} {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [dir, setDir] = useState<SortDir>(defaultDir);

  // Callers build `accessors` inline, so it's a fresh object every render. Read
  // it through a ref rather than depending on it, or the memo below would
  // re-sort the whole list on every render.
  const accessorsRef = useRef(accessors);
  accessorsRef.current = accessors;

  const onSort = (key: string) => {
    if (key === sortKey) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDir("asc");
    }
  };

  const sorted = useMemo(() => {
    const get = accessorsRef.current[sortKey];
    if (!get) return rows;
    const factor = dir === "asc" ? 1 : -1;
    // Array.prototype.sort is stable, so rows that tie keep the order they
    // arrived in (the API's newest-first ordering).
    return [...rows].sort((a, b) => factor * compareValues(get(a), get(b)));
  }, [rows, sortKey, dir]);

  return { sorted, sortKey, dir, onSort };
}

/**
 * Blanks last regardless of direction, numbers numerically, everything else as
 * a natural-order string compare so "#9" lands before "#10" rather than after.
 */
function compareValues(a: SortValue, b: SortValue): number {
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
