import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Node as UnistNode } from "unist";
import type { JSONContent } from "@tiptap/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { joinPath, normalizePath, isImageFile, resolveFileInTree } from "../../../utils/path";
import { useWorkspaceStore } from "../../../stores/workspaceStore";

interface MdastNode extends UnistNode {
  children?: MdastNode[];
  value?: string;
  url?: string;
  alt?: string;
  title?: string;
  lang?: string;
  meta?: string;
  ordered?: boolean;
  start?: number;
  depth?: number;
  checked?: boolean | null;
  align?: (string | null)[];
}

const COMMENT_MARKER_RE =
  /<mark>([\s\S]*?)<\/mark><sup>\[c(\d+)\]<\/sup>/g;

export function parseMarkdown(markdown: string, fileDirPath?: string): JSONContent {
  // Extract frontmatter before parsing
  let frontmatterContent: string | null = null;
  let body = markdown;
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    frontmatterContent = fmMatch[1];
    body = fmMatch[2];
  }

  // Convert Obsidian wiki image embeds to standard markdown images before parsing
  body = convertWikiImageEmbeds(body);

  // Extract math blocks before parsing (remark doesn't handle $$)
  const { cleaned, mathBlocks } = extractMathBlocks(body);

  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(cleaned) as MdastNode;
  const content = convertChildren(tree);

  // Re-insert math blocks
  const result = reinsertMathBlocks(content, mathBlocks);

  // Preserve trailing blank lines as empty paragraphs. Source ending in "\n"
  // is the standard "file ends cleanly"; each additional trailing newline
  // beyond that represents one blank line the user typed at the end of the
  // doc, which round-trips as an empty paragraph.
  const trailingMatch = cleaned.match(/\n*$/);
  const trailingNewlines = trailingMatch ? trailingMatch[0].length : 0;
  const trailingEmpties = Math.max(0, trailingNewlines - 1);
  for (let i = 0; i < trailingEmpties; i++) {
    result.push({ type: "paragraph" });
  }

  // Wrap headings + their following content into nested section nodes for
  // collapse/expand. The wrap is purely an in-memory tree transform; the
  // serializer flattens sections back so on-disk markdown is unchanged.
  const wrapped = wrapSections(result);

  // Prepend frontmatter node if present
  const docContent: JSONContent[] = [];
  if (frontmatterContent !== null) {
    docContent.push({
      type: "frontmatter",
      attrs: { content: frontmatterContent },
    });
  }
  docContent.push(...wrapped);

  const doc: JSONContent = {
    type: "doc",
    content: docContent.length > 0 ? docContent : [{ type: "paragraph" }],
  };

  // Resolve relative image paths to Tauri asset URLs for display
  if (fileDirPath) {
    resolveImagePaths(doc, fileDirPath);
  }

  return doc;
}

/**
 * Wrap each heading + its following content into nested section nodes.
 * Sections nest by heading level: an H1 section contains H2 sections inside it,
 * which contain H3 sections, etc. Content before the first heading stays loose
 * at the top level (it has no heading to attach a chevron to).
 *
 * Markdown is flat — there's no concept of "this paragraph belongs to that
 * heading" in the source. This pass reconstructs the implicit hierarchy.
 *
 * The serializer's flattenSections inverse undoes this so files on disk are
 * unchanged.
 */
function wrapSections(blocks: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  let i = 0;

  while (i < blocks.length && blocks[i].type !== "heading") {
    out.push(blocks[i]);
    i++;
  }

  while (i < blocks.length) {
    const heading = blocks[i];
    if (heading.type !== "heading") {
      out.push(heading);
      i++;
      continue;
    }
    const level = heading.attrs?.level || 1;
    const body: JSONContent[] = [];
    let j = i + 1;
    while (j < blocks.length) {
      const b = blocks[j];
      if (b.type === "heading" && (b.attrs?.level || 1) <= level) break;
      body.push(b);
      j++;
    }
    out.push({
      type: "section",
      content: [heading, ...wrapSections(body)],
    });
    i = j;
  }

  return out;
}

