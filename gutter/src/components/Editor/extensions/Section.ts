import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";

const SVG_NS = "http://www.w3.org/2000/svg";

interface FoldMeta {
  pos: number;
  fold: boolean;
}

export const foldPluginKey = new PluginKey<DecorationSet>("sectionFold");

const foldPlugin = new Plugin<DecorationSet>({
  key: foldPluginKey,
  state: {
    init() {
      return DecorationSet.empty;
    },
    apply(tr, value) {
      value = value.map(tr.mapping, tr.doc);
      const update = tr.getMeta(foldPluginKey) as FoldMeta | undefined;
      if (!update) return value;
      if (update.fold) {
        const node = tr.doc.nodeAt(update.pos);
        if (node?.type.name === "section") {
          value = value.add(tr.doc, [
            Decoration.node(
              update.pos,
              update.pos + node.nodeSize,
              {},
              { foldSection: true },
            ),
          ]);
        }
      } else {
        // Unfold: find the fold decoration whose `from` is exactly this
        // section's position. Filtering by exact `from` (not just overlap)
        // matters because nested sections cause multiple fold decorations to
        // contain a given point.
        const found = value
          .find(update.pos, update.pos + 1)
          .filter((d) => d.from === update.pos);
        if (found.length) value = value.remove(found);
      }
      return value;
    },
  },
  props: {
    decorations(state) {
      return foldPluginKey.getState(state);
    },
  },
});

function setFolding(view: EditorView, pos: number, fold: boolean) {
  const section = view.state.doc.nodeAt(pos);
  if (section?.type.name !== "section") return;
  let tr = view.state.tr.setMeta(foldPluginKey, { pos, fold });
  if (fold) {
    const { from, to } = view.state.selection;
    const endPos = pos + section.nodeSize;
    if (from < endPos && to > pos) {
      const newSel =
        Selection.findFrom(view.state.doc.resolve(endPos), 1) ||
        Selection.findFrom(view.state.doc.resolve(pos), -1);
      if (newSel) tr = tr.setSelection(newSel);
    }
  }
  view.dispatch(tr);
}

function buildChevron(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fold-section-chevron";
  btn.contentEditable = "false";
  btn.tabIndex = -1;
  btn.title = "Toggle section";
  btn.setAttribute("aria-label", "Collapse section");

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
  return btn;
}

/**
 * Section node — wraps a heading + its body content for collapse/expand.
 * Sections are an in-memory wrapper only; markdown serialization flattens
 * them back to a flat heading + blocks sequence, so files on disk are
 * unchanged.
 */
