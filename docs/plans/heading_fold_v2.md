# Heading Fold v2 — Decoration-Based, Flat-Doc Architecture

**Status**: planned
**Replaces**: section-wrapper architecture (commit 780b293, May 2 2026)
**Research**: source-cited deep-dives into Zettlr (CodeMirror 6) and VS Code (Monaco). Both editors converge on the same canonical pattern; prior section-wrapper approach was a wrong-architecture choice that has caused the chevron-missing, Backspace-blocked, Enter-creates-headings, and selection-disorder regressions.

## Goal

Heading fold/unfold that:
- Works on edit-time-created headings (no save+reopen workaround).
- Doesn't fight Backspace/Enter/selection.
- Round-trips markdown byte-identically.
- Implements proven canonical pattern from Zettlr + VS Code.

## Architecture (canonical pattern, source-verified)

**Document model: flat.** No `section` wrapper node. Markdown on disk = JSON in memory (modulo TipTap's standard nodes). Heading is a top-level child of doc, body blocks follow at the same level.

**Fold state: `Set<headingPos>` in a ProseMirror plugin.** Mapped through every `tr.mapping`, validated against doc on each apply (drop positions that no longer resolve to a top-level heading).

**Decorations (computed every render from state):**
- `Decoration.widget(headingPos, makeChevron, {side: -1, key})` — chevron button per top-level heading. Key includes fold state for visual rotation.
- `Decoration.node(blockFrom, blockTo, {class: "is-folded"})` for each block within any folded range. CSS: `.is-folded { display: none }`.

**Auto-unfold (CM6-declarative pattern, not Monaco-imperative):** in plugin's `apply(tr, value, oldState, newState)`, after mapping, if `newState.selection.head` is inside any folded range body → drop that fold. Pure declarative; no timer.

**Range computation:** `getFoldRange(doc, headingPos) → {from, to} | null`:
1. Read heading at headingPos. Get level L.
2. Walk doc.content top-level siblings forward.
3. First sibling that is a heading with level ≤ L → `to = its position`.
4. End of doc → `to = doc.content.size`.
5. `from = headingPos + heading.nodeSize` (heading line stays visible).

**Constraint** (matches Zettlr + VS Code): only top-level headings get chevrons. Headings inside lists/blockquotes/tables don't fold. Walk only `doc.content` direct children.

**Persistence**: v1 = none. Fold state lives in plugin only, resets on tab switch / file reload. Matches user's existing mental model ("save+reopen drops fold state"). v1.1 can add session-only restore via tab state if needed.

## Files

### Delete

- `gutter/src/components/Editor/extensions/Section.ts` — entire file. Section node + foldPlugin + section-aware Backspace/Enter shortcuts all gone.

### Modify

- `gutter/src/components/Editor/markdown/parser.ts` — remove `wrapSections()` function and its invocation. Parser produces flat block list.
- `gutter/src/components/Editor/markdown/serializer.ts` — remove `flattenSections()` function and its invocation.
- `gutter/src/components/Editor/GutterEditor.tsx` — replace `Section` extension import + registration with new `HeadingFold` extension.
- `gutter/src/stores/workspaceStore.ts` — remove `foldedPositions: Set<number>` from tab interface (or repurpose for v1.1 persistence).
- `gutter/src/styles/editor.css` — remove `.fold-section`, `.fold-section-content`, `.fold-section-chevron`, section-related `.is-folded`. Add `.heading-fold-chevron` styles + `.is-folded { display: none }`.
- `gutter/tests/parser.test.ts` — update tests asserting section structure to assert flat structure.
- `gutter/tests/roundtrip.test.ts` — should pass unchanged (parser+serializer become symmetric in a simpler way).

### Create

- `gutter/src/components/Editor/extensions/HeadingFold.ts` — single extension, ~120 lines. Plugin + chevron widget builder + range computer.

## Implementation phases

### Phase 1 — Strip the wrapper (no fold UI yet)

1. Delete `Section.ts`.
2. Remove `wrapSections` from parser.ts; parser returns flat blocks.
3. Remove `flattenSections` from serializer.ts; serializer takes flat blocks.
4. Remove Section import + registration in GutterEditor.tsx.
5. Drop section-related CSS.
6. Update parser tests to assert flat structure.
7. Run roundtrip + serializer + companion tests — must all pass.
8. Type-check + smoke test the app: open existing files, make sure they render correctly without sections (no chevrons yet, but content is right).

**Exit criteria**: 63/63 tests pass. App loads files. No chevrons visible. Backspace on empty heading works (no defining-section to fight).

### Phase 2 — HeadingFold extension

1. Create `HeadingFold.ts` with plugin, chevron widget, range computer, CSS styles.
2. Register in GutterEditor.tsx.
3. Add CSS for `.heading-fold-chevron` and `.is-folded`.

**Exit criteria**: type `## Heading` → chevron appears. Click → body hides. Click again → body shows. Enter on heading → default behavior (paragraph follows or whatever TipTap defaults to). Backspace empty heading → deletes cleanly.

### Phase 3 — Manual verification (user-led)

Run dev build. Verify in app:
1. Empty doc: type `## H` → chevron appears immediately (no save needed).
2. Type body lines under H → fold hides them.
3. Type `### H2` under H → its own chevron, folds independently.
4. Fold H1 → hides H2 chevron + body too. Unfold H1 → H2 reappears with its prior fold state.
5. Click chevron of folded heading: unfolds. Click again: folds.
6. Cmd+F search inside folded text → match selection unfolds.
7. Click outline entry of folded heading → cursor lands on heading line (visible), no unfold needed.
8. Click outline entry inside a folded section → cursor lands in body, fold drops.
9. Save + reopen: file is byte-identical to before (round-trip). Fold state resets (session-only).
10. Backspace on empty heading at start → deletes heading.
11. Selection drag across fold boundary → cursor entering body unfolds.
12. Heading inside list (`- ## X`) → no chevron (constraint).
13. Headings of mixed levels (H1, H2, H3, H1 again) → fold ranges respect levels.

**Exit criteria**: every test above passes by my (and user's) eyes. Commit.

## Risks (and mitigations)

| Risk | Likelihood | Mitigation |
|---|---|---|
| `display:none` decorations interact oddly with ProseMirror selection | Low | Auto-unfold on cursor-touch resolves the only realistic case (cursor lands in hidden block). |
| Chevron widget DOM identity issues across re-renders | Low | Use `key` parameter in Decoration.widget spec including pos + fold state. |
| Existing files round-trip differently after stripping wrapSections/flattenSections | Very low | They cancel out today. Removing both keeps the input/output identity. Tests guard. |
| Tab restore preserves fold state expectations | None | v1 has no persistence; matches user's prior expectation. |
| Heading inside list/blockquote currently folds (in section world it doesn't either, but worth confirming) | Very low | Constraint matches both editors; no regression. |

## Out of scope (defer to v1.1+)

- Persistence of fold state across tab switches.
- Keyboard shortcuts (Ctrl+Shift+[/]).
- "Fold all H2"/"Fold all" actions.
- Animation on fold toggle.
- "…" placeholder after folded heading.
- Enter-on-heading-creates-paragraph (separate concern from fold; defer).

## Open questions

None. Plan is grounded in source-cited prior art (Zettlr 70 LOC, VS Code 150 LOC + TOC). Both ship this exact pattern.