/**
 * Convert Obsidian wiki image embeds ![[image.png]] to standard markdown images.
 * Supports optional alt text via pipe: ![[image.png|alt text]]
 * Only converts when the target is an image file; non-image embeds are left as-is.
 * Appends #wiki-embed fragment so resolveImagePaths can set the wikiEmbed flag.
 */
function convertWikiImageEmbeds(md: string): string {
  return md.replace(/!\[\[([^\]]+)\]\]/g, (original, inner: string) => {
    const pipeIdx = inner.indexOf("|");
    const target = pipeIdx >= 0 ? inner.substring(0, pipeIdx).trim() : inner.trim();
    const alt = pipeIdx >= 0 ? inner.substring(pipeIdx + 1).trim() : "";
    if (isImageFile(target)) {
      return `![${alt}](<${target}#wiki-embed>)`;
    }
    return original;
  });
}

/** Returns true for URLs and absolute filesystem paths that should not be resolved */
function isAbsoluteSrc(src: string): boolean {
  // URLs and data/blob URIs
  if (/^(https?:|data:|blob:|asset:)/.test(src)) return true;
  // Already-resolved Tauri asset URLs
  if (src.includes("asset.localhost")) return true;
  // Absolute Unix paths
  if (src.startsWith("/")) return true;
  // Absolute Windows paths (C:\, D:\, etc.)
  if (/^[a-zA-Z]:[/\\]/.test(src)) return true;
  return false;
}

/**
 * Search the workspace file tree for a file matching the given name.
 * Uses the same "shortest path wins" strategy as wiki link resolution.
 */
function resolveFileInWorkspace(target: string): string | null {
  const { fileTree } = useWorkspaceStore.getState();
  if (!fileTree.length) return null;
  return resolveFileInTree(target, fileTree);
}

/** Walk the doc tree and convert relative image src to Tauri asset URLs */
function resolveImagePaths(node: JSONContent, dirPath: string) {
  if (node.type === "image" && node.attrs?.src) {
    let src = node.attrs.src as string;
    // Detect wiki-embed marker from convertWikiImageEmbeds
    if (src.endsWith("#wiki-embed")) {
      src = src.slice(0, -"#wiki-embed".length);
      node.attrs.src = src;
      node.attrs.wikiEmbed = true;
      // Wiki embeds resolve by searching the workspace (like wiki links)
      const resolved = resolveFileInWorkspace(src);
      if (resolved) {
        node.attrs.originalSrc = src;
        const resolvedNorm = resolved.replace(/\\/g, "/");
        node.attrs.filePath = resolvedNorm;
        node.attrs.src = convertFileSrc(resolvedNorm);
        return; // skip the relative-path fallback below
      }
    }
    if (src && !isAbsoluteSrc(src)) {
      // Store original relative path for round-trip serialization
      node.attrs.originalSrc = src;
      // Decode URL-encoded characters before path operations — remark-parse preserves
      // percent-encoding from markdown (e.g. %20 for spaces), which convertFileSrc
      // would double-encode into %2520
      let decoded: string;
      try { decoded = decodeURIComponent(src); } catch { decoded = src; }
      // Try workspace-wide resolution first (Obsidian-style: images can be anywhere
      // in the vault, not necessarily relative to the current file)
      let searchTarget = decoded;
      // Strip leading ./ for workspace search — ./assets/img.png → assets/img.png
      if (searchTarget.startsWith("./")) searchTarget = searchTarget.slice(2);
      const workspaceResolved = resolveFileInWorkspace(searchTarget);
      if (workspaceResolved) {
        const resolvedNorm = workspaceResolved.replace(/\\/g, "/");
        node.attrs.filePath = resolvedNorm;
        node.attrs.src = convertFileSrc(resolvedNorm);
      } else {
        // Fallback: resolve relative to current file's directory
        const normalizedDir = dirPath.replace(/\\/g, "/");
        const absolute = normalizePath(joinPath(normalizedDir, decoded));
        node.attrs.filePath = absolute;
        node.attrs.src = convertFileSrc(absolute);
      }
    }
  }
  if (node.content) {
    for (const child of node.content) {
      resolveImagePaths(child, dirPath);
    }
  }
}

