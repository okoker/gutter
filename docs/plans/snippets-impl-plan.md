# Snippet Library (Feature #4) — Implementation Plan

**Design doc:** `docs/plans/snippets-design.md`
**Branch:** `feature/snippets`
**Base:** `main` at whichever commit is tip post-Feature-#3
**Scope:** MVP per design. Cross-root / tags / variables / import-export deferred.
**Commits:** 7, granular for bisect.

## Phase 0 — Pre-flight (~1 min, no commit)

```bash
git status                                    # expect: docs/backlog.md + __user_private/
(cd gutter && npm ci --dry-run)               # lockfile in sync
(cd gutter && npx tsc --noEmit)               # clean
(cd gutter && npm test -- --run)              # 49/49
(cd gutter/src-tauri && cargo check)          # clean
git checkout -b feature/snippets
```

## Commit 1 — `feat(snippets): backend commands + storage`

### Files
- `gutter/src-tauri/src/commands/snippets.rs` — NEW (~180 lines)
- `gutter/src-tauri/src/commands/mod.rs` — `pub mod snippets;`
- `gutter/src-tauri/src/lib.rs` — register 6 commands in `invoke_handler!`

### `snippets.rs` structure

```rust
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::Serialize;

const MAX_SNIPPET_BYTES: u64 = 1_048_576;   // 1 MB
const PROBE_BYTES: usize = 4096;

#[derive(Serialize)]
pub struct SnippetInfo {
    pub filename: String,       // full filename with extension
    pub path: String,           // absolute path
    pub preview: String,        // first non-empty line, truncated ~120 chars
    pub modified_ms: u128,      // for recency sort
}

fn snippets_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    Ok(home.join(".gutter").join("snippets"))
}

fn validate_filename(name: &str) -> Result<(), String> {
    if name.is_empty() { return Err("Filename cannot be empty".into()); }
    if name.starts_with('.') { return Err("Filename cannot start with '.'".into()); }
    if name.contains('/') || name.contains('\\') { return Err("Filename cannot contain path separators".into()); }
    if name.contains("..") { return Err("Filename cannot contain '..'".into()); }
    if name.len() > 255 { return Err("Filename too long".into()); }
    Ok(())
}

fn validate_inside_snippets(path: &Path) -> Result<(), String> {
    let dir = snippets_dir()?;
    let canon = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let dir_canon = fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    if !canon.starts_with(&dir_canon) {
        return Err("Path is outside snippets directory".into());
    }
    Ok(())
}

fn is_likely_text(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(PROBE_BYTES)];
    !probe.contains(&0u8)
}

fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

fn extract_preview(s: &str) -> String {
    let stripped = strip_bom(s);
    let first_line = stripped.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let truncated: String = first_line.chars().take(120).collect();
    if first_line.chars().count() > 120 { format!("{}…", truncated) } else { truncated }
}

#[tauri::command]
pub fn ensure_snippets_dir() -> Result<String, String> {
    let dir = snippets_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_snippets() -> Result<Vec<SnippetInfo>, String> {
    let dir = snippets_dir()?;
    if !dir.exists() { return Ok(vec![]); }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }

        // Follow symlinks for size + is_file
        let meta = match fs::metadata(&path) { Ok(m) => m, Err(_) => continue };
        if !meta.is_file() { continue; }
        if meta.len() > MAX_SNIPPET_BYTES { continue; }

        let bytes = match fs::read(&path) { Ok(b) => b, Err(_) => continue };
        if !is_likely_text(&bytes) { continue; }

        let content = String::from_utf8_lossy(&bytes);
        let preview = extract_preview(&content);
        let modified_ms = meta.modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);

        out.push(SnippetInfo {
            filename: name,
            path: path.to_string_lossy().to_string(),
            preview,
            modified_ms,
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

#[tauri::command]
pub fn read_snippet(path: String) -> Result<String, String> {
    // Ensure dir exists so canonicalize doesn't fail on first-use ENOENT.
    fs::create_dir_all(snippets_dir()?).map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    validate_inside_snippets(&p)?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(strip_bom(&String::from_utf8_lossy(&bytes)).to_string())
}

#[tauri::command]
pub fn save_snippet(filename: String, content: String) -> Result<String, String> {
    validate_filename(&filename)?;
    let dir = snippets_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_snippet(path: String) -> Result<(), String> {
    fs::create_dir_all(snippets_dir()?).map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    validate_inside_snippets(&p)?;
    fs::remove_file(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_snippet(old_path: String, new_filename: String) -> Result<String, String> {
    validate_filename(&new_filename)?;
    fs::create_dir_all(snippets_dir()?).map_err(|e| e.to_string())?;
    let old = PathBuf::from(&old_path);
    validate_inside_snippets(&old)?;
    let dir = snippets_dir()?;
    let new_path = dir.join(&new_filename);
    fs::rename(&old, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_path_traversal() {
        assert!(validate_filename("../evil").is_err());
        assert!(validate_filename("a/b").is_err());
        assert!(validate_filename("a\\b").is_err());
        assert!(validate_filename(".hidden").is_err());
        assert!(validate_filename("").is_err());
        assert!(validate_filename("ok.md").is_ok());
    }
}
```

