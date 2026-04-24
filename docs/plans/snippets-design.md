# Snippet Library (Feature #4) — Design Doc

**Status:** Draft
**Scope:** MVP — panel + create (2 flows) + edit-as-tab + insert-at-cursor + editor picker
**Date:** 2026-04-24
**Branch (future):** `feature/snippets`

## Naming note

Backlog called this "prompt library." In the code we use the generic name **"snippets"** — per user, the feature is for both AI prompts and other reusable text. Neutral naming keeps the door open for any text-reuse purpose and avoids implying AI-specific features.

Also per user memory: no "gutter" in new file/folder names. New files will be `snippets.rs`, `snippetStore.ts`, `SnippetsPanel.tsx`, `docs/plans/snippets-*.md`.

## Goal

A sidebar panel listing reusable text files stored at `~/.gutter/snippets/`. **Any text-encoded file** (any extension) is a snippet. Users double-click to insert at cursor, right-click for Copy / Rename / Delete, or click to open for editing as a regular tab. Right-click in the main editor offers "Insert Snippet..." via a searchable picker, and "Save Selection as Snippet" captures current selection into a new file.

## Mental model

Snippets are first-class markdown/text files stored in a global directory. Editing a snippet = opening a normal Gutter tab. No custom edit UI, no inline editor in the panel. This reuses every piece of existing editor infrastructure (source mode, wiki-links if the user wants them, find, spell check, everything).

## Storage

- Location: `~/.gutter/snippets/` (global, not per-workspace). Mirrors templates.
- Layout: **flat** — one file per snippet, no subdirectories in MVP.
- File format: **any text file**. Heuristic: attempt UTF-8 decode; if it succeeds and size < 1 MB, it's a snippet. Binary files silently ignored.
- Hidden files (starting with `.`) ignored.
- New snippets default to `.md` extension. User can rename to any other extension (`.txt`, `.rb`, etc.) — system is extension-agnostic.

## Rust backend

New module `gutter/src-tauri/src/commands/snippets.rs`, mirrors `templates.rs`:

```rust
pub struct SnippetInfo {
    pub filename: String,   // full filename with extension
    pub path: String,       // absolute path
    pub preview: String,    // first non-empty line, truncated to ~120 chars
    pub modified_ms: u128,  // last-modified for sort-by-recent
}

#[tauri::command] pub fn list_snippets() -> Result<Vec<SnippetInfo>, String>;
#[tauri::command] pub fn read_snippet(path: String) -> Result<String, String>;
#[tauri::command] pub fn save_snippet(filename: String, content: String) -> Result<String, String>;    // returns absolute path
#[tauri::command] pub fn delete_snippet(path: String) -> Result<(), String>;
#[tauri::command] pub fn rename_snippet(old_path: String, new_filename: String) -> Result<String, String>;
#[tauri::command] pub fn ensure_snippets_dir() -> Result<String, String>;   // creates ~/.gutter/snippets/ if missing
```

`list_snippets` reads the directory, filters to text files (UTF-8 probe + size cap), sorts by modified descending (most recently edited first), returns `SnippetInfo[]`. The frontend never has to read file content for the list view — `preview` is computed server-side.

## Frontend store

`gutter/src/stores/snippetStore.ts` (Zustand):

```ts
interface SnippetState {
  snippets: SnippetInfo[];
  loaded: boolean;
  loadSnippets(): Promise<void>;
  refreshSnippets(): Promise<void>;     // re-fetches, updates the list
  insertSnippet(filename: string): Promise<string>;   // reads content, returns it
  saveNewSnippet(filename: string, content: string): Promise<string>;
  removeSnippet(path: string): Promise<void>;
  renameSnippet(oldPath: string, newFilename: string): Promise<string>;
}
```

No in-memory caching of file contents — each insert reads from disk (files are small and on local SSD; the cost is negligible).

## UX — Sidebar panel

New component `gutter/src/components/SnippetsPanel.tsx`, matches the layout of `CommentsPanel.tsx`.

**Header:**
```
SNIPPETS       [ + ]     [ x ]    ← `+` creates a new snippet, `x` closes panel
```

**Rows** (per snippet):
```
┌───────────────────────────────────────┐
│ threat-model                          │
│ # Threat model for new feature...     │  ← first-line preview, muted color
└───────────────────────────────────────┘
```