function extractMathBlocks(md: string): {
  cleaned: string;
  mathBlocks: Map<string, string>;
} {
  const mathBlocks = new Map<string, string>();
  let counter = 0;
  const cleaned = md.replace(/\$\$([\s\S]*?)\$\$/g, (_match, latex) => {
    const placeholder = `MATH_BLOCK_${counter++}`;
    mathBlocks.set(placeholder, latex.trim());
    return placeholder;
  });
  return { cleaned, mathBlocks };
}

function reinsertMathBlocks(
  content: JSONContent[],
  mathBlocks: Map<string, string>,
): JSONContent[] {
  if (mathBlocks.size === 0) return content;
  return content.map((node) => {
    if (node.type === "paragraph" && node.content?.length === 1) {
      const text = node.content[0].text || "";
      const match = text.match(/^MATH_BLOCK_(\d+)$/);
      if (match) {
        const placeholder = `MATH_BLOCK_${match[1]}`;
        const latex = mathBlocks.get(placeholder);
        if (latex !== undefined) {
          return { type: "mathBlock", attrs: { latex } };
        }
      }
    }
    if (node.content) {
      return { ...node, content: reinsertMathBlocks(node.content, mathBlocks) };
    }
    return node;
  });
}

function convertChildren(node: MdastNode): JSONContent[] {
  if (!node.children) return [];
  const result: JSONContent[] = [];
  // Preserve extra blank lines between block siblings as empty paragraphs.
  // CommonMark collapses any number of blank lines into a single block
  // separator; we recover the user-typed count from mdast position info.
  // For a gap of N blank lines (N >= 2 ⇒ user added extra blanks beyond
  // the standard 1), insert (N - 1) empty paragraphs.
  const isTopLevel = node.type === "root";
  let prevEndLine: number | undefined;
  for (const child of node.children) {
    if (
      isTopLevel &&
      prevEndLine !== undefined &&
      child.position?.start.line !== undefined
    ) {
      const blankLines = child.position.start.line - prevEndLine - 1;
      const extra = Math.max(0, blankLines - 1);
      for (let i = 0; i < extra; i++) {
        result.push({ type: "paragraph" });
      }
    }
    const converted = convertNode(child);
    if (converted) {
      if (Array.isArray(converted)) {
        result.push(...converted);
      } else {
        result.push(converted);
      }
    }
    if (child.position?.end.line !== undefined) {
      prevEndLine = child.position.end.line;
    }
  }
  return result;
}