### `mod.rs` — add `pub mod snippets;`

### `lib.rs` — register 6 commands in `invoke_handler!`

### Verification
- `cargo check` clean
- `npx tsc --noEmit` clean (TS untouched)
- `npm test` 49/49

### Commit message
```
feat(snippets): backend storage commands

Six Tauri commands for snippet CRUD at ~/.gutter/snippets/:
- ensure_snippets_dir, list_snippets, read_snippet
- save_snippet, delete_snippet, rename_snippet

list_snippets returns preview-only SnippetInfo (filename, path, first
non-empty line truncated to 120 chars, modified_ms) sorted by recency.
Text-file heuristic: size <= 1MB, is_file after symlink-follow, no null
byte in first 4KB, UTF-8 lossy decode tolerates BOM.

Filename and path validation: rejects path separators, '..', leading
dots; verifies resolved path stays inside snippets directory.
```

## Commit 2 — `feat(snippets): frontend store + tests`

### Files
- `gutter/src/stores/snippetStore.ts` — NEW (~80 lines)
- `gutter/tests/snippetStore.test.ts` — NEW (~5 tests)

### `snippetStore.ts` structure

```ts
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface SnippetInfo {
  filename: string;
  path: string;
  preview: string;
  modifiedMs: number;
}

interface SnippetState {
  snippets: SnippetInfo[];
  loaded: boolean;
  loadSnippets(): Promise<void>;       // also calls ensure_snippets_dir first time
  refreshSnippets(): Promise<void>;    // re-invokes list_snippets
  readSnippetContent(path: string): Promise<string>;
  saveNewSnippet(filename: string, content: string): Promise<string>;   // returns absolute path
  removeSnippet(path: string): Promise<void>;
  renameSnippet(oldPath: string, newFilename: string): Promise<string>; // returns new path
}

export const useSnippetStore = create<SnippetState>((set, get) => ({
  snippets: [],
  loaded: false,

  loadSnippets: async () => {
    try {
      await invoke<string>("ensure_snippets_dir");
      const raw = await invoke<Array<{filename: string; path: string; preview: string; modified_ms: number}>>("list_snippets");
      set({ snippets: raw.map(r => ({ ...r, modifiedMs: r.modified_ms })), loaded: true });
    } catch (e) {
      console.error("loadSnippets failed:", e);
      set({ snippets: [], loaded: true });
    }
  },

  refreshSnippets: async () => {
    const raw = await invoke<Array<{filename: string; path: string; preview: string; modified_ms: number}>>("list_snippets");
    set({ snippets: raw.map(r => ({ ...r, modifiedMs: r.modified_ms })) });
  },

  readSnippetContent: (path) => invoke<string>("read_snippet", { path }),

  saveNewSnippet: async (filename, content) => {
    const absPath = await invoke<string>("save_snippet", { filename, content });
    await get().refreshSnippets();
    return absPath;
  },

  removeSnippet: async (path) => {
    await invoke("delete_snippet", { path });
    await get().refreshSnippets();
  },

  renameSnippet: async (oldPath, newFilename) => {
    const newPath = await invoke<string>("rename_snippet", { oldPath, newFilename });
    await get().refreshSnippets();
    return newPath;
  },
}));
```

