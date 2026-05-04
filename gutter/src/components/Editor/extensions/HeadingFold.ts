import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

const SVG_NS = "http://www.w3.org/2000/svg";

interface FoldState {
  folded: ReadonlySet<number>;
}

type FoldMeta =
  | { type: "toggle"; pos: number }
  | { type: "fold"; pos: number }
  | { type: "unfold"; pos: number };

export const headingFoldKey = new PluginKey<FoldState>("headingFold");

/**
 * Top-level heading at this position, or null. Headings inside lists,
 * blockquotes, tables, etc. don't get fold chevrons — same constraint as
 * Zettlr and VS Code.
 *
 * `pos` must be a doc-top-level boundary (offset from doc.content.forEach).
 */
function topLevelHeadingAt(doc: PMNode, pos: number): PMNode | null {
  if (pos < 0 || pos >= doc.content.size) return null;
  const node = doc.nodeAt(pos);
  if (!node || node.type.name !== "heading") return null;
  const $pos = doc.resolve(pos);
  if ($pos.depth !== 0) return null;
  return node;
}

/**
 * For a top-level heading at `headingPos` with level L, return the body
 * range that fold should hide: from the position right after the heading,
 * to the position just before the next top-level heading at level ≤ L
 * (or end of doc).
 *
 * Mirrors Zettlr's `markdownFolding` algorithm and VS Code's TOC-based
 * range computation: fold range starts AFTER the heading line so the
 * heading itself stays visible and clickable.
 */
function getFoldRange(
  doc: PMNode,
  headingPos: number,
): { from: number; to: number } | null {
  const heading = topLevelHeadingAt(doc, headingPos);
  if (!heading) return null;
  const level = (heading.attrs.level as number) || 1;
  const from = headingPos + heading.nodeSize;

  let to = doc.content.size;
  let cursor = from;
  let foundNext = false;
  doc.content.forEach((child, offset) => {
    if (foundNext) return;
    if (offset < from) return;
    if (
      child.type.name === "heading" &&
      ((child.attrs.level as number) || 1) <= level
    ) {
      to = offset;
      foundNext = true;
      return;
    }
    cursor = offset + child.nodeSize;
  });

  if (!foundNext) to = cursor;
  if (to <= from) return null;
  return { from, to };
}

/**
 * Build the chevron button. DOM identity is stable across fold-state
 * changes — the rotation is driven by a CSS class applied to the parent
 * heading via a separate Decoration.node, NOT by rebuilding the widget.
 * This is what stops the disappear/reappear flicker when toggling fold.
 *
 * Click handler reads the LIVE position via ProseMirror's `getPos`
 * callback, and current fold state from the live plugin state — never
 * from a stale closure capture.
 */
function buildChevron(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "heading-fold-chevron";
  btn.contentEditable = "false";
  btn.tabIndex = -1;
  btn.title = "Toggle section";
  btn.setAttribute("aria-label", "Toggle section");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M3 4.5l3 3 3-3");
  svg.appendChild(path);
  btn.appendChild(svg);

  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const widgetPos = getPos();
    if (typeof widgetPos !== "number") return;
    // Widget was anchored at headingBoundary + 1 (inside the heading at
    // start of content). Subtract 1 to recover the heading's top-level
    // boundary position, which is what the fold set keys on.
    const pos = widgetPos - 1;
    const heading = topLevelHeadingAt(view.state.doc, pos);
    if (!heading) return;

    const value = headingFoldKey.getState(view.state);
    const isCurrentlyFolded = value?.folded.has(pos) ?? false;
    const willBeFolded = !isCurrentlyFolded;

    let tr = view.state.tr.setMeta(headingFoldKey, {
      type: "toggle",
      pos,
    } satisfies FoldMeta);

    if (willBeFolded) {
      // About to fold: move the cursor INTO the heading so the auto-unfold
      // (which runs on selection change) doesn't immediately drop the new
      // fold, AND so the cursor isn't stranded in a display:none block.
      // End of heading content is the natural target.
      const cursorPos = pos + 1 + heading.content.size;
      try {
        tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      } catch {
        // Fall through without selection change if the resolve fails for
        // any reason (shouldn't, but keep this defensive).
      }
    }

    view.dispatch(tr);
  });

  return btn;
}

