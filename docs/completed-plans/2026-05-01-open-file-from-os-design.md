# Open-from-OS routing — design

**Date:** 01/05/2026
**Status:** Approved (brainstorm session, this branch)
**Scope:** Frontend behaviour only. No Rust/Tauri changes.

## Goal

When the user double-clicks a `.md` from Finder/Explorer (cold or warm), the file's parent directory is also made available as a workspace root, augmenting saved roots when present. The file tree behaves as an "ease-of-access panel," not a thematic workspace.

## Routing matrix

`routeFileFromOS(path, isColdStart)` runs after backend hands a path to the frontend.

| Trigger | `rememberWorkspaceRoots` | Parent inside any current root? | Action |
|---|---|---|---|
| Cold start | ON | restored roots checked | covered → open tab. else → `addRoot(parent)` + open tab. |
| Cold start | OFF | n/a | `addRoot(parent)` as sole root + open tab. |
| Warm app | any | YES | open tab only. |
| Warm app | any | NO | `addRoot(parent)` + open tab. |

**Coverage rule:** canonical absolute file-parent begins with a current root's canonical absolute path + path separator.

**Multi-file open** (Finder selects N, opens them): handled serially via the same routing function. Activate the last file in the list.

## Backend

Already complete. No changes:

- `lib.rs:36–41` — argv on cold start (Win/Linux), stash in `OpenFileState`, exposed via `get_open_file_path`.
- `lib.rs:99` — `RunEvent::Opened` on macOS emits `open-file` event.
- `lib.rs:18–22` — single-instance plugin forwards args from secondary launches, emits `open-file`.

## Frontend changes

1. **New function** `routeFileFromOS(path)` (~25 lines). Pseudocode:
   ```
   parent = canonicalize(parentDir(path))
   covered = roots.some(r => parent === r || parent.startsWith(r + sep))
   if isColdStart && !rememberWorkspaceRoots:
     addRoot(parent)              // sole root
   else if !covered:
     addRoot(parent)              // augment
   openFileAsTab(path)            // activate
   ```

2. **Modify** `useTabLifecycle.ts:257–266` — replace `handleFileTreeOpen(path)` with `routeFileFromOS(path)` in both the cold-start branch and the `open-file` listener.

3. **Coordination gate**. Add `restorationComplete: boolean` to `workspaceStore`. Set by `useWorkspacePersistence` after its restore loop completes (or immediately when remember=OFF / no saved roots). Cold-start path application awaits this flag so coverage check runs against the restored root set, not an empty one.

## Edge cases (no new code)

- File unreadable → `addRoot` skipped, surface existing toast on file-open failure.
- Parent dir unreadable, file readable → open tab anyway, `addRoot` toasts its own access error.
- File inside `__user_private/` or `_obsolete/` → user explicitly opened it; honour intent.
- `.markdown` extension → already handled by `arg.ends_with(".md") || arg.ends_with(".markdown")` filters in `lib.rs`.
- File matches an existing tab → tab-open path already de-dupes.
- Two double-clicks racing → events serialised by Tauri listener; routing is sequential.
- Setting toggled mid-session → routing reads the current value at event arrival; no locking.

## Out of scope (tracked separately)

- **File tree showing dotfiles** — drop `name.starts_with('.')` filter in `commands/workspace.rs:34`. Keep `*.comments.json` / `*.comments.md` filter at lines 37–38.
- **`.txt` whitespace/format normalisation on save** — pre-existing; separate fix.
- **Multi-instance / per-file routing across processes** — separate large feature (see prior session on Choice A lockfile design).

## Files touched

- `gutter/src/hooks/useTabLifecycle.ts` — replace direct call with routing function.
- `gutter/src/hooks/useFileFromOS.ts` (new) — or inline alongside `useTabLifecycle`. ~25 lines.
- `gutter/src/stores/workspaceStore.ts` — add `restorationComplete` flag + setter.
- `gutter/src/hooks/useWorkspacePersistence.ts` — set flag after loop.

## Acceptance

1. Cold start, remember=ON, saved roots restore, double-click outside-of-roots `.md` → both restored roots and parent appear; file open and active.
2. Cold start, remember=OFF, double-click `.md` → only parent appears as root; file open.
3. Warm app, any setting, double-click `.md` whose parent is covered → no new root; file open in existing tree.
4. Warm app, any setting, double-click `.md` whose parent is uncovered → parent added; file open.
5. Multi-select N files in Finder → Open → all N tabs open; last is active; uncovered parents added.
