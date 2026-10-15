import { CircleCheckBig } from "lucide-react";

/**
 * The app's checkmark, in one place.
 *
 * Every success / OK / "step passed" indicator imports this instead of pulling
 * an icon straight from lucide, so changing the glyph is a one-line edit here
 * rather than a sweep across every admin page. The Deploy page used to reach
 * for lucide's plain `CircleCheck`, which sat next to `CircleCheckBig`
 * everywhere else and read as a different icon family.
 *
 * Pairs with `CircleXBig`, the failure counterpart drawn to match this glyph's
 * ring. Props are lucide's (`size`, `className`, anything an `<svg>` takes).
 */
export const CheckIcon = CircleCheckBig;
