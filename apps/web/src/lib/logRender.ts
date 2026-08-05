// Streaming log tokenizer for the build log view. The backend sends raw bytes
// (now with ANSI when the runner scripts set FORCE_COLOR / Gradle's
// --console=rich). We parse each line into typed tokens so the renderer can
// color them via CSS — ANSI passthrough first, then a regex pass over the
// uncolored ranges to paint structural elements (timestamps, levels, paths,
// SUCCEEDED / FAILED markers, etc.).

import Anser from "anser";

export type TokenKind =
  | "text"
  | "ansi"
  | "timestamp"
  | "level"
  | "phase"
  | "path"
  | "url"
  | "duration"
  | "size"
  | "success"
  | "failure"
  | "stderr-marker";

export interface Token {
  kind: TokenKind;
  text: string;
  // For "ansi": inline style derived from the escape codes.
  style?: { color?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean };
  // For "level": "info" | "warn" | "error" | "debug" | "fatal" — drives a class modifier.
  variant?: string;
}

export interface ParsedLine {
  id: number;
  tokens: Token[];
  isStderr: boolean;
  isPhaseHeader: boolean;
  /**
   * Stream-independent judgement of whether this line reports a problem.
   * Drives the red wash. `isStderr` deliberately does NOT: git, xcodebuild and
   * altool all write ordinary progress to stderr, so colouring by stream paints
   * a successful build in alarm-red.
   */
  isError: boolean;
}

export interface ParseState {
  // Holds back a trailing partial line until the next chunk supplies its \n,
  // so we never half-color a line.
  tail: string;
  nextId: number;
  // Total raw bytes already consumed from the caller's buffer. Lets the caller
  // detect snapshot replacement (buffer shrank / prefix mismatch) and reset.
  consumed: number;
}

export function freshState(): ParseState {
  return { tail: "", nextId: 0, consumed: 0 };
}

// ── Regex pass ──────────────────────────────────────────────────────────────
//
// Ordered most-specific-first. Each entry returns a TokenKind (and optional
// variant). Anchors are deliberately loose so a match can land anywhere in a
// text run, not just line start.

interface RuleHit {
  kind: TokenKind;
  variant?: string;
  start: number;
  end: number;
}

interface Rule {
  re: RegExp;
  kind: TokenKind;
  variantOf?: (m: RegExpExecArray) => string | undefined;
}

const RULES: Rule[] = [
  // ISO-ish timestamps: 2026-05-17T14:23:01.234Z or 2026-05-17 14:23:01,234
  {
    re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\b/g,
    kind: "timestamp",
  },
  // Bare time-of-day: 14:23:01 or 14:23:01.234 (only when standalone)
  {
    re: /\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g,
    kind: "timestamp",
  },
  // Level keywords (word boundary, case-insensitive). Match popular variants.
  {
    re: /\b(DEBUG|TRACE|INFO|NOTE|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|FAIL(?:URE)?)\b/g,
    kind: "level",
    variantOf: (m) => {
      const raw = m[1]!.toLowerCase();
      if (raw.startsWith("warn")) return "warn";
      if (raw.startsWith("err") || raw === "fatal" || raw.startsWith("fail")) return "error";
      if (raw === "debug" || raw === "trace") return "debug";
      return "info";
    },
  },
  // Phase markers from runner.ts: [installing] starting…  [building] done
  {
    re: /\[[a-z][a-z_]+\](?:\s+(?:starting…|done))?/g,
    kind: "phase",
  },
  // Success markers — xcodebuild, gradle, generic
  {
    re: /(?:\*\*\s*(?:ARCHIVE|BUILD|EXPORT)\s+SUCCEEDED\s*\*\*|BUILD SUCCESSFUL(?:\s+in\s+\S+)?|✅[^\n]*|✓[^\n]*)/g,
    kind: "success",
  },
  // Failure markers
  {
    re: /(?:\*\*\s*(?:ARCHIVE|BUILD|EXPORT)\s+FAILED\s*\*\*|BUILD FAILED|FAILURE:[^\n]*|❌[^\n]*|✗[^\n]*|error:[^\n]*)/g,
    kind: "failure",
  },
  // Durations: "1m 14s", "12.4s", "234ms"
  {
    re: /\b(?:\d+m\s+\d+s|\d+(?:\.\d+)?\s?(?:ms|s|m|h))\b/g,
    kind: "duration",
  },
  // Sizes: "12.4 MB", "1.2GB", "456 KB"
  {
    re: /\b\d+(?:\.\d+)?\s?(?:B|KB|MB|GB|TB)\b/g,
    kind: "size",
  },
  // URLs
  {
    re: /https?:\/\/[^\s)>\]]+/g,
    kind: "url",
  },
  // Paths: POSIX (/a/b/c) or Windows (C:\a\b). Allow optional :line:col tail.
  // Kept last because it would otherwise swallow ranges that should color as
  // success/url/etc.
  {
    re: /(?:\/[\w.\-+@]+){2,}(?::\d+(?::\d+)?)?|[A-Za-z]:\\[\w.\\\-+@ ]+/g,
    kind: "path",
  },
];

function findHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      hits.push({
        kind: rule.kind,
        variant: rule.variantOf?.(m),
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  // Sort by start, then prefer earlier-declared rules on ties.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  // Drop overlaps: keep the first, skip anything that overlaps it.
  const kept: RuleHit[] = [];
  let cursor = -1;
  for (const h of hits) {
    if (h.start < cursor) continue;
    kept.push(h);
    cursor = h.end;
  }
  return kept;
}

function regexTokenize(text: string): Token[] {
  if (!text) return [];
  const hits = findHits(text);
  if (hits.length === 0) return [{ kind: "text", text }];
  const out: Token[] = [];
  let i = 0;
  for (const h of hits) {
    if (h.start > i) out.push({ kind: "text", text: text.slice(i, h.start) });
    out.push({ kind: h.kind, text: text.slice(h.start, h.end), variant: h.variant });
    i = h.end;
  }
  if (i < text.length) out.push({ kind: "text", text: text.slice(i) });
  return out;
}

// ── ANSI pass ───────────────────────────────────────────────────────────────

interface AnserChunk {
  content: string;
  fg?: string;
  bg?: string;
  decoration?: string;
  was_processed?: boolean;
}

function ansiToTokens(line: string): Token[] {
  const json = Anser.ansiToJson(line, { use_classes: false, remove_empty: true }) as AnserChunk[];
  const out: Token[] = [];
  for (const chunk of json) {
    if (!chunk.content) continue;
    const hasStyle = !!(chunk.fg || chunk.bg || chunk.decoration);
    if (!hasStyle) {
      // Uncolored text — feed through the regex pass.
      out.push(...regexTokenize(chunk.content));
    } else {
      const color = chunk.fg ? `rgb(${chunk.fg})` : undefined;
      const background = chunk.bg ? `rgb(${chunk.bg})` : undefined;
      const dec = chunk.decoration ?? "";
      out.push({
        kind: "ansi",
        text: chunk.content,
        style: {
          color,
          background,
          bold: dec.includes("bold"),
          italic: dec.includes("italic"),
          underline: dec.includes("underline"),
        },
      });
    }
  }
  return out;
}

// ── Public entry points ────────────────────────────────────────────────────

// The API stamps every persisted line with a full ISO timestamp
// ("2026-08-04T18:11:32.820Z "). Spending ~25 columns of every row on
// millisecond precision nobody reads pushes the actual message off-screen, so
// we render just the wall clock in a dim leading column.
const LEADING_ISO_TS = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:[.,]\d+)?Z ?/;

