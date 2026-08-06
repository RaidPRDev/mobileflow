import { forwardRef, type SVGProps } from "react";

/**
 * The X counterpart to lucide's `CircleCheckBig`, used for failed rows in status
 * columns.
 *
 * Lucide ships no "big" X — only `CircleX`, whose ring is closed and whose cross
 * stays small and fully enclosed. Sitting next to the big check in the same
 * column the two read as different icon families, so this redraws the X in that
 * style out of parts of both:
 *
 *   - the ring is `CircleCheckBig`'s path verbatim, so the two circles are
 *     pixel-identical at any size;
 *   - the cross is `CircleX`'s, with its up-right arm extended out through the
 *     ring's top-right gap exactly as the big check's long arm does.
 *
 * Props mirror a lucide icon (`size`, plus anything an `<svg>` takes) so it is a
 * drop-in swap at the call sites.
 */
export const CircleXBig = forwardRef<
  SVGSVGElement,
  SVGProps<SVGSVGElement> & { size?: number | string }
>(({ size = 24, ...props }, ref) => (
  <svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    {/* Ring with a gap in the top-right — CircleCheckBig's exact path. */}
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    {/* Long arm: crosses the centre at 45° and breaks out through the gap. */}
    <path d="M21 3 9 15" />
    {/* Short arm: the other diagonal, kept inside the ring. */}
    <path d="m9 9 6 6" />
  </svg>
));

CircleXBig.displayName = "CircleXBig";