function convertNode(node: MdastNode): JSONContent | JSONContent[] | null {
  switch (node.type) {
    case "heading":
      return {
        type: "heading",
        attrs: { level: node.depth || 1 },
        content: convertInlineChildren(node),
      };

    case "paragraph": {
      const inlineContent = convertInlineChildren(node);
      if (!inlineContent || inlineContent.length === 0) {
        return { type: "paragraph" };
      }
      return { type: "paragraph", content: inlineContent };
    }

    case "blockquote":
      return {
        type: "blockquote",
        content: convertChildren(node),
      };

    case "list": {
      // Check if any child is a task item (has checked !== null/undefined)
      const isTaskList = node.children?.some(
        (child) => child.checked !== null && child.checked !== undefined,
      );
      const items = node.children ?? [];

      // Split the list at points where adjacent items have an extra
      // blank-line gap (≥ 2 blank lines). CommonMark/remark merges items
      // separated by blank lines into a single "loose" list, absorbing the
      // gap; we recover the user-typed gap by splitting back into multiple
      // lists with empty paragraphs between them.
      const segments: Array<{ items: MdastNode[]; emptiesAfter: number }> = [];
      let current: MdastNode[] = [];
      for (let i = 0; i < items.length; i++) {
        current.push(items[i]);
        if (i + 1 < items.length) {
          const a = items[i];
          const b = items[i + 1];
          const aEnd = a.position?.end.line;
          const bStart = b.position?.start.line;
          if (aEnd !== undefined && bStart !== undefined) {
            const blankLines = bStart - aEnd - 1;
            if (blankLines >= 2) {
              segments.push({ items: current, emptiesAfter: blankLines - 1 });
              current = [];
            }
          }
        }
      }
      if (current.length > 0) {
        segments.push({ items: current, emptiesAfter: 0 });
      }

      const buildList = (segItems: MdastNode[], startOverride?: number) => {
        const itemContent: JSONContent[] = [];
        for (const it of segItems) {
          const conv = convertNode(it);
          if (conv) {
            if (Array.isArray(conv)) itemContent.push(...conv);
            else itemContent.push(conv);
          }
        }
        if (isTaskList) {
          return { type: "taskList", content: itemContent };
        }
        return {
          type: node.ordered ? "orderedList" : "bulletList",
          attrs: node.ordered
            ? { start: startOverride ?? node.start ?? 1 }
            : undefined,
          content: itemContent,
        };
      };

      if (segments.length === 1) {
        return buildList(segments[0].items);
      }

      // Multi-segment: emit list, empty paragraphs, list, ... so the doc
      // root sees them as separate sibling blocks.
      const out: JSONContent[] = [];
      let runningCount = node.start ?? 1;
      for (let s = 0; s < segments.length; s++) {
        out.push(buildList(segments[s].items, runningCount));
        runningCount += segments[s].items.length;
        for (let e = 0; e < segments[s].emptiesAfter; e++) {
          out.push({ type: "paragraph" });
        }
      }
      return out;
    }

    case "listItem": {
      const content = convertChildren(node);
      if (node.checked !== null && node.checked !== undefined) {
        return {
          type: "taskItem",
          attrs: { checked: node.checked },
          content: content.length > 0 ? content : [{ type: "paragraph" }],
        };
      }
      return {
        type: "listItem",
        content: content.length > 0 ? content : [{ type: "paragraph" }],
      };
    }

    case "code":
      // Mermaid code blocks become mermaidBlock nodes
      if (node.lang === "mermaid") {
        return {
          type: "mermaidBlock",
          attrs: { code: node.value || "" },
        };
      }
      return {
        type: "codeBlock",
        attrs: { language: node.lang || null },
        content: node.value ? [{ type: "text", text: node.value }] : [],
      };

    case "thematicBreak":
      return { type: "horizontalRule" };

    case "image":
      return {
        type: "image",
        attrs: {
          src: node.url || "",
          alt: node.alt || null,
          title: node.title || null,
        },
      };

    case "table":
      return convertTable(node);

    case "html":
      return convertHtmlBlock(node);

    default:
      return null;
  }
}

/**
 * Convert inline children, detecting comment marker patterns across
 * adjacent nodes: <mark> + text + </mark> + <sup> + [cN] + </sup>
 */
function convertInlineChildren(node: MdastNode): JSONContent[] | undefined {
  if (!node.children || node.children.length === 0) return undefined;

  const children = node.children;
  const result: JSONContent[] = [];
  let i = 0;

  while (i < children.length) {
    // Try to match comment marker pattern: <mark> text </mark><sup>[cN]</sup>
    // remark splits this into: html(<mark>), text(content), html(</mark>), html(<sup>), text([cN]), html(</sup>)
    const markerResult = tryMatchCommentMarker(children, i);
    if (markerResult) {
      result.push(...markerResult.nodes);
      i = markerResult.nextIndex;
      continue;
    }

    // Try to match bare <mark>text</mark> (no comment ID)
    const bareMarkResult = tryMatchBareMark(children, i);
    if (bareMarkResult) {
      result.push(...bareMarkResult.nodes);
      i = bareMarkResult.nextIndex;
      continue;
    }

    const converted = convertInlineNode(children[i]);
    if (converted) {
      if (Array.isArray(converted)) {
        result.push(...converted);
      } else {
        result.push(converted);
      }
    }
    i++;
  }

  return result.length > 0 ? result : undefined;
}

