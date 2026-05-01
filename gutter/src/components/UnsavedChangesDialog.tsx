import { useEffect } from "react";
import { useUnsavedChangesStore } from "../stores/unsavedChangesStore";

/**
 * 3-button "unsaved changes" modal. Mounted once at app root; shown on
 * demand by `useUnsavedChangesStore.confirm()`. Replaces the binary
 * Tauri `ask()` dialog so close paths can offer Save / Discard / Cancel.
 */
export function UnsavedChangesDialog() {
  const open = useUnsavedChangesStore((s) => s.open);
  const message = useUnsavedChangesStore((s) => s.message);
  const respond = useUnsavedChangesStore((s) => s.respond);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        respond("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        respond("save");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, respond]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-start justify-center pt-[20vh] bg-black/40"
      onClick={() => respond("cancel")}
    >
      <div
        className="w-[440px] bg-[var(--surface-primary)] border border-[var(--editor-border)] rounded-lg shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1">
          Unsaved Changes
        </div>
        <div className="text-[13px] text-[var(--text-secondary)] mb-4 whitespace-pre-line">
          {message}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => respond("discard")}
            className="px-3 py-1 text-[13px] rounded text-[var(--text-secondary)] border border-[var(--editor-border)] hover:bg-[var(--surface-hover)] transition-colors"
          >
            Discard
          </button>
          <button
            onClick={() => respond("cancel")}
            className="px-3 py-1 text-[13px] rounded text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => respond("save")}
            className="px-3 py-1 text-[13px] rounded bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
            autoFocus
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
