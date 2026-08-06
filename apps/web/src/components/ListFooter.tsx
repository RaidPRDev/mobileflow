import { Button } from "@mobileflow/ui";
import { PageIndicator } from "./PageIndicator";

/**
 * Shared "<count> X | 1 2 … 9 | Previous / Next" footer used by every paginated
 * listing page (Builds, Commits, Deployments, Store Destinations history). Pair
 * with `useAdaptivePageSize` so the visible page fits the viewport without a
 * scrollbar.
 *
 * The numbered indicator only appears when the caller can jump to an arbitrary
 * page (`onPage`) and there is more than one — a pager that only knows
 * prev/next keeps the buttons alone.
 */
export function ListFooter({
  total,
  pageIdx,
  pageCount,
  unit,
  countLabel,
  onPrev,
  onNext,
  onPage,
  busy,
}: {
  total?: number;
  pageIdx: number;
  pageCount: number;
  /** Singular noun ("build", "commit"). The footer pluralizes when total ≠ 1. */
  unit?: string;
  /** Pre-formatted count label — takes precedence over total/unit when supplied. */
  countLabel?: string;
  onPrev: () => void;
  onNext: () => void;
  /** Jump straight to a page (0-indexed). Omit to hide the numbered indicator. */
  onPage?: (pageIdx: number) => void;
  /** When true, the pager buttons are disabled regardless of page bounds (e.g. while a fetch is in flight). */
  busy?: boolean;
}) {
  const label = (() => {
    if (countLabel != null) return countLabel;
    if (total == null || unit == null) return "";
    const plural = total === 1 ? unit : `${unit}s`;
    return `${total.toLocaleString()} ${plural}`;
  })();
  const canPrev = pageIdx > 0 && !busy;
  const canNext = pageIdx < pageCount - 1 && !busy;
  return (
    <div className="list-footer">
      <span className="list-footer__count">{label}</span>
      {onPage && pageCount > 1 ? (
        <PageIndicator
          pageIdx={pageIdx}
          pageCount={pageCount}
          onPage={onPage}
          disabled={busy}
        />
      ) : (
        // Keeps the three-column grid intact so the pager stays hard right.
        <span />
      )}
      <div className="list-footer__pager">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={!canPrev}>
          Previous
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!canNext}>
          Next
        </Button>
      </div>
    </div>
  );
}