function tryMatchCommentMarker(
  children: MdastNode[],
  start: number,
): { nodes: JSONContent[]; nextIndex: number } | null {
  // Pattern: html(<mark>) ...content... html(</mark>) html(<sup>) text([cN]) html(</sup>)
  // Content between <mark> and </mark> can be text, strong, emphasis, etc.
  const n0 = children[start];
  if (n0.type !== "html" || n0.value !== "<mark>") return null;

  // Find </mark> close tag
  let closeMarkIdx = -1;
  for (let j = start + 1; j < children.length; j++) {
    if (children[j].type === "html" && children[j].value === "</mark>") {
      closeMarkIdx = j;
      break;
    }
  }
  if (closeMarkIdx === -1) return null;

  // After </mark>, expect <sup>[cN]</sup>
  if (closeMarkIdx + 3 >= children.length) return null;
  const nSup = children[closeMarkIdx + 1];
  const nId = children[closeMarkIdx + 2];
  const nSupClose = children[closeMarkIdx + 3];

  if (
    nSup.type !== "html" || nSup.value !== "<sup>" ||
    nId.type !== "text" || !nId.value ||
    nSupClose.type !== "html" || nSupClose.value !== "</sup>"
  ) return null;

  const idMatch = nId.value.match(/^\[c(\d+)\]$/);
  if (!idMatch) return null;

  const commentId = `c${idMatch[1]}`;
  const commentMarkObj = { type: "commentMark", attrs: { commentId } };

  // Convert all nodes between <mark> and </mark>
  const innerNodes = children.slice(start + 1, closeMarkIdx);
  const converted: JSONContent[] = [];
  for (const inner of innerNodes) {
    const c = convertInlineNode(inner);
    if (c) {
      if (Array.isArray(c)) {
        converted.push(...c);
      } else {
        converted.push(c);
      }
    }
  }

  // Add commentMark to each converted node
  const marked = converted.map((n) => addMark(n, commentMarkObj));

  return {
    nodes: marked.length > 0 ? marked : [{ type: "text", text: "", marks: [commentMarkObj] as JSONContent["marks"] }],
    nextIndex: closeMarkIdx + 4,
  };
}

function tryMatchBareMark(
  children: MdastNode[],
  start: number,
): { nodes: JSONContent[]; nextIndex: number } | null {
  // Pattern: html(<mark>) text html(</mark>) — without following <sup>[cN]</sup>
  if (start + 2 >= children.length) return null;

  const n0 = children[start];
  const n1 = children[start + 1];
  const n2 = children[start + 2];

  if (
    n0.type === "html" && n0.value === "<mark>" &&
    n1.type === "text" && n1.value &&
    n2.type === "html" && n2.value === "</mark>"
  ) {
    // Check if this is NOT followed by a comment sup
    const isComment = tryMatchCommentMarker(children, start) !== null;
    if (!isComment) {
      return {
        nodes: [
          { type: "text", text: "<mark>" },
          { type: "text", text: n1.value },
          { type: "text", text: "</mark>" },
        ],
        nextIndex: start + 3,
      };
    }
  }

  return null;
}

