# Active-Line Editable Markdown Syntax — Plan

**Status:** ❌ SUPERSEDED 2026-05-03 — rejected after parallel review by architect + web research + Codex.
**Reasons for rejection (summary):**
- Codex flagged a HIGH-severity regression: every cursor-driven unwrap/rewrap transaction would set `transaction.docChanged === true`, which `GutterEditor.tsx:284-300` uses to mark the tab dirty + fire autosave + regenerate companion files. Cursor movement would dirty tabs. `addToHistory: false` doesn't help; `docChanged` is still true.
- Web research found almost no precedent for the doc-transform-on-cursor approach. The ProseMirror community deliberately avoided it (`prosemirror-codemark` chose decoration + `storedMark` over mutation, citing cursor-offset issues).
- Architect flagged Phase 6 (active-block-aware input rules) as under-budgeted and using mechanisms that don't actually work in TipTap (`addInputRules` can't be conditional on selection; plugin priority doesn't gate at rule level). Realistic implementation needs StarterKit fork.
- Architect flagged Phase 2 standalone is a regression (bold uses Path B, italic still uses widgets — inconsistent within a single line).
- Codex flagged the regex-based `**X**` rewrap is too weak for nested marks, links, commentMark, inline math.
- Codex flagged dispatch-loop risk: plugin's own transform retriggers block-change detection unless explicitly meta-guarded.
- Architect flagged Section/`defining: true` interaction with heading transform is hand-waved; CommentMark overlap with bold range is unspecified.
- Missing topics: a11y/screen-reader regression, find/replace, copy/paste across active/inactive boundary.

**Replacement:** new plan based on Path E (hidden-syntax-as-real-text via CSS, no doc mutation on cursor move) — to be written separately.

**Original plan retained below for reference only.** Do not implement.

---

**Date:** 2026-05-03
**Author:** Claude (Opus 4.7)
**Replaces:** Widget-decoration approach in `LinkReveal.ts` (inherited from upstream Gutter, commit `29df9f3`, Feb 2026)

---

## Goal

