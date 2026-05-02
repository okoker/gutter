# Backlog

Active wishlist. Items move to `docs/plans/` when they get a design, then to `docs/completed-plans/` when shipped.

## User list

- [ ] **Prompt library** — like snippets but for prompts. Could share snippets infra or be a separate panel.
- [ ] **Seed default templates** — handover, PRD, dodocs, meeting notes, incident postmortem, ADR. Templates infra exists (Phase 12); this is about shipping useful defaults bundled with the app and polishing TemplatePicker UX.

## Multi-root workspace follow-ups (flagged during Feature #3 implementation)

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
- JS blanket `lastSaveTimeRef` suppression for ALL file-changed events, 1.5s (`useMultiRootWatcher.ts:47`)
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

## Polish

### Active-root visual indicator (deferred from multi-root MVP)

Earlier the active-vs-inactive root header distinction was too subtle (11px uppercase, bold/muted weight delta). Resolved in 0.9.0 by going **uniform** — every root header now renders the same. If we later expose explicit "set active root" UX (see root-header context menu above), revisit a stronger active signal: accent dot, left border, or icon.