- **Single click**: opens the snippet as a tab in the main editor.
- **Double click**: inserts the snippet's content at the current cursor position in the active tab. If no active tab, falls back to copying to clipboard + toast "No active editor — copied to clipboard instead."
- **Right-click**: context menu with:
  - **Insert at Cursor** (same as double-click)
  - **Copy to Clipboard** — writes content to clipboard, toast "Copied."
  - **Open to Edit** (same as single-click)
  - **Rename** — inline rename of filename (reuses `RenameInput` from FileTree)
  - **Delete** — with `ask()` confirmation

**New-snippet button** (`+` in panel header):
- Opens an input prompt: "Snippet name" → user types → appends `.md` if no extension → calls `save_snippet(filename, "")` → refreshes list → opens the new empty file as a tab.

**Empty state:** "No snippets yet. Select text in the editor and right-click → Save Selection as Snippet, or click + to create one."

## UX — Editor integration (context menu)

Two additions to the editor's right-click context menu (current menu lives in editor.css-styled floating bar):

1. **"Save Selection as Snippet"** — appears when there's a non-empty selection. Clicking prompts for a filename, saves the selection, refreshes the panel, toasts "Snippet saved."

2. **"Insert Snippet..."** — always visible. Opens a **searchable picker dialog** identical in pattern to the wiki-link picker (fuzzy-matches filename + preview). Select + Enter → inserts content at cursor. Scales to any number of snippets.

## UX — Panel toggle

- **Keyboard shortcut**: `Cmd+Shift+L` (L for Library).
- **View menu**: "Toggle Snippets Panel" added below the other panel toggles.
- **Command palette**: "Toggle Snippets Panel" entry.

## Insert-at-cursor semantics

The insert uses TipTap's `editor.chain().focus().insertContent(markdown).run()`. For `.md` snippets, content is parsed as markdown by TipTap's Markdown serializer. For `.txt` or non-markdown files, content inserts as a plain text node (no parsing).

Decision logic: if filename ends in `.md` / `.markdown`, parse as markdown. Otherwise, insert as plain text.

## Scope boundary — MVP vs follow-up

**In MVP:**
- Panel + list + create (2 flows) + edit-as-tab + double-click insert + context-menu copy/rename/delete + editor picker + save-selection + keyboard shortcut