### Tests (mock `invoke`)
- `loadSnippets` populates `snippets` and sets `loaded = true`
- `refreshSnippets` replaces list
- `saveNewSnippet` calls invoke + refresh, returns path
- `removeSnippet` calls invoke + refresh
- `renameSnippet` calls invoke + refresh, returns new path

### Verification: tsc + tests

### Commit message
```
feat(snippets): frontend Zustand store

snippetStore exposes loadSnippets, refreshSnippets, readSnippetContent,
saveNewSnippet, removeSnippet, renameSnippet. Actions delegate to the
Rust commands from commit 1 and refresh the in-memory list after
mutations. 5 new unit tests covering store behavior with mocked invoke.
```

## Commit 3 — `feat(state): snippets panel visibility + mutual exclusion`

### Files
- `gutter/src/stores/editorStore.ts` — add `showSnippets` + `toggleSnippets`; update `toggleComments`, `toggleHistory`, `toggleTags` to zero `showSnippets`
- `gutter/src/stores/settingsStore.ts` — add `snippets: 288` to `panelWidths` type + default

### Changes

**editorStore.ts**: the existing toggle-comments/history/tags block uses a **conditional** mutual-exclusion pattern — it only zeroes the others when the panel is being OPENED, not when it's being closed. Closing panel A does not close panel B. The new `toggleSnippets` must mirror this exact pattern, not use unconditional zeroes:

```ts
toggleSnippets: () => set((s) => ({
  showSnippets: !s.showSnippets,
  showComments: !s.showSnippets ? false : s.showComments,
  showHistory:  !s.showSnippets ? false : s.showHistory,
  showTags:     !s.showSnippets ? false : s.showTags,
})),
// And in each of the three existing toggles, add:
//   showSnippets: !s.showX ? false : s.showSnippets
```

**settingsStore.ts**:
```ts
panelWidths: { fileTree: number; comments: number; history: number; tags: number; snippets: number };
// default:
panelWidths: { fileTree: 224, comments: 288, history: 288, tags: 288, snippets: 288 },
```

Also update the `setPanelWidth` panel type to include `"snippets"`.

### Verification: tsc + 49 tests

### Commit message
```
feat(state): snippets panel visibility + mutual exclusion

Adds showSnippets flag and toggleSnippets action to editorStore with
mutual exclusion against comments/history/tags (only one right panel
visible at a time). Adds snippets: 288 to settingsStore.panelWidths so
the panel is resizable and persists width across sessions.
```

## Commit 4 — `feat(sidebar): Snippets panel`

### Files
- `gutter/src/components/SnippetsPanel.tsx` — NEW (~180 lines)
- `gutter/src/App.tsx` — conditional mount + resize handle (mirrors Comments/History/Tags sections)

### Prerequisite edit: export `RenameInput` from FileTree.tsx

`RenameInput` lives at `FileTree.tsx` line ~1016 as a module-scope function, not exported. Add the `export` keyword (one-word change) so `SnippetsPanel` can import it. Use `RenameInput` both for renaming rows AND for the new-snippet create flow (with `initialName="untitled.md"`).

### `SnippetsPanel.tsx` structure

