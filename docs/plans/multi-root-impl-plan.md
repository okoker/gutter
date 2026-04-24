# Multi-Root Workspace — Implementation Plan

**Design doc:** `docs/plans/multi-root-design.md`
**Branch:** `feature/multi-root`
**Base:** `main` at `80f0a9c`
**Scope:** MVP per design doc (cross-root features deferred to #3.5)
**Total commits:** 7 (one commit atomic for safety, six layered)

## Assumptions — verify before starting

- On `main` at or after `80f0a9c` (Feature #2 landed).
- Tree clean except `docs/backlog.md` (user edit) and `__user_private/`.
- `npm ci --dry-run` / `npx tsc --noEmit` / `npm test` all green.
- No `/Applications/gutter.app` running.
- notify v7.0.0 correctly drops its `RecommendedWatcher` (FSEvents backend, unwatches in Drop) — verify via `cargo tree | grep notify`.

## Phase 0 — Pre-flight (~1 min, no commit)

```bash
git checkout main
git pull --ff-only origin main || true
git status                                    # expect clean except docs/backlog.md + __user_private/
(cd gutter && npm ci --dry-run)
(cd gutter && npx tsc --noEmit)
(cd gutter && npm test -- --run)              # expect 41/41
(cd gutter/src-tauri && cargo tree | grep notify)
git checkout -b feature/multi-root
```

## Commit 1 — `feat(watcher): multi-root store + per-root watchers` (ATOMIC)

**Why atomic:** Rust watcher refactor + store shape change + hook rewrite MUST land together. Any intermediate state leaves per-root watchers broken.

### 1.1 — `gutter/src-tauri/src/commands/watcher.rs`

Replace `WatcherState` and lifecycle commands:

```rust
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

struct WatcherState {
    // Keyed by canonical root path. Dropping a value auto-unwatches via notify's Drop impl.
    watchers: Mutex<HashMap<PathBuf, RecommendedWatcher>>,
}

struct IgnoredPathState {
    paths: Mutex<HashMap<PathBuf, Instant>>,
}

pub fn init(app: &tauri::App) {
    app.manage(WatcherState { watchers: Mutex::new(HashMap::new()) });
    app.manage(IgnoredPathState { paths: Mutex::new(HashMap::new()) });
}

pub fn mark_write(app: &AppHandle, path: &str) { /* unchanged */ }
fn is_suppressed(app: &AppHandle, path: &Path) -> bool { /* unchanged */ }
fn is_ignored_path(path: &Path) -> bool { /* unchanged */ }

#[tauri::command]
pub fn canonicalize_path(path: String) -> Result<String, String> {
    std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to canonicalize path: {}", e))
}

#[tauri::command]
pub fn start_watcher(app: AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut guard = state.watchers.lock().map_err(|e| e.to_string())?;

    let key = PathBuf::from(&path);
    // Replace if already watching this path (idempotent).
    guard.remove(&key);

    let app_handle = app.clone();
    let watch_path = path.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            // UNCHANGED callback body from post-Feature-#2 fix
            // (emit file-changed for every non-ignored/non-suppressed path,
            // emit tree-changed with watch_path as payload once per event).
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher.watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to start watching: {}", e))?;

    guard.insert(key, watcher);
    Ok(())
}

#[tauri::command]
pub fn stop_watcher(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut guard = state.watchers.lock().map_err(|e| e.to_string())?;
    match path {
        Some(p) => { guard.remove(&PathBuf::from(p)); }
        None => { guard.clear(); }
    }
    Ok(())
}
```

### 1.2 — `gutter/src-tauri/src/lib.rs`

- Register the new `canonicalize_path` command in `invoke_handler!`.
- Change shutdown call from `stop_watcher(app_handle.clone())` to `stop_watcher(app_handle.clone(), None)` at line 104.
- **`cargo check` will enforce both** — any miss is a compile error.

### 1.3 — `gutter/src/stores/workspaceStore.ts`

New types + actions. Keep `workspacePath` and `fileTree` as plain state fields (not getters — Zustand needs real fields for selectors to trigger re-renders). Sync them from inside every root-mutating action via a `computeCompat` helper. **Remove `setWorkspacePath`** entirely.

```ts
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { fileName as pathBasename } from "../utils/path";

export interface FileEntry { name: string; path: string; is_dir: boolean; children: FileEntry[] | null; }
export interface OpenTab { path: string; name: string; isDirty: boolean; isPinned: boolean; diskHash: string | null; externallyModified: boolean; }
export interface WorkspaceRoot { path: string; name: string; tree: FileEntry[]; expanded: boolean; }

interface WorkspaceState {
  roots: WorkspaceRoot[];
  activeRootPath: string | null;

  // Backward-compat mirrors (synced in every roots-mutating action):
  workspacePath: string | null;
  fileTree: FileEntry[];

  openTabs: OpenTab[];
  activeTabPath: string | null;

  addRoot(rawPath: string): Promise<void>;
  removeRoot(path: string): void;
  loadRootTree(path: string): Promise<void>;
  setRootExpanded(path: string, expanded: boolean): void;

  // Compat facade — delegates to loadRootTree; add as root if unknown.
  loadFileTree(path: string): Promise<void>;

  // Tab actions — unchanged
  addTab, removeTab, setActiveTab, setTabDirty, reorderTabs, pinTab, unpinTab,
  updateTabPath, setTabDiskHash, setTabExternallyModified, getTab;
}

function computeCompat(roots: WorkspaceRoot[], activeRootPath: string | null) {
  const active = activeRootPath ? roots.find(r => r.path === activeRootPath) : roots[0];
  return { workspacePath: active?.path ?? null, fileTree: active?.tree ?? [] };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  roots: [],
  activeRootPath: null,
  workspacePath: null,
  fileTree: [],
  openTabs: [],
  activeTabPath: null,

  addRoot: async (rawPath: string) => {
    // Surface errors (canonicalize requires path to exist; read_directory may
    // fail on TCC-denied or unmounted volumes). Caller decides toast vs throw.
    let path: string;
    try {
      path = await invoke<string>("canonicalize_path", { path: rawPath });
    } catch (e) {
      useToastStore.getState().addToast(`Could not open folder: ${rawPath}`, "error");
      throw e;
    }
    if (get().roots.some(r => r.path === path)) {
      // Duplicate — promote to active and tell the user.
      const { roots } = get();
      set({ activeRootPath: path, ...computeCompat(roots, path) });
      useToastStore.getState().addToast("Folder already in workspace", "info");
      return;
    }
    let tree: FileEntry[];
    try {
      tree = await invoke<FileEntry[]>("read_directory", { path });
    } catch (e) {
      useToastStore.getState().addToast(`Could not read folder: ${path}`, "error");
      throw e;
    }
    const newRoot: WorkspaceRoot = { path, name: pathBasename(path) || path, tree, expanded: true };
    const roots = [...get().roots, newRoot];
    const activeRootPath = get().activeRootPath ?? path;
    set({ roots, activeRootPath, ...computeCompat(roots, activeRootPath) });
    await invoke("start_watcher", { path });
  },

  removeRoot: (path) => {
    const { roots, activeRootPath } = get();
    const next = roots.filter(r => r.path !== path);
    const nextActive = activeRootPath === path ? (next[0]?.path ?? null) : activeRootPath;
    set({ roots: next, activeRootPath: nextActive, ...computeCompat(next, nextActive) });
    invoke("stop_watcher", { path }).catch(console.error);
  },

  loadRootTree: async (path) => {
    const tree = await invoke<FileEntry[]>("read_directory", { path });
    const { roots, activeRootPath } = get();
    const next = roots.map(r => r.path === path ? { ...r, tree } : r);
    set({ roots: next, ...computeCompat(next, activeRootPath) });
  },

  setRootExpanded: (path, expanded) => {
    const { roots, activeRootPath } = get();
    const next = roots.map(r => r.path === path ? { ...r, expanded } : r);
    set({ roots: next, ...computeCompat(next, activeRootPath) });
  },

  // Compat: if `path` is already a root, refresh its tree; otherwise add as a root.
  // Preserves behavior of callers that call loadFileTree(path) after file ops.
  loadFileTree: async (path) => {
    if (get().roots.some(r => r.path === path)) {
      await get().loadRootTree(path);
    } else {
      await get().addRoot(path);
    }
  },

  // Tab actions unchanged (copy verbatim from current workspaceStore.ts)
  addTab, removeTab, setActiveTab, ... /* as-is */
}));
```

### 1.4 — `gutter/src/App.tsx`

Change the import and call site:
- Line 29: `import { useFileWatcher } from "./hooks/useFileWatcher"` → `import { useMultiRootWatcher } from "./hooks/useMultiRootWatcher"`
- Line 83 call site: rename accordingly.

**This file must be in commit 1. Without it, `tsc --noEmit` fails.**

### 1.4.1 — New hook `gutter/src/hooks/useMultiRootWatcher.ts` (replaces `useFileWatcher.ts`)

- Diff tracking via `Ref<Set<string>>` of started watchers.
- Effect 1: diff `roots` against started set; start/stop per-root. On unmount, `stop_watcher(null)`.
- Effect 2: if `roots.length === 0 && filePath`, watch the file's parent dir (legacy single-file-open support).
- Effect 3: event listeners — tree-changed routes by payload (root path) to `loadRootTree`; file-changed per-tab logic unchanged from current hook.

**StrictMode note:** React 19 dev mode double-invokes effects. The hook is idempotent under double-invoke because `start_watcher(path)` replaces any existing watcher for that path, and the `stop_watcher(null)` → re-`start_watcher` cycle leaves watchers in the correct final state. Do NOT add a guard that tries to detect double-invoke — it would break the idempotency.

Delete `useFileWatcher.ts` in this commit.

### 1.5 — Tests: `gutter/tests/multiRoot.test.ts` (new)

Mock `invoke` to return trivial directory trees. Cover:

- `addRoot` once → roots.length=1, activeRootPath=that path, workspacePath mirrors
- `addRoot` twice → roots.length=2, activeRootPath stays on first
- `addRoot` duplicate → no duplicate, activeRootPath set to that path, toast emitted
- `removeRoot` active root → activeRootPath promotes to next, workspacePath mirrors
- `removeRoot` all → activeRootPath=null, fileTree=[]
- `loadRootTree` → only that root's tree updates; others untouched
- `loadFileTree(unknownPath)` → compat facade calls `addRoot`, roots.length increases (this covers drag-drop & rename-refresh call sites)

### 1.6 — Verification (me, before commit)

- `(cd gutter/src-tauri && cargo check)` clean
- `(cd gutter && npx tsc --noEmit)` clean
- `(cd gutter && npm test -- --run)` passes 41+new = 47+
- No references to `setWorkspacePath` remain: `grep -rn "setWorkspacePath" gutter/src` returns nothing

### 1.7 — Commit message

```
feat(watcher): multi-root workspace store + per-root watchers

Core scaffolding for multi-root workspace support. Every subsequent
multi-root commit layers on this.

- Rust watcher now supports N concurrent watchers keyed by canonical
  path. start_watcher(path) is idempotent; stop_watcher(path: Option)
  stops one or all. Added canonicalize_path command.
- workspaceStore gains roots[] and activeRootPath. Backward-compat
  fields workspacePath and fileTree mirror the active root so the
  20+ existing consumers keep working during phased migration.
  setWorkspacePath removed so nothing can clobber via back door.
- useFileWatcher replaced by useMultiRootWatcher: diffs roots against
  running watchers, starts/stops accordingly, routes tree-changed by
  payload to refresh only the affected root.
- tests/multiRoot.test.ts covers store invariants.

Co-Authored-By: Koker <gitkoker@pm.me>
```

---

## Commit 2 — `feat(sidebar): stacked collapsible root sections`

### 2.1 — `FileTree.tsx`

Replace the `fileTree.filter(...).map(entry => <FileTreeNode ... />)` block with:

```tsx
{roots.map(root => (
  <RootSection
    key={root.path}
    root={root}
    isActive={root.path === activeRootPath}
    onToggleExpand={() => setRootExpanded(root.path, !root.expanded)}
    onContextMenu={(e) => handleRootContextMenu(root, e)}
  >
    {root.expanded && root.tree
      .filter(entry => !tagFilterFiles || hasMatchingDescendant(entry, tagFilterFiles))
      .map(entry => (
        <FileTreeNode key={entry.path} entry={entry} depth={0} ... />
      ))}
    {root.expanded && creatingIn?.parentPath === root.path && (
      <InlineCreateInput type={creatingIn.type} depth={0} ... />
    )}
  </RootSection>
))}
```

New `RootSection` subcomponent in the same file (ordering matters for `FileTreeNode`'s memo behavior; co-locate):

```tsx
function RootSection({ root, isActive, onToggleExpand, onContextMenu, children }) {
  return (
    <div>
      <div
        className={`relative flex items-center gap-1 px-3 py-[5px] cursor-pointer select-none text-[12px] uppercase tracking-wider transition-colors ${
          isActive
            ? "font-bold text-[var(--text-primary)]"
            : "font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        }`}
        onClick={onToggleExpand}
        onContextMenu={onContextMenu}
        title={root.path}
      >
        <span className={`shrink-0 transition-transform duration-150 ${root.expanded ? "" : "-rotate-90"}`}>
          <ChevronDown size={14} />
        </span>
        <span className="truncate">{root.name}</span>
      </div>
      {children}
    </div>
  );
}
```

### 2.2 — Add `handleRootContextMenu` (placeholder wiring, real action in commit 4)

```tsx
const handleRootContextMenu = (_root: WorkspaceRoot, e: React.MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  // Context menu populated in commit 4.
  setContextMenu({ x: e.clientX, y: e.clientY, items: [] });
};
```

### 2.3 — New-file / new-folder buttons (sidebar header) continue using `workspacePath` (= active root) — no change.

### 2.4 — Verify UI by launching dev + eyeballing. Commit.

### 2.5 — Commit message

```
feat(sidebar): stacked collapsible root sections

FileTree renders each workspace root as its own collapsible section.
Active root indicated by bold label. Root headers have chevron toggle
and right-click context menu (wired in commit 4).

Co-Authored-By: Koker <gitkoker@pm.me>
```

---

## Commit 3 — `feat(menu): Add Folder to Workspace action`

### 3.1 — `gutter/src-tauri/src/menu.rs`

Add menu item next to "Open Folder…" in File submenu. Emit `menu:add-folder` event on activation.

### 3.2 — `gutter/src/hooks/useMenuBarListeners.ts`

Add listener for `menu:add-folder`:
```ts
const unlistenAdd = listen("menu:add-folder", async () => {
  const selected = await open({ directory: true });
  if (!selected) return;
  const path = typeof selected === "string" ? selected : (selected as { path: string }).path;
  await useWorkspaceStore.getState().addRoot(path);
});
```

### 3.3 — `gutter/src/hooks/useCommands.ts`

Register command-palette entry "Add Folder to Workspace" — dispatches the same code path as the menu handler.

### 3.4 — Commit message

```
feat(menu): Add Folder to Workspace action

File menu item + command palette entry to append a new root to the
workspace. Invokes the directory picker and calls addRoot. Existing
"Open Folder" preserves its clean-slate semantics (commit 6 adds a
confirmation guard).

Co-Authored-By: Koker <gitkoker@pm.me>
```

---

## Commit 4 — `feat(sidebar): root header Close Folder context menu`

### 4.1 — `FileTree.tsx`

Replace the placeholder `handleRootContextMenu` with a real item:

```tsx
const handleRootContextMenu = (root: WorkspaceRoot, e: React.MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  setContextMenu({
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: "Close Folder", action: () => removeRoot(root.path) },
    ],
  });
};
```

### 4.2 — Commit message

```
feat(sidebar): root header Close Folder context menu

