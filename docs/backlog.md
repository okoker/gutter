# Backlog



## User list

- [ ] **FIX -** fix the folder collapse issue.
- [ ] **FIX -** HOT RELOAD docs. refresh directory/files if there are addition (FSevents?)**
- [ ] **Add the ability to open multiple directories.**
- [ ] **prompt library - like snippets but for prompts.**
- [ ] template library - handover template, prd template, dodocs?,  ?




## Feature #5 — Template library (next up)

From the User list: *"template library - handover template, prd template, dodocs?, ?"*

Templates as a system already exist in the app (Phase 12, stored in `~/.gutter/templates/`, created via File → New from Template). Feature #5 is about **seeding useful defaults** that ship with the fork — handover, PRD, dodocs, possibly meeting notes / incident postmortem / ADR — plus any UX polish the existing flow needs.

**Not yet designed.** To do in its own session: brainstorm template contents, decide which ship bundled vs which are a separate "download pack", evaluate whether templates need variable substitution (we explicitly said no for snippets — same decision?), review existing TemplatePicker UX.

## Multi-root workspace follow-ups (flagged during Feature #3 implementation)

### Active-root visual indicator is too subtle (user-reported)

At 11px uppercase tracking-wider, the bold/muted difference between active and inactive root headers is barely visible. Needs stronger signal — stronger font weight delta, a distinct accent (bullet dot, left border, accent color on the chevron), or an explicit icon. One-commit polish.

### Stable-actions-ref refactor for `useMenuBarListeners.ts`

*Fixed during Feature #4 verification — commit `b09ace6` applied the root-cause stable-actionsRef pattern to the whole hook. Entry retained for history.*

### Root-header context menu is too sparse

Currently only "Close Folder". Reasonable additions, ordered by value:
- **New File** / **New Folder** — create at a non-active root's top level (currently impossible; sidebar header buttons only target the active root)
- **New from Template** — same rationale
- **Reveal in Finder** — quality-of-life platform opener
- **Set as Active Root** — explicit user-initiated active-root control (currently only auto: first-added). Touches MVP scope boundary; could ship ahead of Feature #3.5.
- **Rename Display Name** — lives with #3.5 (display-name model not in MVP store).

### Cross-root features (Feature #3.5)

Explicit non-goals from MVP, listed here for tracking:
- **Cross-root search** — `UnifiedSearch` scans only the active root's tree via the compat getter.
- **Cross-root wiki-link autocomplete** — `[[...]]` picker shows only the active root's files.
- **Cross-root wiki-link resolution** — a tab opened from a non-active root resolves `[[target]]` against the active root's tree, which is wrong when the target lives in the tab's own root.
- **Cross-root backlinks panel** — backlink index runs against active root only.
- **Cross-root tag index** — tags scanned from active root only.
- **Drag-reorder roots** — array order is insertion order.
- **Expanded-state persistence per root** — all roots restore expanded on launch.

## File-hot-reload follow-ups (flagged during Feature #2 fix)

### Redundant save-suppression windows

After a Gutter save, three suppressions stack:
- Rust `mark_write` per-path, 2s (`watcher.rs:26-31`)
- JS blanket `lastSaveTimeRef` suppression for ALL file-changed events, 1.5s (`useFileWatcher.ts:47` — now `useMultiRootWatcher.ts`)
- `lastSaveTimeRef` is set **before** `saveFile()` resolves (`useSaveHandler.ts:68`), so the window starts before the write completes

The JS blanket is over-broad — it suppresses events for unrelated files too, not just the path just written. With autosave at 2s default, external edits to other open files within 1.5s of any save are silently dropped. Follow-up: either delete the JS blanket (rely on per-path Rust suppression) or convert to per-path.

### FSEvents network/iCloud limitation

`notify` v7 FSEvents backend (now default after removing `macos_kqueue` feature) does **not** fire events for remote-side changes on network-mounted volumes (AFP/SMB/NFS) or iCloud Drive paths in "Optimise Storage" mode. Local-disk workspaces are unaffected. If a user reports hot-reload failing on a NAS/iCloud workspace, the fix is a `PollWatcher` fallback or a manual "reload from disk" UI. Not worth doing speculatively.

## Security

### IPC Path Boundary Enforcement (H3)

**Priority:** High (defence-in-depth, not currently exploitable if H1 is fixed)

**Problem:** All file I/O IPC commands (`read_file`, `write_file`, `delete_file`, `create_file`, `rename_path`, `delete_path`, `save_image`, `copy_image`, `read_file_data_url`) accept arbitrary absolute paths from the frontend with no validation. If the webview is ever compromised (XSS, malicious extension, dependency supply chain), the attacker can read, write, or delete any file the OS user has access to.

**Why it's deferred:** In normal use the frontend only sends paths within the user's workspace. The primary attack vector (Mermaid XSS, H1) has been fixed, which breaks the realistic exploit chain. Additionally, the app legitimately needs to access files wherever the user opens a workspace, and the backend doesn't currently track which workspaces are open -- that state lives in the frontend.

**Proper fix:** Implement an allowlist approach:
1. Add managed state in the Rust backend to track currently open workspace root paths
2. Update workspace state when the frontend opens/closes workspaces (new IPC command)
3. Add a `validate_path()` guard that canonicalises the path and verifies it falls within an allowed root or `~/.gutter/`
4. Call the guard at the top of every file I/O command
5. Consider also restricting the asset protocol scope (`tauri.conf.json`) and removing the unscoped `fs:allow-read`/`fs:allow-write` permissions from `capabilities/default.json`

**Simpler interim option:** Blocklist known sensitive directories (`~/.ssh/`, `/etc/`, system dirs). Weaker but trivial to implement.