```tsx
interface SnippetsPanelProps {
  onClose: () => void;
  onInsert: (content: string, isMarkdown: boolean) => void;   // parent wires to active editor
  onOpenAsTab: (absPath: string) => void;                     // parent wires to tab system
}

export function SnippetsPanel({ onClose, onInsert, onOpenAsTab }: SnippetsPanelProps) {
  const { snippets, loaded, loadSnippets, refreshSnippets, readSnippetContent,
          saveNewSnippet, removeSnippet, renameSnippet } = useSnippetStore();
  const [contextMenu, setContextMenu] = useState<...>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);

  // Refresh on panel mount (architect: covers "added via Finder" case)
  useEffect(() => { loadSnippets(); }, [loadSnippets]);

  const handleRowClick = (s: SnippetInfo) => onOpenAsTab(s.path);

  const handleRowDoubleClick = async (s: SnippetInfo) => {
    const content = await readSnippetContent(s.path);
    const isMarkdown = s.filename.endsWith(".md") || s.filename.endsWith(".markdown");
    onInsert(content, isMarkdown);
  };

  const handleCopy = async (s: SnippetInfo) => {
    const content = await readSnippetContent(s.path);
    await navigator.clipboard.writeText(content);
    useToastStore.getState().addToast("Snippet copied", "success", 1500);
  };

  const handleContextMenu = (s: SnippetInfo, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: "Insert at Cursor", action: () => handleRowDoubleClick(s) },
        { label: "Copy to Clipboard", action: () => handleCopy(s) },
        { label: "Open to Edit", action: () => handleRowClick(s) },
        { label: "", action: () => {}, separator: true },
        { label: "Rename", action: () => setRenamingPath(s.path) },
        { label: "Delete", action: async () => {
            const ok = await ask(`Delete "${s.filename}"?`, { title: "Confirm Delete", kind: "warning" });
            if (ok) await removeSnippet(s.path);
        }},
      ],
    });
  };

  const handleCreate = async (filename: string) => {
    if (!filename.trim()) { setCreatingNew(false); return; }
    const name = filename.includes(".") ? filename : `${filename}.md`;
    try {
      const path = await saveNewSnippet(name, "");
      onOpenAsTab(path);
      setCreatingNew(false);
    } catch (e) {
      useToastStore.getState().addToast(`Failed to create: ${e}`, "error");
    }
  };

  const handleRenameSubmit = async (oldPath: string, newFilename: string) => {
    try {
      await renameSnippet(oldPath, newFilename);
    } catch (e) {
      useToastStore.getState().addToast(`Rename failed: ${e}`, "error");
    }
    setRenamingPath(null);
    // Dispatch event so any tab with the old path updates (commit 7)
    window.dispatchEvent(new CustomEvent("snippet-renamed", { detail: { oldPath, newFilename } }));
  };

  return (
    <div className="h-full flex flex-col bg-[var(--surface-secondary)]">
      {/* Header: title + [+ new] + [x close] */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--editor-border)]">
        <span className="font-semibold text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Snippets</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => setCreatingNew(true)} title="New snippet"><FilePlus size={14} /></button>
          <button onClick={onClose} title="Close"><X size={14} /></button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-8 text-center text-[var(--text-muted)] text-[13px]">Loading…</div>}
        {loaded && snippets.length === 0 && !creatingNew && (
          <div className="px-3 py-8 text-center text-[var(--text-muted)] text-[13px]">
            No snippets yet.<br/>Select text in the editor and right-click → Save Selection as Snippet.
          </div>
        )}
        {creatingNew && (
          <RenameInput initialName="untitled.md" onSubmit={handleCreate} onCancel={() => setCreatingNew(false)} />
        )}
        {snippets.map(s => (
          <SnippetRow
            key={s.path}
            snippet={s}
            isRenaming={renamingPath === s.path}
            onClick={() => handleRowClick(s)}
            onDoubleClick={() => handleRowDoubleClick(s)}
            onContextMenu={(e) => handleContextMenu(s, e)}
            onRenameSubmit={(name) => handleRenameSubmit(s.path, name)}
            onRenameCancel={() => setRenamingPath(null)}
          />
        ))}
      </div>

      {contextMenu && <ContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />}
    </div>
  );
}

function SnippetRow(...) { /* filename bold + preview muted, single- and dbl-click handlers */ }
```

