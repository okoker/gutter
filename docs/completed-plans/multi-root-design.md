# Multi-Root Workspace — Design Doc

**Status:** Draft
**Scope:** MVP (no cross-root search / wiki-links / backlinks / tags)
**Date:** 2026-04-24
**Branch (future):** `feature/multi-root`

## Goal

Support opening multiple folders as peer roots in one workspace. Each root independently watched, collapsible in the sidebar, tab-browsable. Tabs are global across roots. Cross-root *features* (search etc.) deferred to Feature #3.5.

## Mental model

VS Code multi-root. Sidebar shows stacked per-root trees with collapsible headers. Opening a file from any root creates a tab; tabs are orthogonal to roots. Existing single-root mental model (one active root owns search/wiki-links/tags) preserved via an `activeRootPath` field — for MVP, active root = first-added.

## Data model

New store shape in `workspaceStore.ts`:

```ts
interface WorkspaceRoot {
  path: string;      // absolute, canonical
  name: string;      // display = basename
  tree: FileEntry[];
  expanded: boolean;
}

interface WorkspaceState {
  roots: WorkspaceRoot[];
  activeRootPath: string | null;
  openTabs: OpenTab[];               // unchanged
  activeTabPath: string | null;

  addRoot(path: string): Promise<void>;
  removeRoot(path: string): void;
  loadRootTree(path: string): Promise<void>;
  setRootExpanded(path: string, expanded: boolean): void;

  // Backward-compat getters (deprecated, migration bridge):
  workspacePath: string | null;      // roots.find(r => r.path === activeRootPath)?.path ?? roots[0]?.path ?? null
  fileTree: FileEntry[];             // roots.flatMap(r => r.tree)
  loadFileTree(path: string): Promise<void>;  // delegates to loadRootTree
}
```

**activeRootPath rules (MVP):**
- First root added auto-set as active.
- Active root closed → promote `roots[0]` (or null if empty).
- User cannot manually change active root in MVP (Feature #3.5).

## Rust backend

Watcher goes from single-instance to keyed-by-path:

```rust
struct WatcherState {
    watchers: Mutex<HashMap<PathBuf, RecommendedWatcher>>,
}

start_watcher(path: String)                       // idempotent add; replaces if path already watched
stop_watcher(path: Option<String>)                // targeted stop; None = stop all (for shutdown)
```

Event payloads: `file-changed` carries full file path (unchanged), `tree-changed` carries root path (already correct — frontend just needs to route by it).

## UX

**Sidebar layout** (three roots open):

```
FILES  [+file] [+folder] [open-file] [open-folder]
──────────────────────────────────────────────
▾ Alpha
    alpha-sub/
      a.md
▾ Beta
    beta-sub/
      b.md
▾ Gamma
    g.md
```

- Root header: chevron + basename. Click chevron/header → toggle collapse. Visual hint for active root (subtle dot/weight).
- **Right-click root header** → context menu → "Close Folder" (removes root; files untouched on disk).

**Add-root actions:**
- File menu → "Add Folder to Workspace…" → folder picker → append.
- Cmd+K command palette → "Add Folder to Workspace" → same.

**"Open Folder" legacy action:** clears ALL existing roots and opens selected. Two distinct actions (clean-slate vs augment), mirrors VS Code.

## Per-consumer impact (MVP)

| Consumer | Change |
|---|---|
| `FileTree.tsx` | Render per-root stacked trees, collapsible headers, root context menu |
| `useFileWatcher.ts` | Per-root watcher lifecycle: start on addRoot, stop on removeRoot, stop all on unmount |
| `loadFileTree(path)` callers (file ops) | Call site unchanged via getter; internally routes to `loadRootTree` |
| Search / wiki-links / backlinks / tags / image paths | **No change** — keep using `workspacePath` getter (returns `activeRootPath`) |
| Settings | New `rememberWorkspaceRoots: boolean` + `savedWorkspaceRoots: string[]` |
| PreferencesDialog | New checkbox: "Restore workspace on launch" |
| `useMenuBarListeners.ts` | Add listener for `menu:add-folder` → triggers folder picker → addRoot |
| Menu bar (`menu.rs`) | Add "Add Folder to Workspace…" item under File |
| Command registry (`useCommands.ts`) | Add "Add Folder to Workspace" command |
| `useWindowLifecycle.ts` | On close, if setting on, persist `roots.map(r => r.path)`; on launch, restore |
| Welcome screen | Unchanged — Open Folder is still first action |

## Persistence

- Setting: `rememberWorkspaceRoots: boolean` (default **true**, per user preference).
- On clean close: if true, write `savedWorkspaceRoots = roots.map(r => r.path)` to config.
- On launch: if true and non-empty, call `addRoot(path)` for each (with error recovery if path no longer exists).
- PreferencesDialog checkbox.

## Out of scope (Feature #3.5)

Explicit non-goals:
- Cross-root search / wiki-link autocomplete / backlinks / tags
- Reorder roots by drag
- Per-root display name renaming
- Hot "set as active root" UI
- Per-root `.gutter/` config (templates/snapshots stay global)

## Risks

| Risk | Mitigation |
|---|---|
| 20+ consumers of `workspacePath` / `fileTree` — blast radius | Backward-compat getters; migrate consumers only where needed for MVP |
| Per-root watcher file-descriptor leak on crash / unclean close | `stop_watcher(None)` on shutdown; per-path stop on removeRoot |
| Tabs outlive their root (user closes root B while a tab from B is open) | Keep tab open (paths absolute); save still works; "reveal in tree" becomes no-op. Document. |
| Persisted root path no longer exists on next launch | Skip silently (or optional toast); continue with remaining roots |
| `activeRootPath` ambiguity (which root owns the new-file button?) | First-added is active in MVP; deterministic. Subtle dot in UI. Revisit for #3.5. |

## Open items

1. **Active-root visual hint**: subtle dot? weight? nothing? Recommend: subtle bold on the active root header. Low-cost.
2. **"Open Folder" vs "Add Folder"**: two actions (as proposed) or unify into one that appends? Recommend: two actions — preserves legacy clean-slate behavior which some users rely on.
3. **Persistence error handling**: if a saved root path has disappeared, silent skip vs toast warning vs confirm dialog? Recommend: silent skip + log to console. Toast feels noisy on launch.
