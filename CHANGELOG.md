# Changelog

All notable changes to this fork of [Gutter](https://github.com/davidrigie/gutter) will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

Forked from upstream `davidrigie/gutter` at v0.3.8. Everything below is fork-only and has not yet been cut as a release.

### Security

- **Patched four high-severity vulnerabilities surfaced by an audit + independent codex review.**
  - Mermaid XSS — diagram rendering ran with `securityLevel: "loose"`; switched to `"strict"` so script content in diagram source can no longer execute in the webview.
  - Windows command injection in `open_url` — URL scheme is now validated and the URL is passed to `explorer.exe` directly, replacing the prior `cmd /c start` invocation that interpreted shell metacharacters.
  - Template path traversal — `validate_template_name` rejects names containing `/`, `\`, or `..` so a crafted name can't escape `~/.gutter/templates/`.
  - HTML export XSS — exporter now strips dangerous tags and `on*` event-handler attributes before writing.
  - One additional finding (IPC path boundary) is documented in the backlog with a deferral rationale.

### Added

- **Multi-root workspace.** Multiple folders can be open in the sidebar simultaneously, VS Code-style.
  - File menu / command palette: **Add Folder to Workspace** appends a root without closing the others.
  - Sidebar: each root renders as a stacked, collapsible section with chevron + right-click context menu (e.g. **Close Folder**, which leaves files on disk untouched and keeps any open tabs from that root open).
  - Preference: **Restore workspace on launch** (default on). Open roots persist; toggling off keeps the saved list intact so re-enabling later restores it.
  - Confirmation dialog before **Open Folder** (menu and sidebar header) replaces the current workspace, since "open" implies clean-slate semantics.
  - *Technical:* `workspaceStore` rewritten around a `roots: WorkspaceRoot[]` shape with backward-compat mirrors (`workspacePath` / `fileTree` / `loadFileTree`) so the 20+ existing consumers keep working during phased migration. Per-root watchers via a `HashMap<PathBuf, RecommendedWatcher>` in Rust; `useMultiRootWatcher` diffs roots against running watchers and routes `tree-changed` events to the right root. Idempotent under React 19 StrictMode double-invoke.

- **Snippet library.** Reusable text/markdown chunks stored at `~/.gutter/snippets/`.
  - Right-sidebar **Snippets** panel (`Cmd+Shift+L`, plus View menu and command palette entries) lists every text file under `~/.gutter/snippets/` with first-line preview.
  - Single-click opens a snippet as a regular tab; double-click inserts at the cursor (250 ms debounce so double doesn't trigger the open). Right-click for **Insert / Copy / Open / Rename / Delete**.
  - Editor right-click menu: **Save Selection as Snippet** (filename modal) and **Insert Snippet…** (fuzzy-searchable picker mirroring the unified-search UX).
  - Status-bar icon (Copy glyph) toggles the panel, placed rightmost in the panel cluster.
  - *Technical:* six Tauri commands (`ensure_snippets_dir`, `list_snippets`, `read_snippet`, `save_snippet`, `delete_snippet`, `rename_snippet`). Text-file heuristic: ≤1 MB, `is_file()` after symlink-follow, no null byte in first 4 KB, UTF-8 lossy decode tolerates BOM. Filename validation rejects path separators, `..`, leading dots. 4 Rust unit tests + 6 store unit tests cover happy/sad paths and IPC arg contracts.

- **Welcome screen — Open Folder button.** Third primary action alongside New File / Open File. Routes to the same multi-root `addRoot` flow as the menu entry.

- **Welcome screen — New from Template button.** Fourth action that opens the existing template picker in a no-workspace flow: pick a template, native save dialog chooses where the new file lands. Existing 3 entry points (menu, command palette, folder right-click) keep their inline-filename behaviour.
  - *Technical:* added a `useSaveDialog` flag on `TemplatePicker`. Filename for the dialog's default-path is sanitized for Windows-illegal characters (`: * ? " < > |`). `write_file` gains a defense-in-depth guard rejecting paths resolving under `~/.gutter/templates/` so the dialog can't accidentally overwrite a source template.

### Changed

- **Subfolders collapse by default in new workspace roots.** Previously immediate children of a root expanded automatically, producing a wall of pre-expanded folders when adding a root. Only the root header opens by default now; per-path expansion still survives root collapse/re-expand.

- **All right-side panels closed by default on launch.** Comments was previously open by default. With Snippets/History/Tags/Comments all available and users varying in preference, no panel auto-opens — users open whichever they want.

- **Uniform root-header prominence.** Every workspace root header now renders identically (bold, primary text, hover background). The earlier active-vs-inactive distinction was too subtle and signalled a capability the MVP doesn't expose.

- **Snippet rename updates open tab paths.** When a snippet is renamed from the panel, any tab holding the old path is migrated to the new path so subsequent saves land on the right file. Cross-platform path handling (`parentDir` + `joinPath`), so Windows paths with backslashes work too.

- **Toast durations.** Errors 8 s, info 5 s, success 4 s (was uniform 4 s). Errors need time to read; success just confirms.

### Fixed

- **Folder chevron toggled the wrong folder in the sidebar.** Folder rows lacked `position: relative`, so the absolutely-positioned indent-guide wrapper at depth > 0 resolved against a high ancestor and intercepted clicks at top-level chevron coordinates. Mirrors the pattern already on the file row.

- **macOS file watcher panicked on atomic-rename writes (Typora, VS Code, vim atomic-save).** `notify`'s `kqueue` backend crashed inside `Option::unwrap()` and silently killed the watcher thread for the rest of the session. Switched to default FSEvents backend; `kqueue` feature dropped from `Cargo.toml`. Known limitation: FSEvents doesn't fire for remote-side changes on network-mounted or iCloud "Optimise Storage" paths — workspaces on local disk are unaffected.

- **Open tabs stayed stale after external atomic-rename writes.** Watcher only emitted `file-changed` inside `EventKind::Modify`, but atomic-rename lands as `Create` + `Remove`. Watcher now emits `file-changed` for every non-ignored, non-suppressed path regardless of `EventKind`, plus `tree-changed` once per event. Frontend payload-filter on `openTabs` makes directory paths and unrelated files harmlessly drop.

- **Native menu listeners stacked one extra copy per re-render.** `useEffect` had the mutable actions object in its dep array, so listeners unlistened/relistened on every render. Harmless for sync handlers; manifested as an N-stacked async dialog loop after the multi-root work introduced an `ask()` confirmation. Root-cause fix: hook now holds actions in a refreshed-each-render ref and attaches `tauri.listen()` exactly once via `[]` deps.

- **Snippets panel preview didn't update after saving.** Panel only refreshed on mount. `useSaveHandler` and `useFileOps.scheduleAutoSave` now both dispatch a `file-saved` CustomEvent; SnippetsPanel listens and re-runs `refreshSnippets`.

- **Workspace restore on launch toasted errors for missing/TCC-blocked paths.** `addRoot` gained an optional `silentError` flag; restore path uses it to log to console and skip silently instead of toast-spamming at startup.

- **Snippet single-click opened the snippet as a tab in the same gesture that double-click was meant to insert it.** Single-click now defers 250 ms via a ref-backed timer; double-click cancels the timer and runs the insert against the previously-active editor.

- **Copy to Clipboard failed in the Tauri webview after async file read.** `navigator.clipboard.writeText` requires the user gesture to be active; an `await` between click and write consumes it. Snippets pre-cache content into a ref on right-click (while the context menu is visible) so the Copy click can read synchronously. Also added a hidden-textarea + `document.execCommand("copy")` fallback for edge cases.

- **Save Selection as Snippet was disabled by hardBreak / horizontalRule.** Atom-node check was too broad; narrowed to types where `textBetween` would actually drop content (`mermaidBlock`, `mathBlock`, `mathInline`, `image`).

- **Save Selection as Snippet silently no-op'd.** `window.prompt` is disabled in the Tauri webview. Replaced with a custom `SnippetNamePrompt` modal driven by a `save-selection-as-snippet` CustomEvent dispatched from the editor.

- **Folder expanded state lost when its workspace root collapsed.** When a root section collapses, its child `FileTreeNode`s unmount; on remount the depth-0 folders defaulted back to expanded. `expandedPathsRef` is now `Map<path, boolean>` (was `Set<string>`); each node reads/writes its initial state through it. Survives unmount because the ref lives on the still-mounted `FileTree` parent.

---

## Versions before the fork

Releases v0.1.0 through v0.3.8 are inherited from upstream `davidrigie/gutter` and not enumerated here. See the [upstream changelog](https://github.com/davidrigie/gutter) for those.