/**
 * Does this line actually report a problem? Checked against the text rather
 * than the stream it arrived on. Ordered so an explicit success statement wins:
 * altool's "UPLOAD SUCCEEDED with no errors, 1 warning" must not read as a
 * failure just because the word "errors" appears in it.
 */
function looksLikeError(text: string): boolean {
  if (/\b(succeed(?:ed|s)?|success(?:ful(?:ly)?)?)\b/i.test(text)) return false;
  if (/\bno errors?\b|\b0 errors?\b/i.test(text)) return false;
  return /\berror\b|\bfatal\b|\bfailed\b|\bfailure\b|\brejected\b|\bcannot\b|\bcould not\b|\bunable to\b|❌|✗|Code=-?\d+/i.test(
    text,
  );
}

function parseLine(raw: string, id: number): ParsedLine {
  let line = raw;

  // Order matters: the timestamp is applied by the API *outside* the stderr
  // marker, so a stderr line reads "<iso> ! text". Peeling the timestamp first
  // is what makes the `! ` check below reachable at all.
  let shortTs: string | null = null;
  const ts = LEADING_ISO_TS.exec(line);
  if (ts) {
    shortTs = ts[1]!;
    line = line.slice(ts[0].length);
  }

  let isStderr = false;
  // Stripped from ssh.ts flush(): `! <line>` for stderr lines.
  if (line.startsWith("! ")) {
    isStderr = true;
    line = line.slice(2);
  }
  // Detect phase header lines emitted by runner.ts (e.g. "[installing] starting…").
  const isPhaseHeader = /^\[[a-z][a-z_]+\]\s+(?:starting…|done)\s*$/.test(line);
  const isError = looksLikeError(line);

  const tokens: Token[] = [];
  if (shortTs) tokens.push({ kind: "timestamp", text: `[${shortTs}] `, variant: "gutter" });
  // The "!" prefix is kept only where it carries meaning. On a healthy build
  // most stderr traffic is routine progress, and flagging all of it trains the
  // reader to ignore the marker precisely when it matters.
  if (isStderr && isError) tokens.push({ kind: "stderr-marker", text: "! " });
  tokens.push(...ansiToTokens(line));
  return { id, tokens, isStderr, isPhaseHeader, isError };
}

export function parseDelta(
  full: string,
  state: ParseState,
): { lines: ParsedLine[]; state: ParseState } {
  // Snapshot replacement / shrink — reset.
  if (full.length < state.consumed || (state.consumed > 0 && !startsWithConsumed(full, state.consumed))) {
    state = freshState();
  }
  const fresh = full.slice(state.consumed);
  if (fresh.length === 0) return { lines: [], state };
  const combined = state.tail + fresh;
  const parts = combined.split("\n");
  const newTail = parts.pop() ?? "";
  const lines: ParsedLine[] = [];
  let nextId = state.nextId;
  for (const part of parts) {
    // Drop trailing \r from CRLF inputs.
    const cleaned = part.endsWith("\r") ? part.slice(0, -1) : part;
    lines.push(parseLine(cleaned, nextId++));
  }
  return {
    lines,
    state: {
      tail: newTail,
      nextId,
      consumed: full.length,
    },
  };
}

// Flush any unterminated tail as its own line. Used when the build ends but
// the final byte isn't a newline.
export function flushTail(state: ParseState): { lines: ParsedLine[]; state: ParseState } {
  if (!state.tail) return { lines: [], state };
  const cleaned = state.tail.endsWith("\r") ? state.tail.slice(0, -1) : state.tail;
  const line = parseLine(cleaned, state.nextId);
  return {
    lines: [line],
    state: { tail: "", nextId: state.nextId + 1, consumed: state.consumed },
  };
}

function startsWithConsumed(full: string, consumed: number): boolean {
  // Cheap prefix check — we don't keep the prior buffer, so this is approximate.
  // Compare a small window: if the slice up to `consumed` ends mid-character we
  // accept it; the worst case is a single duplicated line on snapshot churn.
  return full.length >= consumed;
}
