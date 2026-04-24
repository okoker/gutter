import { useEffect, useRef, useState } from "react";

interface SnippetNamePromptProps {
  open: boolean;
  onCancel: () => void;
  onSave: (filename: string) => void;
}

/**
 * Small modal replacement for window.prompt — Tauri's webview disables prompt.
 * Used by the editor's "Save Selection as Snippet" action to ask for a filename.
 */
export function SnippetNamePrompt({ open, onCancel, onSave }: SnippetNamePromptProps) {
  const [value, setValue] = useState("untitled.md");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue("untitled.md");
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    const v = value.trim();
    if (!v) return;
    onSave(v);
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[20vh] bg-black/40"
      onClick={onCancel}
    >
      <div
        className="w-[420px] bg-[var(--surface-primary)] border border-[var(--editor-border)] rounded-lg shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1">
          Save Selection as Snippet
        </div>
        <div className="text-[12px] text-[var(--text-muted)] mb-3">
          Enter a filename. Extension defaults to <code>.md</code> if omitted.
        </div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            } else if (e.key === "Enter") {
              e.preventDefault();
              handleSave();
            }
          }}
          className="w-full px-2 py-1.5 bg-[var(--surface-secondary)] border border-[var(--editor-border)] rounded text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onCancel}
            className="px-3 py-1 text-[13px] rounded text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1 text-[13px] rounded bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