### `App.tsx` — conditional mount

Add to the sidebar switch alongside Comments/History/Tags (same resizer pattern, same `panelWidths.snippets`):

```tsx
{showSnippets && !isReadingMode && (
  <>
    <div style={{ width: panelWidths.snippets }} className="border-l ...">
      <SnippetsPanel
        onClose={() => useEditorStore.getState().toggleSnippets()}
        onInsert={(content, isMarkdown) => handleSnippetInsert(content, isMarkdown)}
        onOpenAsTab={(path) => handleFileTreeOpen(path)}
      />
    </div>
    <ResizeHandle ... onResize={(w) => setPanelWidth("snippets", w)} />
  </>
)}
```

`handleSnippetInsert` helper: parses markdown if `isMarkdown`, inserts via TipTap. Architect's exact approach — see commit 6 for the editor-side insert logic; here the panel just bubbles up content+flag.

### Verification
- tsc + tests
- Visual: manually open the panel (via keyboard shortcut once commit 5 lands — for now, toggle via `useEditorStore.getState().toggleSnippets()` in devtools)

### Commit message
```
feat(sidebar): Snippets panel

New right-sidebar panel listing files in ~/.gutter/snippets/.
- Row shows filename + first-line preview (muted).
- Single-click opens snippet as a regular editor tab.
- Double-click inserts content at cursor (parent wires the handler).
- Right-click context menu: Insert / Copy / Open / Rename / Delete.
- "+" button creates new empty snippet (extension defaults to .md).
- Refresh on panel mount picks up files added via Finder.
- Rename dispatches "snippet-renamed" CustomEvent for tab-path updates
  (handler lands in commit 7).
```

## Commit 5 — `feat(menu): snippets panel toggle`

### Files
- `gutter/src-tauri/src/menu.rs` — add "Toggle Snippets Panel" item in View menu + `menu:toggle-snippets` emit
- `gutter/src/hooks/useMenuBarListeners.ts` — listen for `menu:toggle-snippets`, call `useEditorStore.getState().toggleSnippets()`
- `gutter/src/hooks/useCommands.ts` — add "Toggle Snippets Panel" to command palette
- `gutter/src/hooks/useKeyboardShortcuts.ts` — bind `Cmd+Shift+L` to toggleSnippets
- Native menu item spec: "Toggle Snippets Panel" with shortcut `CmdOrCtrl+Shift+L`

### Commit message
```
feat(menu): snippets panel toggle

View menu entry, command palette entry, and Cmd+Shift+L keyboard
shortcut all toggle the snippets panel with mutual exclusion against
the other right panels.
```

## Commit 6 — `feat(editor): right-click Save Selection + Insert Snippet picker`

### Files
- `gutter/src/components/Editor/GutterEditor.tsx` — extend `handleContextMenu` with 2 snippet items
- `gutter/src/components/SnippetPicker.tsx` — NEW (~130 lines), mirrors wiki-link picker
- `gutter/src/App.tsx` — mount `<SnippetPicker>` with visibility state; handle `snippet-insert-request` event from editor

### Editor context-menu additions

