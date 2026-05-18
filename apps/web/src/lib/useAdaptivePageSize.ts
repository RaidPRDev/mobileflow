import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/**
 * Returns a page-size that fits the available viewport vertically, so a
 * paginated list can render without a scrollbar.
 *
 * Two measurement modes:
 *   1. Ref mode (preferred): pass `anchorRef` pointing at the rows container
 *      (e.g. the `.data-grid` div). Available height is
 *      `window.innerHeight - anchorRef.top - reserve`. ResizeObserver +
 *      `resize` keep it in sync.
 *   2. Estimate mode (fallback): pass `chrome` (total non-row pixels) and we
 *      subtract that from `window.innerHeight`. Less robust because it
 *      assumes a fixed header/footer height.
 *
 * `reserve` is everything between the anchor's top and where the rows can
 * end: any internal column header inside the container + footer + bottom
 * padding + a safety margin.
 *
 * NOTE: don't anchor on a `display: contents` element — `getBoundingClientRect`
 * is unreliable across browsers for those. Use the parent layout box.
 */
export function useAdaptivePageSize(opts: {
  rowHeight: number;
  anchorRef?: RefObject<HTMLElement>;
  reserve?: number;
  chrome?: number;
  min?: number;
  max?: number;
}): number {
  const { rowHeight, anchorRef, reserve = 120, chrome = 320, min = 5, max = 30 } = opts;

  const compute = (): number => {
    if (typeof window === "undefined") return min;
    const el = anchorRef?.current ?? null;
    const avail = el
      ? window.innerHeight - el.getBoundingClientRect().top - reserve
      : window.innerHeight - chrome;
    const rows = Math.floor(Math.max(0, avail) / rowHeight);
    return Math.max(min, Math.min(max, rows));
  };

  // Initial value uses the estimate path because refs aren't attached yet
  // during useState init; useLayoutEffect below corrects it before paint.
  const [size, setSize] = useState<number>(() => compute());

  useEffect(() => {
    const onResize = () => setSize(compute());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight, reserve, chrome, min, max]);

  useLayoutEffect(() => {
    setSize(compute());
    const el = anchorRef?.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize(compute()));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorRef, rowHeight, reserve, chrome, min, max]);

  return size;
}
