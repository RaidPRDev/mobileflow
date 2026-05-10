import * as React from "react";
import { Paperclip } from "lucide-react";
import { cn } from "./lib/cn";

export interface FileDropProps extends Omit<React.HTMLAttributes<HTMLLabelElement>, "onChange"> {
  accept?: string;
  multiple?: boolean;
  value?: File | File[] | null;
  onChange: (files: File[]) => void;
  hint?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
}

export const FileDrop = React.forwardRef<HTMLInputElement, FileDropProps>(
  (
    {
      accept,
      multiple,
      value,
      onChange,
      hint,
      disabled,
      id,
      name,
      className,
      ...props
    },
    ref,
  ) => {
    const [isDragOver, setDragOver] = React.useState(false);
    const files = Array.isArray(value) ? value : value ? [value] : [];

    const handleFiles = (list: FileList | null) => {
      if (!list || list.length === 0) return;
      onChange(Array.from(list));
    };

    return (
      <label
        className={cn(
          "filedrop",
          isDragOver && "is-dragover",
          files.length > 0 && "has-file",
          className,
        )}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (disabled) return;
          handleFiles(e.dataTransfer.files);
        }}
        {...props}
      >
        <input
          ref={ref}
          id={id}
          name={name}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          className="filedrop-input"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {files.length > 0 ? (
          <span className="filedrop-filename">
            <Paperclip size={14} />
            {files.length === 1
              ? files[0]!.name
              : `${files.length} files selected`}
          </span>
        ) : (
          <span className="filedrop-text">
            {hint ?? (
              <>
                Drop file here or <span className="filedrop-link">browse</span>
              </>
            )}
          </span>
        )}
      </label>
    );
  },
);
FileDrop.displayName = "FileDrop";