/** Split a text string on $...$ patterns, producing text nodes and mathInline nodes */
function extractInlineMath(text: string): JSONContent | JSONContent[] {
  // Match $...$ but not $$...$$ (block math) and not escaped \$
  // The content must not start/end with space and must be non-empty
  const re = /(?<!\$)\$(?!\$)([^\s$][^$]*?[^\s$]|[^\s$])\$(?!\$)/g;
  const parts: JSONContent[] = [];
  let lastIndex = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "mathInline", attrs: { latex: match[1] } });
    lastIndex = re.lastIndex;
  }

  if (parts.length === 0) {
    return { type: "text", text };
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", text: text.slice(lastIndex) });
  }

  return parts;
}

function convertInlineNode(node: MdastNode): JSONContent | JSONContent[] | null {
  switch (node.type) {
    case "text":
      if (!node.value) return null;
      return extractInlineMath(node.value);

    case "strong": {
      const children = convertInlineChildren(node);
      if (!children) return null;
      return children.map((child) => addMark(child, { type: "bold" }));
    }

    case "emphasis": {
      const children = convertInlineChildren(node);
      if (!children) return null;
      return children.map((child) => addMark(child, { type: "italic" }));
    }

    case "delete": {
      const children = convertInlineChildren(node);
      if (!children) return null;
      return children.map((child) => addMark(child, { type: "strike" }));
    }

    case "inlineCode":
      return {
        type: "text",
        text: node.value || "",
        marks: [{ type: "code" }],
      };

    case "link": {
      const children = convertInlineChildren(node);
      if (!children) return null;
      const linkMark = {
        type: "link",
        attrs: {
          href: node.url || "",
          target: "_blank",
          rel: "noopener noreferrer",
          class: null,
        },
      };
      return children.map((child) => addMark(child, linkMark));
    }

    case "image":
      return {
        type: "image",
        attrs: {
          src: node.url || "",
          alt: node.alt || null,
          title: node.title || null,
        },
      };

    case "html":
      // Single HTML tag that wasn't caught by the multi-node pattern matcher
      return { type: "text", text: node.value || "" };

    case "break":
      return { type: "hardBreak" };

    default:
      return null;
  }
}

function addMark(node: JSONContent, mark: Record<string, unknown>): JSONContent {
  const existingMarks = (node.marks || []) as Record<string, unknown>[];
  return {
    ...node,
    marks: [...existingMarks, mark] as JSONContent["marks"],
  };
}

function convertHtmlBlock(node: MdastNode): JSONContent | JSONContent[] | null {
  const html = (node.value || "").trim();

  const markers: JSONContent[] = [];
  let lastIndex = 0;
  let match;
  const re = new RegExp(COMMENT_MARKER_RE.source, "g");

  while ((match = re.exec(html)) !== null) {
    if (match.index > lastIndex) {
      const before = html.slice(lastIndex, match.index).trim();
      if (before) {
        markers.push({ type: "text", text: before });
      }
    }
    markers.push({
      type: "text",
      text: match[1],
      marks: [
        { type: "commentMark", attrs: { commentId: `c${match[2]}` } },
      ],
    });
    lastIndex = re.lastIndex;
  }

  if (markers.length > 0) {
    if (lastIndex < html.length) {
      const after = html.slice(lastIndex).trim();
      if (after) {
        markers.push({ type: "text", text: after });
      }
    }
    return { type: "paragraph", content: markers };
  }

  return {
    type: "paragraph",
    content: [{ type: "text", text: html }],
  };
}

function convertTable(node: MdastNode): JSONContent | null {
  if (!node.children) return null;

  const rows: JSONContent[] = [];

  for (let i = 0; i < node.children.length; i++) {
    const row = node.children[i];
    if (row.type !== "tableRow" || !row.children) continue;

    const cells: JSONContent[] = [];
    for (const cell of row.children) {
      const cellType = i === 0 ? "tableHeader" : "tableCell";
      const content = convertInlineChildren(cell);
      cells.push({
        type: cellType,
        content: [
          {
            type: "paragraph",
            content: content,
          },
        ],
      });
    }

    rows.push({ type: "tableRow", content: cells });
  }

  return {
    type: "table",
    content: rows,
  };
}
