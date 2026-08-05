import type { MouseEvent } from "react";

/**
 * Helpers shared by list rows that support right-click menus (see
 * `components/RowActions`) and double-click-to-edit.
 */

// Double-click on any control belongs to that control, not to the row.
const INTERACTIVE_SELECTOR = "a[href], button, input, textarea, select, [role='menuitem']";

export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.(INTERACTIVE_SELECTOR);
}

/**
 * Spread onto a link inside a row so right-clicking it keeps the browser's own
 * menu ("Copy link address", "Open in new tab") instead of the row menu. The
 * row's context-menu trigger listens on the React tree, so stopping propagation
 * here is enough.
 */
export function allowNativeContextMenu(e: MouseEvent): void {
  e.stopPropagation();
}

/**
 * A double-click selects the word under the cursor before our handler runs;
 * drop it so the row doesn't leave stray highlighting behind the dialog.
 */
export function clearTextSelection(): void {
  window.getSelection()?.removeAllRanges();
}
