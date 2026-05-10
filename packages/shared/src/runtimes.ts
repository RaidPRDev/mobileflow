// Single source of truth for app runtimes. To add a new runtime:
//   1. Add an entry here (id + label)
//   2. Add UI metadata (icon + bg) in apps/web/src/runtimes.tsx
// The DB pgEnum, zod schema, web Runtime type, and web label map all derive from this.

export const RUNTIME_DEFS = {
  capacitor: { label: "Capacitor" },
  cordova: { label: "Cordova" },
  react_native: { label: "React Native" },
  tauri: { label: "Tauri" },
  ios_native: { label: "iOS Native" },
  android_native: { label: "Android Native" },
} as const;

export type Runtime = keyof typeof RUNTIME_DEFS;

export const RUNTIME_IDS = Object.keys(RUNTIME_DEFS) as [Runtime, ...Runtime[]];

export const RUNTIME_LABEL = Object.fromEntries(
  Object.entries(RUNTIME_DEFS).map(([id, def]) => [id, def.label]),
) as Record<Runtime, string>;