```tsx
// Inside handleContextMenu in GutterEditor.tsx, after existing items:

const { from, to, empty } = editor.state.selection;
const hasSelection = !empty && from !== to;

// Check for atom nodes in selection (Mermaid, math, etc.)
const hasAtomInSelection = (() => {
  if (!hasSelection) return false;
  let found = false;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.isAtom) { found = true; return false; }
    return true;
  });
  return found;
})();

if (hasSelection && !hasAtomInSelection) {
  items.push({
    label: "Save Selection as Snippet",
    action: async () => {
      const text = editor.state.doc.textBetween(from, to, "\n\n");
      const name = await prompt(...);   // in-app prompt or inline input
      if (!name) return;
      const filename = name.includes(".") ? name : `${name}.md`;
      try {
        await useSnippetStore.getState().saveNewSnippet(filename, text);
        useToastStore.getState().addToast("Snippet saved", "success", 1500);
      } catch (e) {
        useToastStore.getState().addToast(`Save failed: ${e}`, "error");
      }
    },
  });
}
if (hasSelection && hasAtomInSelection) {
  items.push({
    label: "Save Selection as Snippet (contains diagram — switch to source mode first)",
    action: () => useToastStore.getState().addToast("Cannot save atom nodes. Switch to source mode to save as text.", "info"),
    disabled: true,
  });
}

items.push({
  label: "Insert Snippet...",
  action: () => window.dispatchEvent(new CustomEvent("open-snippet-picker")),
});
```

Note: `prompt()` for filename — check if codebase has an inline-input pattern or use a simple controlled modal. Likely reuse the `RenameInput` pattern from FileTree/SnippetsPanel.

### `SnippetPicker.tsx` structure

