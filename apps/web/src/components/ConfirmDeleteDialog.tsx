import type { ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mobileflow/ui";
import { ApiError } from "../api/client";

interface ConfirmDeleteDialogProps {
  /** e.g. "Delete environment" — also used as the dialog title. */
  title: string;
  /** The thing being deleted; rendered in bold inside the question. */
  itemName: string;
  /**
   * Optional short headline shown above the bullet list (defaults to a
   * "Cannot be undone" line). Pass `null` to suppress.
   */
  warning?: ReactNode;
  /** Bullet points describing the destruction. Empty/undefined skips the list. */
  details?: ReactNode[];
  /** Label for the destructive button. Defaults to "Delete". */
  confirmLabel?: string;
  /** Error from the underlying mutation, if any. ApiError messages render as-is. */
  error?: unknown;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Generic destructive-action confirmation modal. Blocks dismiss-via-outside-
 * click while the mutation is in flight (a half-fired delete with the dialog
 * closed leaves the UI ambiguous about what happened).
 */
export function ConfirmDeleteDialog({
  title,
  itemName,
  warning,
  details,
  confirmLabel = "Delete",
  error,
  pending,
  onCancel,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const errorMessage =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : null;
  const headline = warning === undefined ? "This cannot be undone." : warning;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !pending) onCancel();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p>
            Delete <strong>{itemName}</strong>? {headline}
          </p>
          {details && details.length > 0 && (
            <ul className="delete-app-list with-bullets">
              {details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {errorMessage && <p className="text-error">{errorMessage}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
