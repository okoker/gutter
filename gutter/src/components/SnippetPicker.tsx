import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSnippetStore, type SnippetInfo } from "../stores/snippetStore";
import { useToastStore } from "../stores/toastStore";

interface SnippetPickerProps {
  open: boolean;
  onClose: () => void;
  onInsert: (content: string, isMarkdown: boolean) => void;
}

function fuzzyMatch(query: string, haystack: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const h = haystack.toLowerCase();
  let qi = 0;
  for (let i = 0; i < h.length && qi < q.length; i++) {
    if (h[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function SnippetPicker({ open, onClose, onInsert }: SnippetPickerProps) {
  const { snippets, refreshSnippets, readSnippetContent } = useSnippetStore();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Refresh + focus on open
  useEffect(() => {
    if (!open) return;
    refreshSnippets();
    setQuery("");
    setSelected(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, refreshSnippets]);

  const filtered = useMemo(() => {
    const haystack = (s: SnippetInfo) => `${s.filename} ${s.preview}`;
    return snippets.filter((s) => fuzzyMatch(query, haystack(s)));
  }, [snippets, query]);

  // Clamp selection when list shrinks
  useEffect(() => {
    if (selected >= filtered.length) setSelected(Math.max(0, filtered.length - 1));
  }, [filtered.length, selected]);

  // Scroll selected row into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-snippet-idx="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const doInsert = useCallback(
    async (s: SnippetInfo) => {
      try {
        const content = await readSnippetContent(s.path);
        const isMarkdown =
          s.filename.endsWith(".md") || s.filename.endsWith(".markdown");
        onInsert(content, isMarkdown);
        onClose();
      } catch (e) {
        useToastStore.getState().addToast(`Failed to read snippet: ${e}`, "error");
      }
    },
    [readSnippetContent, onInsert, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const s = filtered[selected];
        if (s) doInsert(s);
      }
    },
    [filtered, selected, doInsert, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[10vh] bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[500px] max-h-[70vh] flex flex-col bg-[var(--surface-primary)] border border-[var(--editor-border)] rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-[var(--editor-border)]">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search snippets..."
            className="w-full bg-transparent outline-none text-[14px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
        </div>
        <div ref={listRef} className="flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[var(--text-muted)] text-[13px]">
              {snippets.length === 0
                ? "No snippets yet. Create some from the Snippets panel."
                : "No matching snippets."}
            </div>
          ) : (
            filtered.map((s, i) => (
              <div
                key={s.path}
                data-snippet-idx={i}
                className={`px-3 py-2 cursor-pointer border-b border-[var(--editor-border)] ${
                  i === selected
                    ? "bg-[var(--selection-bg)]"
                    : "hover:bg-[var(--surface-hover)]"
                }`}
                onClick={() => doInsert(s)}
                onMouseEnter={() => setSelected(i)}
              >
                <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                  {s.filename}
                </div>
                {s.preview && (
                  <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                    {s.preview}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
        <div className="px-3 py-1.5 border-t border-[var(--editor-border)] text-[11px] text-[var(--text-muted)] flex justify-between">
          <span>↑↓ navigate</span>
          <span>Enter to insert · Esc to close</span>
        </div>
      </div>
    </div>
  );
}