Right-click a root header to close that root. Open tabs from that root
stay open (their paths are absolute); "reveal in tree" becomes a no-op
for those tabs. Files on disk are untouched.

Co-Authored-By: Koker <gitkoker@pm.me>
```

---

## Commit 5 — `feat(workspace): persistence setting + restore/save`

### 5.1 — `gutter/src/stores/settingsStore.ts`

Add two fields:
```ts
rememberWorkspaceRoots: boolean;     // default true
savedWorkspaceRoots: string[];       // persisted paths
```

Add setters: `setRememberWorkspaceRoots`, `setSavedWorkspaceRoots`.

**Critical: update the `saveSettings` serializer body.** The existing `saveSettings` function (around line 76 of settingsStore.ts) explicitly destructures known fields into a `data` object passed to `invoke("write_settings", ...)`. Without adding the two new fields there, they will update in-memory state but **never persist to disk**. This is a silent bug — all checkboxes will appear to work in-session but reset on relaunch.

**Toggle re-enable behavior (documented):** when user turns "Restore workspace on launch" OFF, the save-on-change effect returns early, leaving `savedWorkspaceRoots` with the last-saved paths. When re-enabled, those paths restore. Least-surprise semantics (you resume where you were before you turned it off). Add a one-line comment to the effect.

### 5.2 — `gutter/src/components/PreferencesDialog.tsx`

Add checkbox in General (or Workspace) section: **"Restore workspace on launch"** bound to `rememberWorkspaceRoots`.

### 5.3 — Restore on launch (in `App.tsx` or a new `useWorkspaceRestore.ts`)

```ts
useEffect(() => {
  const { rememberWorkspaceRoots, savedWorkspaceRoots } = useSettingsStore.getState();
  if (!rememberWorkspaceRoots || savedWorkspaceRoots.length === 0) return;
  (async () => {
    for (const path of savedWorkspaceRoots) {
      try {
        await useWorkspaceStore.getState().addRoot(path);
      } catch (e) {
        // Missing / TCC-denied / unmounted — skip silently.
        console.warn(`Could not restore root: ${path}`, e);
      }
    }
  })();
}, []); // mount only
```

### 5.4 — Save on change (reactive debounced)

```ts
const roots = useWorkspaceStore(s => s.roots);
const remember = useSettingsStore(s => s.rememberWorkspaceRoots);
useEffect(() => {
  if (!remember) return;
  const paths = roots.map(r => r.path);
  useSettingsStore.getState().setSavedWorkspaceRoots(paths);
}, [roots, remember]);
```

Settings store already debounces disk writes.

### 5.5 — Commit message

```
feat(workspace): persistence setting + restore/save

