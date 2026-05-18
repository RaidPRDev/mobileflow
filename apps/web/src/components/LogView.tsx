import { forwardRef, useEffect, useMemo, useRef, type CSSProperties, type UIEvent } from "react";
import { freshState, parseDelta, type ParseState, type ParsedLine, type Token } from "../lib/logRender";

interface LogViewProps {
  // Full raw log buffer as currently held by BuildPage. The component diffs
  // against its internal state to figure out which bytes are new vs. a
  // snapshot replacement.
  raw: string;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  empty?: React.ReactNode;
  className?: string;
}

export const LogView = forwardRef<HTMLDivElement, LogViewProps>(function LogView(
  { raw, onScroll, empty, className },
  ref,
) {
  // Keep parsed lines + parser state across renders. We intentionally avoid
  // useState here because every appended chunk would trigger a re-render of
  // unchanged lines via React.memo cache invalidation. Instead, we rebuild
  // the rendered array lazily in useMemo keyed by `raw.length`.
  const stateRef = useRef<ParseState>(freshState());
  const linesRef = useRef<ParsedLine[]>([]);

  const lines = useMemo(() => {
    const { lines: appended, state } = parseDelta(raw, stateRef.current);
    if (state.consumed < stateRef.current.consumed) {
      // Snapshot replacement detected by parseDelta — reset accumulated lines.
      linesRef.current = appended;
    } else {
      linesRef.current = linesRef.current.concat(appended);
    }
    stateRef.current = state;
    return linesRef.current;
    // raw.length captures append; raw itself catches snapshot churn where the
    // length is the same but content differs (rare but possible on reconnect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, raw.length]);

  // If the raw buffer empties (new build navigated to), reset.
  useEffect(() => {
    if (raw.length === 0) {
      stateRef.current = freshState();
      linesRef.current = [];
    }
  }, [raw]);

  if (lines.length === 0) {
    return (
      <div ref={ref} onScroll={onScroll} className={className} role="log" aria-live="polite">
        {empty}
      </div>
    );
  }

  return (
    <div ref={ref} onScroll={onScroll} className={className} role="log" aria-live="polite">
      {lines.map((line) => (
        <div
          key={line.id}
          className={lineClass(line)}
        >
          {line.tokens.length === 0 ? (
            // Empty line — emit a non-breaking space so the row still has height.
            <span>{" "}</span>
          ) : (
            line.tokens.map((tok, i) => <TokenSpan key={i} tok={tok} />)
          )}
        </div>
      ))}
    </div>
  );
});

function lineClass(line: ParsedLine): string {
  const parts = ["build-logs__line"];
  if (line.isStderr) parts.push("is-stderr");
  if (line.isPhaseHeader) parts.push("is-phase");
  return parts.join(" ");
}

function TokenSpan({ tok }: { tok: Token }) {
  if (tok.kind === "text") return <>{tok.text}</>;
  const cls = tokenClass(tok);
  if (tok.kind === "ansi") {
    const style: CSSProperties = {};
    if (tok.style?.color) style.color = tok.style.color;
    if (tok.style?.background) style.background = tok.style.background;
    if (tok.style?.bold) style.fontWeight = 700;
    if (tok.style?.italic) style.fontStyle = "italic";
    if (tok.style?.underline) style.textDecoration = "underline";
    return <span className={cls} style={style}>{tok.text}</span>;
  }
  return <span className={cls}>{tok.text}</span>;
}

function tokenClass(tok: Token): string {
  const base = `log-tok log-tok--${tok.kind}`;
  if (tok.variant) return `${base} is-${tok.variant}`;
  return base;
}