**Correction from earlier draft:** model on `UnifiedSearch.tsx` / `TemplatePicker.tsx` (standalone React modal with controlled visibility + search input + keyboard navigation), NOT `WikiLinkAutocomplete.ts` (that's a vanilla-DOM singleton inside a ProseMirror plugin — fundamentally different pattern). Expect ~150-200 lines.

Displays fuzzy-matched snippets, arrow-key navigation, Enter inserts:

```tsx
export function SnippetPicker({ open, onClose, onInsert }) {
  const { snippets, refreshSnippets, readSnippetContent } = useSnippetStore();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  useEffect(() => { if (open) refreshSnippets(); }, [open]);

  const filtered = useMemo(() =>
    fuzzyFilter(snippets, query, (s) => `${s.filename} ${s.preview}`),
    [snippets, query],
  );

  const handleInsert = async (s) => {
    const content = await readSnippetContent(s.path);
    const isMarkdown = s.filename.endsWith(".md") || s.filename.endsWith(".markdown");
    onInsert(content, isMarkdown);
    onClose();
  };

  // Escape / arrow keys / Enter / click handling
  // Modal styled like UnifiedSearch
  // ...
}
```

### `App.tsx` — wire up

- Mount `<SnippetPicker>` at app root, controlled by new local state `showSnippetPicker`
- Listen for `window.addEventListener("open-snippet-picker", ...)` → setShowSnippetPicker(true)
- Picker's `onInsert` calls the shared `handleSnippetInsert(content, isMarkdown)` helper that both SnippetsPanel and SnippetPicker use

### `handleSnippetInsert` — the TipTap insertion logic (shared)

```ts
function insertSnippetIntoActiveEditor(content: string, isMarkdown: boolean) {
  // editorInstanceRef.current is { createComment, navigateComment, getMarkdown, getEditor }
  const editor = editorInstanceRef.current?.getEditor();
  if (!editor) {
    // Fallback: clipboard copy
    navigator.clipboard.writeText(content);
    useToastStore.getState().addToast("No active editor — copied to clipboard", "info");
    return;
  }
  if (isMarkdown) {
    const parsed = parseMarkdown(content, "");   // reuse existing parser
    const insertPos = editor.state.selection.$to.after();
    editor.chain().focus().insertContentAt(insertPos, parsed).run();
  } else {
    editor.chain().focus().insertContent({ type: "text", text: content }).run();
  }
}
```

### Commit message
```
feat(editor): right-click Save Selection + Insert Snippet picker

Editor context menu gains two entries:
- "Save Selection as Snippet" (when a non-empty selection exists and
  contains no atom nodes) captures the selection via textBetween with
  block separator, prompts for a filename, writes to snippets dir.
  If an atom node (Mermaid, math) is in the selection, menu entry is
  disabled with an explanatory toast.
- "Insert Snippet..." opens SnippetPicker, a fuzzy searchable modal
  mirroring the wiki-link picker. Arrow keys navigate, Enter inserts.

Insertion respects file type: .md/.markdown parsed as markdown then
inserted at $to.after() (after current block to avoid invalid schema);
non-markdown inserted as plain text node, no parsing.
```

## Commit 7 — `chore: handle snippet rename tab-path update`

### Files
- `gutter/src/hooks/useTabLifecycle.ts` OR a new thin hook — listen for `snippet-renamed` CustomEvent and call `workspaceStore.updateTabPath(oldPath, newPath, newFilename)` if that path is an open tab

### Change

```ts
import { parentDir, joinPath } from "../utils/path";

useEffect(() => {
  const handler = (e: Event) => {
    const { oldPath, newFilename } = (e as CustomEvent).detail;
    const { openTabs } = useWorkspaceStore.getState();
    const tab = openTabs.find(t => t.path === oldPath);
    if (!tab) return;
    // Cross-platform path rewrite — avoids POSIX-regex bug on Windows paths.
    const newPath = joinPath(parentDir(oldPath) ?? "", newFilename);
    useWorkspaceStore.getState().updateTabPath(oldPath, newPath, newFilename);
    if (useEditorStore.getState().filePath === oldPath) {
      useEditorStore.getState().setFilePath(newPath);
    }
  };
  window.addEventListener("snippet-renamed", handler);
  return () => window.removeEventListener("snippet-renamed", handler);
}, []);
```

### Verification
- Open a snippet as tab
- Rename from panel
- Tab label updates, Cmd+S saves to new path

### Commit message
```
chore: update open tab path when snippet renamed

When the user renames a snippet from the panel, any tab that had the
old path open is updated to the new path so subsequent saves land on
the right file. Driven by the "snippet-renamed" CustomEvent dispatched
from the panel.
```

## Phase N — User verification (10 steps, ~4 min)

1. Launch dev.
2. **Cmd+Shift+L** → snippets panel opens, shows empty state message.
3. Click **+** → type `test.md` → hits Enter → panel shows one snippet, a new tab opens empty.
4. In the tab, type some text (e.g. `# Hello\nThis is a snippet.`). Cmd+S.
5. Refresh panel (close + re-open or reload via devtools) — confirm preview updates.
6. Open any other document (File → Open File or a workspace file). Position cursor somewhere.
7. **Double-click** the `test.md` snippet in the panel. Content inserts at cursor (parsed as markdown → heading renders as heading).
8. Right-click the snippet → **Copy to Clipboard**. Toast appears. Paste in any external app (terminal, Claude web) — confirm content.
9. Select a paragraph in the editor → right-click → **Save Selection as Snippet** → name it `test2.md`. Panel now shows 2 snippets. `test2.md` is visible.
10. Right-click in the editor → **Insert Snippet...** → type "test2" in picker → Enter. Content inserts.
11. Right-click `test.md` in the panel → **Rename** to `renamed.md`. Tab label updates. Cmd+S saves to new path (check disk: `ls ~/.gutter/snippets/`).
12. Right-click `renamed.md` → **Delete** → Yes. Snippet gone from panel and disk.

Pass = 12 steps all work. Step 9 specifically verifies the atom-node check (if your selected paragraph has no Mermaid/math, it'll allow save; try again with a selection that DOES contain a Mermaid/math block to see the disabled entry).

## Rollback

Each commit independently revertable. Commit 1 (backend) safe to revert alone (nothing consumes it). Commits 2–7 layered — revert in reverse order if needed.

## Known intermediate-state caveats

- After commit 1–3, no UI exists. Snippets can only be created/accessed via devtools.
- After commit 4 but before commit 5, panel works but can only be toggled via `useEditorStore.getState().toggleSnippets()` in devtools.
- After commit 6 but before commit 7, renaming a snippet with an open tab leaves the tab stale until next launch.
