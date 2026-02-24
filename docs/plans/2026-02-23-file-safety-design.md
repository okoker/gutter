# Disk-Truth File Safety Model

**Date:** 2026-02-23
**Status:** Approved

## Problem

Gutter's file handling has several safety gaps that make it untrustworthy for workflows where external tools (e.g., Claude Code, git) modify files that are simultaneously open in the editor:

1. **Background tab stale cache (HIGH)** — Files modified externally while their tab is inactive load from stale in-memory cache on tab switch. Subsequent saves silently overwrite external changes.
2. **Auto-save overwrites external changes (MEDIUM)** — If an external write arrives and auto-save fires within the 2s suppression window, external changes are silently lost.
3. **Auto-save doesn't save comments (MEDIUM)** — Only the `.md` file is auto-saved. Comment thread changes only persist on manual Cmd+S.
4. **Dual dirty-state divergence (LOW)** — `editorStore.isDirty` and `workspaceStore.tab.isDirty` desync after auto-save, causing phantom "save changes?" prompts.

## Design Principle

**The file on disk is always the source of truth. The editor is a view of that truth.**

Matches VS Code, Sublime Text, and other professional editors.

## Key Decisions

- **Clean files auto-reload silently** when changed on disk
- **Dirty files show a conflict dialog** when changed on disk
- **Auto-save OFF by default** (manual Cmd+S). Opt-in via settings.
- **When auto-save is enabled**, it saves everything (md + comments + companion)
- **Read-before-write safety check** on every save operation

## Design

### 1. Per-Tab Disk State Tracking

New field: `workspaceStore.openTabs[n].diskHash` — SHA-256 hash of file content as last loaded from or written to disk.

**Set when:**
- File opened / tab activated from disk → hash the content read
- After successful write → hash the content written
- After silent reload → hash the new content

**Enables:**
- Read-before-write: before writing, read disk, hash, compare to `diskHash`. Mismatch = external change → abort and prompt.
- Background tab detection: watcher marks tabs `externallyModified: true`, confirmed on activation by comparing disk hash.

### 2. Watcher Behavior (All Tabs)

**Current:** Only active tab's `file-changed` events are processed. Background tabs ignored.

**New:** Process events for ALL open tabs.

- **Active tab, clean buffer** → silently reload from disk, update `diskHash`
- **Active tab, dirty buffer** → conflict dialog: "File changed on disk. Reload or Keep?"
- **Background tab** → mark `externallyModified: true` in workspace store
- **On tab switch**, if `externallyModified`:
  - Clean tab → reload from disk silently, clear flag
  - Dirty tab → conflict dialog

Suppression (`mark_write` + `lastSaveTimeRef`) unchanged — continues to filter out our own writes.

### 3. Save Flow (Read-Before-Write)

**Manual save (Cmd+S):**
1. Snapshot `markdownRef.current`
2. Read file from disk, hash it
3. Compare to tab's `diskHash`
4. **Match** → write file, update `diskHash`
5. **Mismatch** → conflict dialog: "File modified externally. Overwrite or Reload?"
6. Write comments + companion after main file
7. Clear dirty state in both stores

**Auto-save (when enabled):**
- Same read-before-write check
- On mismatch → skip auto-save silently, mark tab `externallyModified`
- Saves everything: `.md` + `.comments.json` + `.comments.md`

### 4. Tab Content Cache

**Current:** `tabContentCache` Map in React ref. Content stashed on deactivation, restored on activation — no staleness check.

**New:** Cache stays for fast tab switching, but on `activateTab`:
- If tab is `externallyModified` → ignore cache, reload from disk
- Update cache with fresh content after reload

### 5. Unified Dirty State

**Current:** Two flags that can diverge.

**New:** `workspaceStore.tab.isDirty` is the single source of truth. `editorStore.isDirty` becomes a convenience accessor. Both manual save and auto-save clear the same flag.

### 6. Auto-Save Default

**Current:** ON by default (2000ms)
**New:** OFF by default (interval = 0). Users enable via Preferences.

## Unchanged

- Three-file sequential write (md → comments.json → comments.md) — not worth transactional complexity
- `mark_write` suppression mechanism — works well, complemented by `diskHash`
- `normalize()` comparison for content equality — still useful for whitespace differences
- Version history snapshots — still fire-and-forget on manual save

## State Diagram

```
File on disk changes (external)
        │
        ▼
  Is tab open? ──no──▶ (ignore, tree-changed only)
        │yes
        ▼
  Is our write? ──yes──▶ (suppressed, ignore)
  (mark_write check)
        │no
        ▼
  Is active tab? ──no──▶ Mark externallyModified=true
        │yes              (handle on tab switch)
        ▼
  Is buffer dirty? ──no──▶ Silent reload, update diskHash
        │yes
        ▼
  Show conflict dialog
  ┌─────┴─────┐
  Reload      Keep
  (lose edits) (user's version wins)
```
