import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Pads a paginated grid out to a full page with empty rows, so the footer below
 * it stays put instead of riding up on a short last page (9 rows on page 1, 6 on
 * page 2 → the pager used to jump).
 *
 * The row height is *measured* rather than taken from the `rowHeight` each page
 * hands `useAdaptivePageSize`: that value is a deliberate estimate used only to
 * decide how many rows fit, and a filler a few pixels off the real thing would
 * still let the footer drift.
 *
 * Grid rows are `display: contents`, so a row element has no box of its own —
 * the cells are the grid items. Both the measurement and the applied height
 * therefore target a cell, not the row — unless `measure="row"`, for flex
 * lists whose rows do own their box (e.g. the commit lists).
 */
export function TableFillerRows({
  gridRef,
  rowSelector,
  count,
  columns,
  measure = "cell",
}: {
  /** The grid container holding the rows. */
  gridRef: RefObject<HTMLElement>;
  /** Selector matching one real (non-filler) row inside the grid. */
  rowSelector: string;
  /** How many rows short of a full page this page is; ≤ 0 renders nothing. */
  count: number;
  /** Cells per row — must match the grid's column count or the layout shifts. */
  columns: number;
  /** What carries the row's height: its first cell (grid rows, the default) or
   *  the row element itself (flex lists). */
  measure?: "cell" | "row";
}) {
  const [cellHeight, setCellHeight] = useState<number | null>(null);

  // No dependency array: re-measure after every render, since row height moves
  // with the data (a commit message that starts wrapping) and with the theme.
  // Re-setting the same number is a no-op in React, so this settles immediately
  // rather than looping.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const measureRow = () => {
      const row = grid.querySelector<HTMLElement>(rowSelector);
      const target = measure === "row" ? row : row?.firstElementChild;
      if (target) setCellHeight(target.getBoundingClientRect().height);
    };
    measureRow();

    if (typeof ResizeObserver === "undefined") return;
    // Also catches column reflow, which changes row height whenever a cell's
    // text starts or stops wrapping.
    const ro = new ResizeObserver(measureRow);
    ro.observe(grid);
    return () => ro.disconnect();
  });

  // Until a real row has been measured there's nothing to match, and rendering
  // zero-height fillers would flash a collapsed block on first paint.
  if (count <= 0 || cellHeight == null) return null;

  return (
    <>
      {Array.from({ length: count }, (_, row) => (
        <div className="table-filler-row" role="presentation" aria-hidden key={row}>
          {Array.from({ length: columns }, (_, cell) => (
            <div key={cell} style={{ minHeight: cellHeight }} />
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * How many filler rows a page needs. Returns 0 for single-page lists — there's
 * no other page to stay consistent with, so padding one out would just add dead
 * space below a short list.
 */
export function fillerCount(pageSize: number, visibleCount: number, pageCount: number): number {
  return pageCount > 1 ? Math.max(0, pageSize - visibleCount) : 0;
}