New "Restore workspace on launch" preference (default on). When enabled,
open roots are saved on change and restored on launch. Restore failures
(missing path, TCC-denied, unmounted volume) are logged and skipped;
remaining roots continue to load.

Co-Authored-By: Koker <gitkoker@pm.me>
```

---

## Commit 6 — `feat(menu): confirm before Open Folder replaces`

### 6.1 — `gutter/src/hooks/useMenuBarListeners.ts`

Wrap existing "Open Folder" handler:
```ts
listen("menu:open-folder", async () => {
  const { roots } = useWorkspaceStore.getState();
  if (roots.length > 0) {
    const ok = await ask(
      `This will close ${roots.length} folder${roots.length > 1 ? "s" : ""} currently in your workspace. Continue?`,
      { title: "Replace Workspace?", kind: "warning" }
    );
    if (!ok) return;
  }
  const selected = await open({ directory: true });
  if (!selected) return;
  const path = typeof selected === "string" ? selected : (selected as { path: string }).path;
  // Close all existing roots
  const current = useWorkspaceStore.getState().roots.map(r => r.path);
  current.forEach(p => useWorkspaceStore.getState().removeRoot(p));
  await useWorkspaceStore.getState().addRoot(path);
});
```

### 6.2 — `FileTree.tsx` — sidebar "Open Folder" button must also guard

The sidebar header has an `[open-folder]` button wired to `handleOpenFolder` (line ~116 of `FileTree.tsx`) that currently just calls `loadFileTree(path)`. After commit 1, `loadFileTree` is the compat facade that *appends* to roots. So the sidebar button silently appends — NOT clean-slate. Fix explicitly:

```ts
const handleOpenFolder = useCallback(async () => {
  const selected = await open({ directory: true });
  if (!selected) return;
  const path = typeof selected === "string" ? selected : (selected as { path: string }).path;
  const { roots } = useWorkspaceStore.getState();
  if (roots.length > 0) {
    const ok = await ask(
      `This will close ${roots.length} folder${roots.length > 1 ? "s" : ""} currently in your workspace. Continue?`,
      { title: "Replace Workspace?", kind: "warning" },
    );
    if (!ok) return;
    roots.forEach(r => useWorkspaceStore.getState().removeRoot(r.path));
  }
  await useWorkspaceStore.getState().addRoot(path);
}, []);
```

Same pattern as the menu listener.

### 6.2 — Commit message

```
feat(menu): confirm before Open Folder replaces workspace

