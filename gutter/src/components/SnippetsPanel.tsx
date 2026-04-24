import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useSnippetStore, type SnippetInfo } from "../stores/snippetStore";
import { useToastStore } from "../stores/toastStore";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { RenameInput } from "./FileTree/FileTree";
import { FilePlus, X } from "./Icons";

interface SnippetsPanelProps {
  onClose: () => void;
  onInsert: (content: string, isMarkdown: boolean) => void;
  onOpenAsTab: (absPath: string) => void;
}

export function SnippetsPanel({ onClose, onInsert, onOpenAsTab }: SnippetsPanelProps) {
  const {
    snippets,
    loaded,
    loadSnippets,
    readSnippetContent,
    saveNewSnippet,
    removeSnippet,
    renameSnippet,
  } = useSnippetStore();

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  // Defer single-click action so a trailing double-click can cancel it.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refresh on panel mount — picks up files added externally (e.g. via Finder)
  // without needing a dedicated refresh button.
  useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  // Live refresh when any file is saved: picks up preview changes for a
  // snippet tab the user is editing without requiring close+reopen.
  useEffect(() => {
    const handler = () => {
      void useSnippetStore.getState().refreshSnippets();
    };
    window.addEventListener("file-saved", handler);
    return () => window.removeEventListener("file-saved", handler);
  }, []);

  const insertFromSnippet = useCallback(
    async (s: SnippetInfo) => {
      try {
        const content = await readSnippetContent(s.path);
        const isMarkdown =
          s.filename.endsWith(".md") || s.filename.endsWith(".markdown");
        onInsert(content, isMarkdown);
      } catch (e) {
        useToastStore.getState().addToast(`Failed to read snippet: ${e}`, "error");
      }
    },
    [readSnippetContent, onInsert],
  );

  const copyToClipboard = useCallback(
    async (s: SnippetInfo) => {
      let content: string;
      try {
        content = await readSnippetContent(s.path);
      } catch (e) {
        useToastStore
          .getState()
          .addToast(`Failed to read snippet: ${e}`, "error");
        return;
      }
      // Try the modern API first. If it fails (e.g. Tauri webview focus/
      // permission edge cases), fall back to a hidden-textarea + execCommand.
      try {
        await navigator.clipboard.writeText(content);
        useToastStore.getState().addToast("Snippet copied", "success", 1500);
        return;
      } catch {
        // fall through to fallback
      }
      try {
        const ta = document.createElement("textarea");
        ta.value = content;
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) {
          useToastStore.getState().addToast("Snippet copied", "success", 1500);
        } else {
          useToastStore
            .getState()
            .addToast("Copy failed — clipboard not available", "error");
        }
      } catch (e) {
        useToastStore.getState().addToast(`Copy failed: ${e}`, "error");
      }
    },
    [readSnippetContent],
  );

  const handleCreate = useCallback(
    async (filename: string) => {
      const trimmed = filename.trim();
      if (!trimmed) {
        setCreatingNew(false);
        return;
      }
      const name = trimmed.includes(".") ? trimmed : `${trimmed}.md`;
      try {
        const path = await saveNewSnippet(name, "");
        onOpenAsTab(path);
      } catch (e) {
        useToastStore.getState().addToast(`Failed to create: ${e}`, "error");
      }
      setCreatingNew(false);
    },
    [saveNewSnippet, onOpenAsTab],
  );

  const handleRenameSubmit = useCallback(
    async (oldPath: string, newFilename: string) => {
      const trimmed = newFilename.trim();
      if (!trimmed) {
        setRenamingPath(null);
        return;
      }
      try {
        await renameSnippet(oldPath, trimmed);
        // Notify any open tab holding the old path so it updates.
        window.dispatchEvent(
          new CustomEvent("snippet-renamed", {
            detail: { oldPath, newFilename: trimmed },
          }),
        );
      } catch (e) {
        useToastStore.getState().addToast(`Rename failed: ${e}`, "error");
      }
      setRenamingPath(null);
    },
    [renameSnippet],
  );

  const handleRowContextMenu = useCallback(
    (s: SnippetInfo, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Insert at Cursor", action: () => insertFromSnippet(s) },
          { label: "Copy to Clipboard", action: () => copyToClipboard(s) },
          { label: "Open to Edit", action: () => onOpenAsTab(s.path) },
          { label: "", action: () => {}, separator: true },
          { label: "Rename", action: () => setRenamingPath(s.path) },
          {
            label: "Delete",
            action: async () => {
              const ok = await ask(`Delete "${s.filename}"?`, {
                title: "Confirm Delete",
                kind: "warning",
              });
              if (ok) await removeSnippet(s.path);
            },
          },
        ],
      });
    },
    [insertFromSnippet, copyToClipboard, onOpenAsTab, removeSnippet],
  );

  return (
    <div className="h-full flex flex-col bg-[var(--surface-secondary)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--editor-border)]">
        <span className="font-semibold text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          Snippets
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setCreatingNew(true)}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
            title="New snippet"
          >
            <FilePlus size={14} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {!loaded && (
          <div className="px-3 py-8 text-center text-[var(--text-muted)] text-[13px]">
            Loading…
          </div>
        )}
        {loaded && snippets.length === 0 && !creatingNew && (
          <div className="px-3 py-8 text-center text-[var(--text-muted)] text-[13px] leading-relaxed">
            No snippets yet.
            <br />
            Click <span className="inline-block align-middle"><FilePlus size={12} /></span> to create one, or select text
            in the editor and right-click → Save Selection as Snippet.
          </div>
        )}

        {creatingNew && (
          <div className="px-3 py-2 border-b border-[var(--editor-border)]">
            <RenameInput
              initialName="untitled.md"
              onSubmit={handleCreate}
              onCancel={() => setCreatingNew(false)}
            />
          </div>
        )}

        {snippets.map((s) => (
          <SnippetRow
            key={s.path}
            snippet={s}
            isRenaming={renamingPath === s.path}
            onClick={() => {
              if (renamingPath === s.path) return;
              if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
              clickTimerRef.current = setTimeout(() => {
                clickTimerRef.current = null;
                onOpenAsTab(s.path);
              }, 250);
            }}
            onDoubleClick={() => {
              if (renamingPath === s.path) return;
              if (clickTimerRef.current) {
                clearTimeout(clickTimerRef.current);
                clickTimerRef.current = null;
              }
              insertFromSnippet(s);
            }}
            onContextMenu={(e) => handleRowContextMenu(s, e)}
            onRenameSubmit={(name) => handleRenameSubmit(s.path, name)}
            onRenameCancel={() => setRenamingPath(null)}
          />
        ))}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function SnippetRow({
  snippet,
  isRenaming,
  onClick,
  onDoubleClick,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
}: {
  snippet: SnippetInfo;
  isRenaming: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
}) {
  return (
    <div
      className="px-3 py-2 border-b border-[var(--editor-border)] cursor-pointer select-none hover:bg-[var(--surface-hover)] transition-colors"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title="Click to edit, double-click to insert at cursor"
    >
      {isRenaming ? (
        <RenameInput
          initialName={snippet.filename}
          onSubmit={onRenameSubmit}
          onCancel={onRenameCancel}
        />
      ) : (
        <>
          <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">
            {snippet.filename}
          </div>
          {snippet.preview && (
            <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
              {snippet.preview}
            </div>
          )}
        </>
      )}
    </div>
  );
}
