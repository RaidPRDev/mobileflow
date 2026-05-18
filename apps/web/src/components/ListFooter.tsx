import { Button } from "@mobileflow/ui";

/**
 * Shared "<count> X | Previous / Next" footer used by every paginated listing
 * page (Builds, Commits, Deployments, Store Destinations history). Pair with
 * `useAdaptivePageSize` so the visible page fits the viewport without a
 * scrollbar.
 */
export function ListFooter({
  total,
  pageIdx,
  pageCount,
  unit,
  countLabel,
  onPrev,
  onNext,
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
