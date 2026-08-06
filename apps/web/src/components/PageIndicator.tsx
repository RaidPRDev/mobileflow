/**
 * Numbered page indicator for the shared list footer.
 *
 * Ported from the ABA Docebo reporting UI (`frontend/src/shell/pagination.tsx`)
 * so the two products page the same way; the styling here is MobileFlow's.
 */

/**
 * Compact page list: `first … around-current … last`. Near either end the
 * cluster grows against that end with a single gap on the far side, then splits
 * into two gaps once the current page pulls away from both:
 *
 *   p1 → 1 2 … 10   p2 → 1 2 3 … 10   p3 → 1 2 3 4 … 10   p4 → 1 … 3 4 5 … 10
 *
 * Collapses only past 5 pages — 5 or fewer fit without any gap.
 */
export function pageList(page: number, pageCount: number): (number | "gap")[] {
  if (pageCount <= 5) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: (number | "gap")[] = [];
  out.push(1);
  if (page > 3) out.push("gap");
  for (let n = Math.max(2, page - 1); n <= Math.min(pageCount - 1, page + 1); n++) out.push(n);
  if (page < pageCount - 2) out.push("gap");
  out.push(pageCount);
  return out;
}

export function PageIndicator({
  /** 0-indexed, matching ListFooter's `pageIdx`. */
  pageIdx,
  pageCount,
  onPage,
  disabled,
}: {
  pageIdx: number;
  pageCount: number;
  /** Receives a 0-indexed page. */
  onPage: (pageIdx: number) => void;
  disabled?: boolean;
}) {
  const page = pageIdx + 1;
  return (
    <nav className="list-footer__pages" aria-label="Pagination">
      {pageList(page, pageCount).map((p, i) =>
        p === "gap" ? (
          <span key={`gap-${i}`} className="list-footer__page-gap" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={`list-footer__page${p === page ? " is-active" : ""}`}
            aria-label={`Page ${p}`}
            aria-current={p === page ? "page" : undefined}
            // The current page is still focusable (screen readers announce
            // aria-current) but clicking it would refetch for nothing.
            disabled={disabled || p === page}
            onClick={() => onPage(p - 1)}
          >
            {p}
          </button>
        ),
      )}
    </nav>
  );
}