**Out of scope (Feature #4.5):**
- Tags / categories / folders inside `~/.gutter/snippets/`
- Usage count / "most used" sorting
- Variable substitution (`{{name}}` prompts) — explicitly vetoed (Q4=none)
- Fuzzy-search inside the panel (ships with picker only)
- Import/export snippet packs
- Sync across devices (that's a whole storage-sync feature)
- Snippet watcher — if user adds a file via Finder, panel won't auto-refresh; they must click a refresh button OR the panel refreshes on focus (see open item)

## Per-file impact

| Area | Change |
|---|---|
| `src-tauri/src/commands/snippets.rs` | NEW. Mirrors `templates.rs` |
| `src-tauri/src/commands/mod.rs` | register new module |
| `src-tauri/src/lib.rs` | register 6 new commands in `invoke_handler!` |
| `src/stores/snippetStore.ts` | NEW. Zustand store |
| `src/components/SnippetsPanel.tsx` | NEW. Sidebar panel component |
| `src/App.tsx` | wire panel toggle state + sidebar mounting |
| `src-tauri/src/menu.rs` | add "Toggle Snippets Panel" menu item |
| `src/hooks/useMenuBarListeners.ts` | listen for `menu:toggle-snippets` |
| `src/hooks/useCommands.ts` | command palette entry |
| `src/hooks/useKeyboardShortcuts.ts` | bind `Cmd+Shift+L` |
| Editor context menu (location TBD — likely `src/components/Editor/GutterEditor.tsx` or a context-menu helper) | add "Save Selection as Snippet" + "Insert Snippet..." entries |
| NEW: picker dialog component | `src/components/SnippetPicker.tsx` — fuzzy search, mirrors wiki-link picker |
| `src/stores/editorStore.ts` | possibly add `showSnippetsPanel: boolean` + setter |

## Risks

| Risk | Mitigation |
|---|---|
| User has hundreds of text files in `~/.gutter/snippets/` — list load slow | `list_snippets` returns preview-only, not content; capped at 1 MB per file; typical CISO workflow is tens, not thousands. Accept. |
| Binary file in directory (image, PDF) — UTF-8 probe false-positive | Try decode + size cap = strong filter. Additional: check for null bytes in first 4 KB. Low concern. |
| Panel doesn't refresh when user adds file via Finder | Out of scope for MVP — keep current list until explicit refresh (auto-refresh on panel focus is a cheap add; evaluate in impl plan). |
| Editor context menu location — Gutter may not have a unified right-click menu yet | Research needed in impl plan. If no existing right-click hook, this becomes the biggest work item. |
| Markdown vs plain-text insertion — what if .md file has frontmatter / a heading | Insert content verbatim. If user has `---` frontmatter in a snippet, it'll insert as YAML in the middle of their doc. They can strip before saving the snippet. Document this. |
| Snippet `.gutter/` directory creation on first use | `ensure_snippets_dir` command. Call on first panel open. |

## Open items for impl plan

All formerly-open items resolved by architect review — see Refinements section below. No remaining open items at design stage.

## Refinements from architect review (all adopted in impl plan)

1. **Editor context menu**: `GutterEditor.tsx:470-583` already has a `handleContextMenu` that builds `ContextMenuItem[]` and renders `<ContextMenu>`. Snippet entries plug into this existing system. No new context-menu infrastructure.

2. **Panel visibility state lives in `editorStore`** alongside `showComments`, `showHistory`, `showTags`, with mutual exclusion. `snippetStore` holds list state only (no UI flags). `settingsStore.panelWidths.snippets = 288` default must be added.

3. **Insert semantics — precise**:
   - **`.md` / `.markdown`**: parse content via existing markdown parser, then `editor.chain().focus().insertContentAt($to.after(), parsedContent).run()` — insert after current block to avoid invalid schema on multi-block inserts.
   - **Non-markdown**: `editor.chain().focus().insertContent({ type: "text", text: content }).run()` — JSON node, no parsing.

4. **Backend text-file detection** — `snippets.rs` uses:
   - `String::from_utf8_lossy()` (not `from_utf8`) to tolerate BOM and lossy bytes.
   - Strip UTF-8 BOM (`\xEF\xBB\xBF`) from the start before preview extraction.
   - `fs::metadata(entry.path())` (follows symlinks) for size check — NOT `entry.metadata()` (returns symlink metadata).
   - `path.is_file()` guard after symlink resolution.
   - Null-byte check in first 4 KB to catch common binaries.
   - Caveat documented: a `.png` renamed to `.txt` with no null bytes in the first 4 KB may slip through. Accept.

5. **Extension preservation** — unlike `templates.rs` which strips `.md`, snippet identity IS the full filename including extension. Never strip. `validate_snippet_name` must reject path-traversal (`/`, `\`, `..`) same as `validate_template_name`.

6. **Selection capture for "Save Selection as Snippet"**:
   - Use `editor.state.doc.textBetween(from, to, "\n\n")` — block separator preserves paragraph breaks.
   - Comment marks (`<mark>...<sup>[cN]</sup>`) are stripped by `textBetween` (text-only extraction). Document behaviour.
   - Atom nodes (Mermaid, math) in selection: detect via node-walk BEFORE calling `textBetween`; if found, **abort with toast** ("Cannot save atom nodes — switch to source mode first").

7. **Rename stale-tab bug**: opening a snippet as a tab then renaming from the panel leaves the tab's `filePath` pointing at the old path. Must mirror whatever `FileTree.tsx`'s rename handler does — look for existing "update tab path on rename" mechanism in `workspaceStore.updateTabPath` or `useTabLifecycle` and reuse it. Fire a `CustomEvent` if needed. **MUST handle — not a nice-to-have.**

8. **Refresh-on-mount only** — `useEffect(() => { refreshSnippets(); }, [])` inside `SnippetsPanel.tsx`. No visible refresh button. Panel opens → list re-scans → user sees additions from Finder. Covers the friction case without a file watcher.

9. **`snippets.rs` stays separate from `templates.rs`** — architect confirmed almost zero shared logic. Keep separate. Optional: tiny `gutter_dirs.rs` helper for `~/.gutter/...` path resolution, but only if duplication actually bites.

10. **`Cmd+Shift+L` confirmed free** — scanned `useKeyboardShortcuts.ts`. No collision.