When roots are already open, show a confirmation before "Open Folder"
nukes the current workspace. Users wanting to append use "Add Folder
to Workspace" instead.

Co-Authored-By: Koker <gitkoker@pm.me>
```

---

## Commit 7 — `chore: audit JS-side fileTree consumers for MVP scope`

### 7.1 — Audit

Run: `grep -rn "\\.fileTree\\|s\\.fileTree" gutter/src --include="*.ts" --include="*.tsx"`

For each hit, decide:
- **Keep using `fileTree` compat field** (active root only): OK for MVP. Document with `// MVP: scoped to active root; cross-root in #3.5`.
- **Migrate to `roots.flatMap(r => r.tree)` explicitly**: only if the consumer semantically wants all roots and we deliberately want cross-root behavior in MVP (unlikely per scope).
- **Migrate to `activeRootPath`-specific enumeration**: if the consumer uses fileTree to scope a backend search or similar.

Expected candidates based on prior grep:
- `FileTree.tsx` — already migrated to `roots` in commit 2
- `TemplatePicker.tsx` — check if iterates fileTree for picker listing
- `UnifiedSearch.tsx` — delegates to Rust; shouldn't iterate directly
- `BacklinksPanel.tsx` — uses backlinkStore
- `backlinkStore.ts` — scans via `workspacePath` (active root, correct)
- `tagStore.ts` — scans via `workspacePath` (active root, correct)