export const Section = Node.create({
  name: "section",
  group: "block",
  content: "heading block*",
  defining: true,
  priority: 1000,

  parseHTML() {
    return [{ tag: "section[data-section]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "section",
      mergeAttributes(HTMLAttributes, { "data-section": "true" }),
      0,
    ];
  },

  addProseMirrorPlugins() {
    return [foldPlugin];
  },

  addKeyboardShortcuts() {
    return {
      // Enter at end of a heading whose section is folded inserts a fresh
      // paragraph AFTER the section (not inside it), letting the user keep
      // typing past the fold without expanding it. Returns false in every
      // other case so the default Enter behavior runs unchanged.
      Enter: () => {
        const editor = this.editor;
        const view = editor.view;
        const state = editor.state;
        const sel = state.selection;
        if (!sel.empty) return false;

        const $from = sel.$from;
        if ($from.parent.type.name !== "heading") return false;
        if ($from.parentOffset !== $from.parent.content.size) return false;

        const sectionDepth = $from.depth - 1;
        if (sectionDepth < 0) return false;
        const sectionNode = $from.node(sectionDepth);
        if (sectionNode.type.name !== "section") return false;

        const sectionPos = $from.before(sectionDepth);

        const decoSet = foldPluginKey.getState(state);
        if (!decoSet) return false;
        const isFolded = decoSet
          .find(sectionPos, sectionPos + 1)
          .some((d) => d.from === sectionPos);
        if (!isFolded) return false;

        const sectionEnd = sectionPos + sectionNode.nodeSize;
        const paragraphType = state.schema.nodes.paragraph;
        if (!paragraphType) return false;

        const tr = state.tr.insert(sectionEnd, paragraphType.create());
        tr.setSelection(TextSelection.create(tr.doc, sectionEnd + 1));
        tr.scrollIntoView();
        view.dispatch(tr);
        return true;
      },

      // Backspace at the start of an empty paragraph whose previous sibling
      // is a section: delete the paragraph and place the cursor in the
      // section. Without this, `defining: true` on section blocks the default
      // joinBackward merge and the empty paragraph becomes undeletable —
      // particularly noticeable for paragraphs inserted via the Enter-past-
      // fold shortcut above.
      Backspace: () => {
        const editor = this.editor;
        const view = editor.view;
        const state = editor.state;
        const sel = state.selection;
        if (!sel.empty) return false;

        const $from = sel.$from;
        if ($from.parent.type.name !== "paragraph") return false;
        if ($from.parent.content.size !== 0) return false;
        if ($from.parentOffset !== 0) return false;

        const parentDepth = $from.depth - 1;
        if (parentDepth < 0) return false;
        const parentNode = $from.node(parentDepth);
        const idxInParent = $from.index(parentDepth);
        if (idxInParent === 0) return false;

        const prevSibling = parentNode.child(idxInParent - 1);
        if (prevSibling.type.name !== "section") return false;

        const paragraphPos = $from.before($from.depth);
        const paragraph = parentNode.child(idxInParent);
        const prevSectionPos = paragraphPos - prevSibling.nodeSize;

        const decoSet = foldPluginKey.getState(state);
        const isFolded = decoSet
          ? decoSet
              .find(prevSectionPos, prevSectionPos + 1)
              .some((d) => d.from === prevSectionPos)
          : false;

        let cursorPos: number;
        if (isFolded) {
          // End of heading content (always visible).
          const heading = prevSibling.firstChild;
          if (!heading) return false;
          cursorPos = prevSectionPos + 1 + heading.nodeSize - 1;
        } else {
          // End of section's last child.
          cursorPos = paragraphPos - 1;
        }

        const tr = state.tr.delete(
          paragraphPos,
          paragraphPos + paragraph.nodeSize,
        );
        tr.setSelection(TextSelection.create(tr.doc, cursorPos));
        tr.scrollIntoView();
        view.dispatch(tr);
        return true;
      },
    };
  },

  addNodeView() {
    return ({ view, getPos, decorations }) => {
      const dom = document.createElement("section");
      dom.className = "fold-section";
      dom.setAttribute("data-section", "true");

      const button = buildChevron();
      dom.appendChild(button);

      const contentDOM = document.createElement("div");
      contentDOM.className = "fold-section-content";
      dom.appendChild(contentDOM);

      let folded = false;

      const setFolded = (next: boolean) => {
        folded = next;
        dom.classList.toggle("is-folded", folded);
        button.setAttribute(
          "aria-label",
          folded ? "Expand section" : "Collapse section",
        );
      };

      // Initial fold state from current decorations
      const initialFolded = (decorations as readonly Decoration[]).some(
        (d) => (d.spec as { foldSection?: boolean })?.foldSection,
      );
      setFolded(initialFolded);

      // mousedown: prevent the editor from stealing focus / starting selection
      button.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });

      button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = getPos();
        if (typeof pos !== "number") return;
        setFolding(view, pos, !folded);
      });

      return {
        dom,
        contentDOM,
        update(updatedNode, newDecorations) {
          if (updatedNode.type.name !== "section") return false;
          const isFolded = (newDecorations as readonly Decoration[]).some(
            (d) => (d.spec as { foldSection?: boolean })?.foldSection,
          );
          if (isFolded !== folded) setFolded(isFolded);
          return true;
        },
      };
    };
  },
});
