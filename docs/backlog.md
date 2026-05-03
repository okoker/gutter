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

## Editor bugs (reported during 0.9.0 testing)

### Line-reveal widget UX trap — partially fixed

Originally `LinkReveal.ts` rendered raw markdown syntax (`**`, `##`, `*`, `~~`, `` ` ``, `[`, `](url)`, `[[`, `]]`) as ProseMirror **widget decorations**. Widgets had visual width but zero document position — they couldn't be selected, clicked into, backspaced over, or cursor-traversed normally. This caused four visible symptoms (a fifth — typing-direction-dependent input rules — moved to `docs/known_issues.md` as a documented limit shared by most WYSIWYG markdown editors):

1. **Can't unbold mid-paragraph** — typing `**bold**` works but the visible `**` is a widget; deleting it does nothing. **FIXED 2026-05-03** via right-click → "Remove Formatting" context menu item (`GutterEditor.tsx:589-606`). Runs `unsetAllMarks()` on the selection to remove inline marks (bold, italic, strike, code, link). The widget UX trap is still architecturally there (typing `**` and trying to backspace the widget still does nothing), but users now have a one-click escape via the context menu.
2. **Up/down arrow into bold lands wrong, snaps right** — vertical caret motion uses visual x-coordinates. **PARTIALLY FIXED 2026-05-03** by setting `contentEditable = "false"` on widget spans (`LinkReveal.ts:146-152, :222-228`). The general up-from-below case is fixed. The "leave a bold line then return to it" edge case still shifts the cursor by the total widget-character width (4 chars per `**X**` pair) because widgets disappear from the line when the cursor leaves and reappear when it returns, changing layout. Tried `width:0; overflow:visible` to make widgets layout-neutral — visually unacceptable (asterisks rendered floating above the line as orphaned dots). Reverted. **Remaining edge case is intrinsic to the requirement** (asterisks visible on active line, clean on inactive ⇒ layout MUST differ between states).
3. **Stuck heading + bold line** — `## **My information**, must support…` line cannot be unstyled by editing the visible syntax. **FIXED 2026-05-03** via the same "Remove Formatting" context menu item. The action is heading-aware: when the selection touches a heading block, `setParagraph()` is chained after `unsetAllMarks()` to downgrade the heading to a regular paragraph. Lists, task items, blockquotes, and code blocks are explicitly left alone — only headings get block-type stripping, since those are the only block-level "formatting" users want removed via this action.
4. **Left-arrow appears to skip over bold** — same root as bug 2. **FIXED 2026-05-03** by the `contentEditable = "false"` change. Browser no longer treats widget chars as cursor stops; cursor traverses widget atomically.

**Remaining open work:** the architectural trap (widgets-not-text) still exists for users who try to backspace the visible `**`/`##` characters directly — that doesn't work and won't, without an active-line redesign. With the context-menu escape hatch in place, this is now a discoverability/affordance issue rather than a "user is stuck with no way out" issue. The full active-line redesign is parked: the abandoned plan at `docs/plans/active_line_editing.md` was rejected after parallel review (architect + web research + Codex), and key finding from research is that **no Tiptap/ProseMirror editor has shipped this UX in production** — the proven implementations all run on CodeMirror 6. Worth revisiting only if the context-menu workaround proves insufficient with real users.

### Inline images break editing — schema/parser mismatch — FIXED 2026-05-03

**Symptom (user-reported):** images disappeared when editing text immediately before the image in the same paragraph.

**Root cause (confirmed via investigation):** TipTap's default `Image` extension is `inline: false` (block). Parser emits images as inline children of paragraphs — markdown like `Before ![alt](img.png) after` parses to `{ paragraph, content: [text, image, text] }`, schema-invalid because image is a block node in an inline content array. ProseMirror's `useEditor({ content })` is lenient on initial load, but the first transaction triggers schema validation and throws `RangeError: Invalid content for node paragraph: <text, image, text>` — image gets dropped or shifted.

**Fix:** added `inline: true, group: "inline"` to `Image.extend(...)` in `GutterEditor.tsx:192-194`. Existing tests still pass; on-disk markdown unchanged; cursor navigation around images improved (inline atom — left/right arrow steps cleanly, backspace deletes).

**Cleanup follow-ups (not done, low priority):**
- `BlockGapInserter.ts:9` — `"image"` entry in `BLOCK_NODE_NAMES` is now unreachable (image isn't a doc-level child anymore). Cosmetic cleanup.
- `parser.ts:436-444` block-level image case — dead code path. Safe to leave.
- `serializer.ts:116-127` block image case — dead code path. Safe to leave.

### First-block selection inside heading sections

**Symptom (user-reported):** when there are 5 checkbox lines under a heading or below a horizontal rule, the first checkbox is unreachable by mouse — selecting bottom-up to the top always omits the top item; selecting top-down sometimes can't place the cursor before the first item or click the first checkbox itself. Reproduces specifically when a list sits flush against a heading or HR; goes away when 2 blank lines separate them.

**Root cause:** `BlockGapInserter.ts:44` short-circuits when `$pos.depth !== 0` — the gap-click handler that inserts a paragraph at boundaries only fires for **doc-level** gaps. Sections (`Section.ts`) wrap `heading + block*`, so when a list sits as the first block inside a section (i.e. immediately under a heading), there's no doc-level gap above the list — and the section interior has no gap-click handling at all. Result: no clickable insertion point above the first list item.

**Fix shape (rough):** extend `BlockGapInserter` to also handle gaps **inside section nodes** — when the click resolves inside a section but outside any of its children, insert a paragraph at that boundary. Needs care to not collide with the section's defining boundary semantics or the heading row click area.

**Open question:** should this also apply to gaps inside other block containers (blockquotes, list items)? Probably yes for consistency, but scope first to section interior since that's the user-reported case.