### 7.2 — Commit message

```
chore: audit fileTree consumers for MVP scope

Verified no JS-side consumers iterate fileTree in a way that would
leak cross-root results for MVP scope. Cross-root enumeration remains
deferred to Feature #3.5. Added scoping comments where the compat
getter is relied on.

Co-Authored-By: Koker <gitkoker@pm.me>
```

---

## Phase N — Verify end-to-end (you drive)

After commit 7, I launch dev once. You execute the full path below. Estimated 3–4 minutes of active clicking; rest is observation.

1. Launch app (welcome screen).
2. File → **Open Folder** → `/tmp/mr-test-1/` (create this first, put a `.md` in it). Confirms clean-slate Open Folder with no roots still works.
3. File → **Add Folder to Workspace** → `/tmp/mr-test-2/`. Sidebar should now show two root sections stacked.
4. Cmd+K → "Add Folder to Workspace" → `/tmp/mr-test-3/`. Three roots visible.
5. Click chevrons — confirm each root section collapses/expands independently.
6. Click a file in root 2 — confirm tab opens; tab name doesn't indicate root (unchanged).
7. Right-click root 2 header → "Close Folder". Root 2 disappears. Tab from root 2 stays open.
8. Try to save that tab (Cmd+S) — should save to the absolute path, no error.
9. File → **Open Folder** → pick `/tmp/mr-test-1/`. **Confirmation dialog appears** ("This will close 2 folders…"). Click Cancel — nothing changes.
10. Repeat step 9, click OK — workspace replaced with just `/tmp/mr-test-1/`.
11. Quit app (Cmd+Q). Relaunch. **`/tmp/mr-test-1/` restored**.
12. File → Add Folder → `/tmp/mr-test-2/`. Two roots.
13. Preferences → **uncheck "Restore workspace on launch"**. Quit. Relaunch.
14. **Welcome screen** (no roots restored).
15. Preferences → re-check it. Add back a root. Quit & relaunch — restored.
16. **Regression check — Feature #2 still works:** with two roots open, open a file from root 2, modify it externally via `echo "EXT" >> /tmp/mr-test-2/somefile.md` (I do this). Editor should silent-reload the external content within 1–2 seconds (watcher's per-root lifecycle didn't break Feature #2).
17. **Regression check — Feature #1 still works:** with two roots open, click top-level chevron on each root section. Only that root toggles — the chevron-misroute bug stays dead.
18. **Context menu hygiene:** right-click a file row, dismiss the menu; right-click a root header, dismiss; right-click a folder inside a root. Each menu should be distinct (file ops / close folder / folder ops) and close cleanly.

