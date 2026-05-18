// Codepoints that should never appear in short user-typed label fields
// (org name, app name, env name, cert label, etc.). Three categories:
//
// 1. C0 controls + DEL (U+0000..U+001F, U+007F): NUL/BEL/BS etc. — these
//    corrupt CLI/log output when echoed in a build log and have no business
//    inside a display label. We strip ALL of them, including \r \n \t, since
//    a single-line label shouldn't carry newlines either.
//
// 2. C1 controls (U+0080..U+009F): rarely seen but reserved; same reasoning.
//
// 3. Unicode bidi-override codepoints (LRO/RLO/LRE/RLE/PDF/LRI/RLI/FSI/PDI):
//    these flip text direction in the renderer and let an attacker disguise
//    a string like "admin<RLO>/etcpasswd" so it visually reads as something
//    else. The "trojan source" class of attacks. Strip them entirely — no
//    legitimate label has them.
//
// We deliberately preserve ZWJ/ZWNJ/ZWSP (U+200C, U+200D, U+200B) because
// they carry semantic meaning in Arabic / Hindi / Indic scripts. Stripping
// those would silently corrupt names in those languages.
const BAD_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Strip control characters and bidi-override codepoints from a label-style
 * string. Intended to be chained inside a zod schema after `.trim()`. Apply
 * to short display fields only — do NOT apply to multi-line content like
 * env-var values or PEM-encoded private keys, where newlines are meaningful.
 */
export function sanitizeLabel(input: string): string {
  return input.replace(BAD_CHARS_RE, "");
}
