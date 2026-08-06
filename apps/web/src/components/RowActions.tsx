import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "@mobileflow/ui";

/**
 * One entry in a list row's action menu. The same array feeds the ⋮ button and
 * the right-click menu, so the two can't drift apart.
 */
export interface RowAction {
  label: string;
  onSelect?: () => void;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  /** Native tooltip — handy for explaining why an item is disabled. */
  title?: string;
}

/** The ⋮ button that lives in a row's trailing actions cell. */
export function RowActionsButton({
  actions,
  ariaLabel = "More actions",
}: {
  actions: RowAction[];
  ariaLabel?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton variant="menu" aria-label={ariaLabel} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((a) => (
          <DropdownMenuItem
            key={a.label}
            icon={a.icon}
            destructive={a.destructive}
            disabled={a.disabled}
            title={a.title}
            onSelect={a.onSelect}
          >
            {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Wraps a row so right-clicking anywhere on it opens the same actions, anchored
 * at the pointer. `children` must be a single element that forwards props and a
 * ref — the row container itself.
 */
export function RowContextMenu({
  actions,
  children,
}: {
  actions: RowAction[];
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((a) => (
          <ContextMenuItem
            key={a.label}
            icon={a.icon}
            destructive={a.destructive}
            disabled={a.disabled}
            title={a.title}
            onSelect={a.onSelect}
          >
            {a.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
