/**
 * Height-animated show/hide. Uses the CSS grid 0fr → 1fr trick so the content
 * can be intrinsic-height (no measuring, no max-height guessing). Content
 * stays mounted while closed so the collapse can animate both ways.
 */
export function Collapse({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`collapse${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden={!open}
    >
      <div className="collapse__inner">{children}</div>
    </div>
  );
}