When the cursor is on a line, raw markdown syntax for inline marks (`**`, `*`, `~~`, `` ` ``) and headings (`## `) must be **real editable text** — selectable, deletable, cursor-traversable. When the cursor leaves the line, the syntax characters disappear and the line renders cleanly.

Inner formatted text remains styled while syntax is visible (e.g. `**bold**` shows the asterisks muted-grey AND the inner word rendered bold).

## Bugs this resolves

| # | Symptom | Phase that fixes |
|---|---|---|
| 1 | Can't unbold mid-paragraph | P2 (unwrap) + P3 (backspace pair) |
| 2 | Typed `**` / `##` sometimes doesn't pick up | P6 (active-block input rules) |
| 3 | Up/down arrow into bold lands wrong, snaps 2 chars right | P2 (no widget = no visual/doc offset) |
| 4 | Stuck `## **My information**` line | P2 + P3 + P5 (heading transform) |
| 6 | Left-arrow skips over bold | P2 (no widget boundary) |

Bugs 5 (image disappear) and 7 (selection under header) are tracked separately in `docs/backlog.md`.

## Out of scope

- Wiki links `[[target]]` — keep current widget approach
- Regular links `[text](url)` — keep current widget approach + floating editor
- Underline `<u>...</u>` — no markdown-native syntax
- Comment marks `<mark>X</mark><sup>[c1]</sup>` — system-internal, never expose
- List bullets/numbers, blockquote `>`, code-fence ``` ``` ``` — structural, not inline syntax
- Reading mode, source mode — already separate paths

## Approach: Path B (per-block doc transform on cursor move)

**Why not Path C (CodeMirror-style flat-text + decorations):**
- ProseMirror is a structured rich-text editor; flat-text is its anti-pattern
- Comments, math, mermaid, tables are atom/structured nodes that can't flatten — would create a hybrid (worse than either pure paradigm)
- Path C effort: 6-8 weeks, all features regression-tested
- Path B effort: 1-2 weeks, contained to one plugin
- Future Gutter direction (encryption, more rich content) favors structured model

**Why not Path A (pseudo-editable widgets):**
- ProseMirror widget decorations are not focusable / not part of contenteditable surface
- Intercepting events on widgets to simulate editing fights the framework

## Mechanism

A new ProseMirror plugin `ActiveLineSyntaxPlugin` replaces LinkReveal's mark/heading widget code (LinkReveal stays for links + wiki links).

**Plugin state:**
- `activeBlockStart: number | null` — position of currently active block, mapped through every transaction

**Lifecycle:**
1. On every transaction, `apply()` maps `activeBlockStart` through `tr.mapping`
2. Compare new selection's block start to mapped previous; if changed → schedule transform
3. Transform: re-wrap old block (remove syntax chars) + un-wrap new block (insert syntax chars), single transaction, `addToHistory: false`

**Unwrap (cursor enters block):**
- For each contiguous mark range (bold/italic/strike/code) in block content: insert open syntax char(s) at range start, close char(s) at range end. Inner text **keeps the mark** (so `bold` still renders bold while `**` is visible).
- For heading: insert `## ` at start of heading content, level-matched
- Add inline decorations on syntax chars for muted-grey styling

**Rewrap (cursor leaves block):**
- Scan content for `**X**` / `*X*` / `~~X~~` / `` `X` `` patterns
- Strip syntax chars; ensure inner X has corresponding mark
- For heading: strip leading `## `

**Active-block-aware input rules (P6):**
- Run on every doc change in active block
- Detect `**X**` / etc patterns in raw text → apply mark to inner X without removing syntax chars
- Disable StarterKit's bold/italic/strike/code input rules in active block (they conflict — they consume the syntax chars)

**Backspace at syntax boundary (P3):**
- When cursor is just after closing syntax (or just before opening), backspace deletes the pair atomically and removes the mark from inner text
- Same logic for forward delete

## Critical correctness concerns

### C1: Selection mapping across the unwrap transform

When user clicks block M (which is currently rewrapped, no syntax visible), they click at visual offset 5. Plugin must:
1. Resolve click → doc position P_old (in pre-unwrap doc)
2. Dispatch unwrap transaction
3. User cursor must land at P_new (post-unwrap), which is P_old + however-many-syntax-chars-were-inserted-before-P_old

ProseMirror's `tr.mapping.map(P_old)` handles this **if** the unwrap is implemented as targeted `tr.insert(markStart, "**")` operations — the mapping correctly forwards positions across each insert. **Phase 0 spike must verify this.** If positions don't map correctly, manual recompute is needed.

### C2: Undo stack pollution

Every transform adds to undo by default. Cursor move → 2 transactions (rewrap old + unwrap new). User typing then arrowing then arrowing back = 5+ stack entries that aren't user actions.

**Fix:** all transform transactions set `addToHistory: false`. User edits on active block stay in history (default).

**Risk:** undo with `addToHistory: false` can produce surprising results if not grouped correctly with adjacent user edits. Phase 0 spike must include undo verification (type bold word → arrow away → arrow back → Cmd+Z should undo the typing, not the wraps).

### C3: Serializer must see canonical form

When `onUpdate` fires while active block is unwrapped, `editor.getJSON()` returns doc with raw `**` text + bold mark. Naïve serialization produces `****bold****` on disk.

**Fix:** new helper `getCleanJSON(editor)` that returns the JSON with active block re-wrapped. Used in `getMarkdown()` and `onUpdate` callback at `GutterEditor.tsx:284,837`.

### C4: Composition input (IME)

Asian-language IMEs use composition events that defer transactions. Firing transforms during composition disrupts input.

**Fix:** check `view.composing` before dispatching unwrap/rewrap; defer until composition ends.

### C5: Active-block boundary edge cases

| Case | Active block |
|---|---|
| Cursor in paragraph | The paragraph |
| Cursor in heading | The heading |
| Cursor in list item's paragraph | The paragraph (innermost block) |
| Cursor in blockquote's paragraph | The paragraph (innermost block) |
| Cursor in table cell's paragraph | The paragraph |
| Cursor in code block | The code block — **no transform** (no inline marks) |
| Cursor in atom node (math, mermaid) | Skip — no concept of inline syntax |
| Selection spans two blocks | Block containing `$from` only |
| Empty block | No-op |

### C6: Block identity across transactions

Plugin compares previous active block's mapped position to current selection's block start. If equal → no block change. Otherwise → transform. Mapping is via standard `tr.mapping.map(pos)` in `apply()`.

## Phases

Each phase is independently shippable. Phase exit criterion = the named behavior works in dev mode + no regressions to existing features (smoke test).

### Phase 0 — Spike (THROWAWAY)
**Cost:** 1-2 days
**Goal:** verify the architecture before committing to the full build.

Smallest end-to-end test:
- Plugin fires on cursor enter into a paragraph containing one bold mark
- Inserts `**` at mark boundaries, mark stays on inner text
- Plugin fires on cursor leave; removes `**`, mark stays
- Verify: cursor positions correct on enter/leave, undo doesn't include the wraps, no visual flicker, no doc drift across enter/leave/enter/leave cycles, `getJSON` post-leave matches pre-enter

**Exit criterion:** all six checks pass. If any fail, revisit architecture before Phase 1.

If spike succeeds → throwaway code is deleted; Phase 1 starts fresh.

### Phase 1 — Plugin scaffold + active-block tracking
**Cost:** 1 day
- Create `src/components/Editor/extensions/ActiveLineSyntax.ts`
- Plugin state with `activeBlockStart` mapped through transactions
- `console.log` block transitions; no transformations yet
- Wire into GutterEditor extensions list (alongside LinkReveal — not yet replacing)

**Exit:** dev mode logs correct block-change events; no regressions.

### Phase 2 — Bold-only unwrap/rewrap
**Cost:** 2 days
- Implement `unwrapBlock` for bold marks only
- Implement `rewrapBlock` for `**X**` patterns
- Inline decorations on syntax chars (muted-grey via `.line-reveal-syntax` reuse)
- All transformations `addToHistory: false`
- Disable LinkReveal's bold widget code (keep its other code)

**Exit:** arrowing into existing bold text shows `**bold**` editable; arrowing out re-renders cleanly. Bug 1 partially resolved.

### Phase 3 — Backspace on syntax boundary
**Cost:** 1 day
- Keymap: backspace just after closing syntax → delete pair atomically, remove mark
- Keymap: forward-delete before opening syntax → same
- Verify: deleting `**` of `**bold**` yields plain `bold` with no mark

**Exit:** Bug 1 fully resolved for bold. Bug 4 partially (heading needs P5).

### Phase 4 — Italic, strike, inline code marks
**Cost:** 1 day
- Extend unwrap/rewrap/backspace to italic (`*`), strike (`~~`), code (`` ` ``)
- Same shape as bold

**Exit:** all four marks behave identically.

### Phase 5 — Headings
**Cost:** 2 days
- Active heading: insert `## ` (or `### ` etc) at start of heading content
- Reactive rule: on doc change in active heading, recompute level from leading `#` count + space; downgrade to paragraph if all `#`s deleted
- Rewrap: strip leading `## ` from heading content

**Exit:** bug 4 fully resolved. User can edit `## **My info**` line, downgrade H2 to H3 by deleting `#`, etc.

### Phase 6 — Active-block-aware input rules
**Cost:** 1-2 days
- New input rules running on doc changes in active block
- Detect `**X**`/`*X*`/`~~X~~`/`` `X` `` → apply mark to inner X, leave syntax chars
- Disable StarterKit's bold/italic/strike/code input rules within active block (override `addInputRules` returning `[]` conditionally, OR use plugin priority)

**Exit:** bug 2 resolved. Typing `**word**` always picks up bold; user sees asterisks-with-bold.

### Phase 7 — Serializer integration
**Cost:** 1 day
- New helper `getCleanJSON(editor)` returning JSON with active block re-wrapped
- Use in `getMarkdown()` and `onUpdate` callback (`GutterEditor.tsx:284,837`)
- Update `serializeMarkdown` call sites that go through editor

**Exit:** saving a file with cursor on bold/heading line produces correct markdown on disk.

### Phase 8 — Edge cases + cleanup
**Cost:** 1-2 days
- Atom nodes (math/mermaid): skip in transform
- Code blocks: skip
- Composition: defer transforms during `view.composing`
- Multi-block selections: only `$from` block
- Empty blocks: no-op
- Underline + comment marks: skip in transform
- Remove dead code from LinkReveal (only links + wiki links remain there)

**Exit:** all edge cases handled. No regressions.

### Phase 9 — Verification
**Cost:** 1-2 days
- Existing tests still pass: parser, serializer, round-trip, comment store
- New tests:
  - Cursor enter/leave preserves doc round-trip
  - `addToHistory: false` transforms don't pollute undo
  - `getCleanJSON` strips syntax from active block
  - Composition guard works
- Visual tests (real-app): golden path + each edge case + bug-1/2/3/4/6 reproductions
- Manual: open existing user file with mixed formatting, edit each kind of element, save, reload, diff

**Exit:** ready to merge. Bugs 1, 2, 3, 4, 6 closed.

## Total estimate

11-14 days of focused work, plus 1-2 days for spike (Phase 0). Each phase is mergeable independently — if the project deprioritizes mid-plan, partial value is preserved.

## Decision points before P1

1. **Phase 0 result** — must pass all 6 verifications. If not, plan needs revision.
2. **Confirm out-of-scope list** above (links, wiki links, underline, comments, list/quote/code-block structure all unchanged).
3. **Per-phase merge or single PR** — recommend per-phase. Each phase produces a meaningful, testable improvement.

## Risks

| Risk | Mitigation |
|---|---|
| Selection mapping across unwrap edits the wrong cursor position | Phase 0 spike verifies |
| Undo stack pollution with cursor moves | Phase 0 verifies; `addToHistory: false` |
| IME composition disrupted | Phase 8 explicit guard; manual test with IME if available |
| Serializer sees raw syntax in active block | Phase 7 `getCleanJSON` helper |
| Performance with many blocks | Block-change-only triggers, not every cursor move; deferred measurement (acceptable for normal docs) |
| Active-block-aware input rules conflict with StarterKit | Phase 6 disables StarterKit's rules in active block |
| Real-app regressions in lists/blockquotes/tables | Phase 9 manual visual tests |
| Comment marks accidentally exposed as `<mark>` HTML on active line | Phase 8 skip-list |

## Reference

- Original LinkReveal commit: `29df9f3` (David Rigie, Feb 14 2026, upstream Gutter)
- Current LinkReveal file: `gutter/src/components/Editor/extensions/LinkReveal.ts`
- ProseMirror docs on decorations: https://prosemirror.net/docs/ref/#view.Decoration
- TipTap input rules: `@tiptap/core` `InputRule`
