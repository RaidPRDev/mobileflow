import * as React from "react";
import { cn } from "./lib/cn";

export const DEFAULT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
] as const;

export interface ImageDropProps {
  onFile: (file: File) => void;
  onReject?: (file: File) => void;
  acceptedTypes?: readonly string[];
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
  ariaLabel?: string;
}

export const ImageDrop = React.forwardRef<HTMLButtonElement, ImageDropProps>(
  (
    {
      onFile,
      onReject,
      acceptedTypes = DEFAULT_IMAGE_MIME_TYPES,
      disabled,
      className,
      children,
      ariaLabel,
    },
    ref,
  ) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const [isDragOver, setDragOver] = React.useState(false);

    const accept = acceptedTypes.join(",");

    const handleFile = (file: File | undefined) => {
      if (!file) return;
      if (!acceptedTypes.includes(file.type)) {
        onReject?.(file);
        return;
      }
      onFile(file);
    };

    return (
      <button
        ref={ref}
        type="button"
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn("imagedrop", isDragOver && "is-dragover", className)}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (disabled) return;
          handleFile(e.dataTransfer.files[0]);
        }}
      >
        {children}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          style={{ display: "none" }}
          onChange={(e) => {
            handleFile(e.target.files?.[0] ?? undefined);
            e.target.value = "";
          }}
        />
      </button>
    );
  },
);
ImageDrop.displayName = "ImageDrop";