Pass = all 18 steps match expected. Any mismatch = stop, escalate.

## Phase N+1 — FF merge

```bash
git checkout main
git merge --ff-only feature/multi-root
git branch -d feature/multi-root
```

No `git push`. User decides when to push.

## Rollback strategy

Each commit is independently revertable (except commit 1 which must revert as a unit — the three changes are intertwined). If any commit surfaces a regression in the verification phase:

- Identify the offending commit via repro.
- `git revert <sha>` on the feature branch.
- Re-run verification.
- If revert cascades (commit 2+ depend on commit 1's shape), the whole branch is reverted and we diagnose the root cause before resuming.

## Known intermediate-state caveats (on the feature branch, pre-merge)

- After commit 1 and before commit 2: sidebar still shows only the active root's tree. Adding a second root adds it to the store but the UI doesn't render it. Expected; commit 2 fixes it.
- After commit 2 and before commit 3: no menu entry exists to add a root. Can only add via `useWorkspaceStore.getState().addRoot(path)` from devtools. Expected; commit 3 fixes it.
- After commit 3 and before commit 4: right-click root does nothing (empty context menu). Expected; commit 4 fixes it.
- After commit 4 and before commit 5: roots don't persist across sessions. Expected; commit 5 fixes it.
- After commit 5 and before commit 6: "Open Folder" silently nukes existing roots. Expected; commit 6 fixes it.
- After commit 6 and before commit 7: some minor consumers may still reference `fileTree` without awareness; commit 7 audits.

## Open items resolved from design doc

- Visual hint for active root: **bold font + full-opacity text color** on the root header. Simple, visible, no new icon.
- Persistence error classes: missing path, TCC-denied, unmounted volume. All **skip silently + log to console**. No toast (noise on launch).
- "Open Folder" vs "Add Folder": **two distinct actions**, "Open Folder" guarded by confirmation when roots > 0 (commit 6).

## Out of scope — tracked for Feature #3.5

- Cross-root search
- Cross-root wiki-link autocomplete
- Cross-root backlinks panel
- Cross-root tag index
- Drag-reorder roots
- Per-root display rename
- User-initiated "set as active root"
- Expanded state persistence per root
