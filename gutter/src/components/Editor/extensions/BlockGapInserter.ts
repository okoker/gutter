import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";

const BLOCK_NODE_NAMES = new Set([
  "mathBlock",
  "mermaidBlock",
  "frontmatter",
  "codeBlock",
  "image",
  "table",
  "horizontalRule",
  "blockquote",
  "bulletList",
  "orderedList",
  "taskList",
  "heading",
]);

function isBlockNode(name: string): boolean {
  return BLOCK_NODE_NAMES.has(name);
}

export const BlockGapInserter = Extension.create({
  name: "blockGapInserter",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockGapInserter"),
        props: {
          handleClick(view, _pos, event) {
            if (!view.editable || event.button !== 0) return false;

            const coords = { left: event.clientX, top: event.clientY };
            const posAtCoords = view.posAtCoords(coords);

            if (!posAtCoords) return false;

            // Determine the gap position. Two paths:
            //  (1) Click resolves between nodes (inside === -1) — standard
            //      gap. Use posAtCoords.pos directly.
            //  (2) Click resolves "inside" a horizontalRule. HRs render as a
            //      thin line with surrounding margin/space; clicks in that
            //      visual gap can hit-test as inside the HR rather than as
            //      a true between-nodes gap. Treat such clicks as a gap
            //      click adjacent to the HR (above or below based on click
            //      Y relative to the HR's vertical midpoint).
            let pos: number;
            if (posAtCoords.inside === -1) {
              pos = posAtCoords.pos;
            } else {
              const insideNode = view.state.doc.nodeAt(posAtCoords.inside);
              if (insideNode?.type.name !== "horizontalRule") return false;
              const dom = view.nodeDOM(posAtCoords.inside);
              if (!(dom instanceof HTMLElement)) return false;
              const rect = dom.getBoundingClientRect();
              const insertAfter =
                event.clientY > (rect.top + rect.bottom) / 2;
              pos = insertAfter
                ? posAtCoords.inside + insideNode.nodeSize
                : posAtCoords.inside;
            }

            const $pos = view.state.doc.resolve(pos);
            const depth = $pos.depth;

            // Container = the parent whose child-array gap we're filling.
            // Two cases handled:
            //   - doc-level gap (depth 0)
            //   - section-interior gap (parent is a section node — used by
            //     the heading-fold wrapper). This covers the "can't click
            //     above the first task item under a heading" case where the
            //     gap exists but isn't at doc level.
            // Other depths (lists, blockquotes, tables) keep their own
            // structural rules.
            let container: typeof view.state.doc;
            let containerStart: number;
            if (depth === 0) {
              container = view.state.doc;
              containerStart = 0;
            } else if ($pos.parent.type.name === "section") {
              container = $pos.parent;
              containerStart = $pos.start(depth);
            } else {
              return false;
            }

            const indexAfter = $pos.index(depth);
            const indexBefore = indexAfter - 1;

            const nodeBefore =
              indexBefore >= 0 ? container.child(indexBefore) : null;
            const nodeAfter =
              indexAfter < container.childCount
                ? container.child(indexAfter)
                : null;

            const hasBlockNeighbor =
              (nodeBefore && isBlockNode(nodeBefore.type.name)) ||
              (nodeAfter && isBlockNode(nodeAfter.type.name));

            if (!hasBlockNeighbor) return false;

            // Calculate position at the boundary
            let boundaryPos = containerStart;
            for (let i = 0; i < indexAfter; i++) {
              boundaryPos += container.child(i).nodeSize;
            }

            // Check if there's already an empty paragraph adjacent
            if (
              nodeBefore?.type.name === "paragraph" &&
              nodeBefore.content.size === 0
            ) {
              const insidePos = boundaryPos - nodeBefore.nodeSize + 1;
              const tr = view.state.tr.setSelection(
                TextSelection.create(view.state.doc, insidePos),
              );
              view.dispatch(tr);
              view.focus();
              return true;
            }

            if (
              nodeAfter?.type.name === "paragraph" &&
              nodeAfter.content.size === 0
            ) {
              const insidePos = boundaryPos + 1;
              const tr = view.state.tr.setSelection(
                TextSelection.create(view.state.doc, insidePos),
              );
              view.dispatch(tr);
              view.focus();
              return true;
            }

            // Insert a new empty paragraph at the gap
            const paragraphType = view.state.schema.nodes.paragraph;
            const tr = view.state.tr.insert(
              boundaryPos,
              paragraphType.create(),
            );
            tr.setSelection(TextSelection.create(tr.doc, boundaryPos + 1));

            view.dispatch(tr);
            view.focus();
            return true;
          },
        },
      }),
    ];
  },
});