/**
 * Heading fold extension — flat-doc, decoration-based.
 *
 * Architecture (mirrors Zettlr/CM6 + VS Code/Monaco):
 *  - Document is FLAT: headings are top-level siblings of the blocks they
 *    "own". No section wrapper node.
 *  - Plugin state holds Set<headingPos> of folded headings, mapped through
 *    every transaction's mapping and validated against the live doc.
 *  - Decorations:
 *      Decoration.widget — chevron button per top-level heading. Keyed by
 *                          pos only, so DOM stays mounted across fold
 *                          toggles (no flicker).
 *      Decoration.node   — `class:"is-fold-collapsed"` on each FOLDED
 *                          heading (drives chevron rotation via CSS).
 *      Decoration.node   — `class:"is-folded"` on every block within any
 *                          folded range. CSS `display:none` hides them.
 *  - Auto-unfold: in plugin apply, ONLY when the selection actually
 *    changed (not on every transaction), if the new selection head lands
 *    inside a folded range, drop that fold. This is the load-bearing
 *    primitive — it makes Find / arrow keys / scroll-to-comment all
 *    "just work" without bespoke handling.
 *  - When toggling INTO folded state, the click handler also moves the
 *    cursor to the heading line, so the fold isn't immediately
 *    auto-dropped and the cursor isn't stranded in hidden content.
 *  - Constraint: only top-level headings. Headings inside lists/blockquotes
 *    don't fold (matches both Zettlr and VS Code).
 */
export const HeadingFold = Extension.create({
  name: "headingFold",

  addProseMirrorPlugins() {
    return [
      new Plugin<FoldState>({
        key: headingFoldKey,

        state: {
          init() {
            return { folded: new Set<number>() };
          },
          apply(tr, value, oldState, newState) {
            // Map existing fold positions through the transaction. Drop
            // any whose mapped position no longer resolves to a top-level
            // heading (e.g., heading was deleted or converted to paragraph).
            const mapped = new Set<number>();
            for (const pos of value.folded) {
              const result = tr.mapping.mapResult(pos, 1);
              if (result.deleted) continue;
              if (topLevelHeadingAt(newState.doc, result.pos)) {
                mapped.add(result.pos);
              }
            }

            // Apply meta updates (toggle / fold / unfold).
            const meta = tr.getMeta(headingFoldKey) as FoldMeta | undefined;
            if (meta && topLevelHeadingAt(newState.doc, meta.pos)) {
              if (meta.type === "fold") mapped.add(meta.pos);
              else if (meta.type === "unfold") mapped.delete(meta.pos);
              else if (meta.type === "toggle") {
                if (mapped.has(meta.pos)) mapped.delete(meta.pos);
                else mapped.add(meta.pos);
              }
            }

            // Auto-unfold only on actual selection change. Without this
            // gate, every doc-changing transaction (typing, paste, etc.)
            // would re-evaluate and could drop folds whose cursor never
            // moved — and worse, the toggle transaction itself would
            // immediately undo any fold whose body contained the cursor.
            const selectionChanged = !oldState.selection.eq(newState.selection);
            if (selectionChanged) {
              const head = newState.selection.head;
              for (const pos of [...mapped]) {
                const range = getFoldRange(newState.doc, pos);
                if (!range) {
                  mapped.delete(pos);
                  continue;
                }
                // Strict interior check: cursor must be inside the body,
                // not at boundaries. Boundaries belong to neither the
                // heading nor the body.
                if (head > range.from && head < range.to) {
                  mapped.delete(pos);
                }
              }
            }

            return { folded: mapped };
          },
        },

        props: {
          decorations(state) {
            const value = headingFoldKey.getState(state);
            if (!value) return DecorationSet.empty;

            const decorations: Decoration[] = [];

            // Chevron widget per top-level heading. Key is pos-only, so
            // the widget DOM survives fold toggles without rebuild.
            state.doc.content.forEach((node, offset) => {
              if (node.type.name !== "heading") return;
              const headingPos = offset;
              decorations.push(
                Decoration.widget(
                  headingPos + 1,
                  (view, getPos) => buildChevron(view, getPos),
                  {
                    side: -1,
                    key: `heading-fold-chev-${headingPos}`,
                  },
                ),
              );

              // Visual fold-state class on the heading itself, drives
              // chevron rotation via CSS without rebuilding the widget.
              if (value.folded.has(headingPos)) {
                decorations.push(
                  Decoration.node(headingPos, headingPos + node.nodeSize, {
                    class: "is-fold-collapsed",
                  }),
                );
              }
            });

            // Hide every block inside any folded range. Merge ranges first
            // to keep the work O(blocks) rather than O(blocks * folds).
            if (value.folded.size > 0) {
              const ranges: Array<{ from: number; to: number }> = [];
              for (const pos of value.folded) {
                const range = getFoldRange(state.doc, pos);
                if (range) ranges.push(range);
              }
              ranges.sort((a, b) => a.from - b.from);
              const merged: Array<{ from: number; to: number }> = [];
              for (const r of ranges) {
                const last = merged[merged.length - 1];
                if (last && r.from <= last.to) {
                  last.to = Math.max(last.to, r.to);
                } else {
                  merged.push({ ...r });
                }
              }

              state.doc.content.forEach((node, offset) => {
                const blockEnd = offset + node.nodeSize;
                const inRange = merged.some(
                  (r) => offset >= r.from && blockEnd <= r.to,
                );
                if (inRange) {
                  decorations.push(
                    Decoration.node(offset, blockEnd, {
                      class: "is-folded",
                    }),
                  );
                }
              });
            }

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
