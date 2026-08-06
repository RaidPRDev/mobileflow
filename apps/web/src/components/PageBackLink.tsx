import { ArrowLeft } from "lucide-react";

/**
 * The "← Back" affordance that sits above a page title.
 *
 * The whole row is a single button wrapping both the circular arrow badge and
 * the label. They used to be siblings — a `<button>` holding just the icon next
 * to a plain `<span>` — so only the 24px circle was clickable and clicking the
 * word "Back" did nothing. The label is the button's accessible name here, so
 * no `aria-label` is needed.
 */
export function PageBackLink({
  label = "Back",
  onClick,
}: {
  label?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="page-back-row" onClick={onClick}>
      <span className="page-back-link" aria-hidden>
        <ArrowLeft size={14} />
      </span>
      <span className="page-back-label">{label}</span>
    </button>
  );
}
