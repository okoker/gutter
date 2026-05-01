import { describe, it, expect } from "vitest";
import { parseMarkdown } from "../src/components/Editor/markdown/parser";
import { serializeMarkdown } from "../src/components/Editor/markdown/serializer";

const TEST_FIXTURE = `# Heading 1

## Heading 2

A paragraph with **bold**, *italic*, ~~strikethrough~~, \`inline code\`, and a [link](https://example.com).

- Bullet item 1
- Bullet item 2
  - Nested bullet

1. Ordered item
2. Ordered item

> A blockquote with **bold** inside

\`\`\`javascript
const x = 1;
\`\`\`

![alt text](image.png)

---

Some text with <mark>highlighted</mark><sup>[c1]</sup> content.

A bare <mark>highlight without comment</mark> should survive too.
`;

describe("Markdown Round-Trip", () => {
  it("round-trips the spec test fixture without content loss", () => {
    const doc = parseMarkdown(TEST_FIXTURE);
    const output = serializeMarkdown(doc);

    // Verify key content is preserved
    expect(output).toContain("# Heading 1");
    expect(output).toContain("## Heading 2");
    expect(output).toContain("**bold**");
    expect(output).toContain("*italic*");
    expect(output).toContain("~~strikethrough~~");
    expect(output).toContain("`inline code`");
    expect(output).toContain("[link](https://example.com)");
    expect(output).toContain("- Bullet item 1");
    expect(output).toContain("- Bullet item 2");
    expect(output).toContain("- Nested bullet");
    expect(output).toContain("1. Ordered item");
    expect(output).toContain("2. Ordered item");
    expect(output).toContain("> A blockquote with **bold** inside");
    expect(output).toContain("```javascript\nconst x = 1;\n```");
    expect(output).toContain("![alt text](image.png)");
    expect(output).toContain("---");
    expect(output).toContain("<mark>highlighted</mark><sup>[c1]</sup>");
  });

  it("round-trips task lists", () => {
    const taskMd = `- [ ] unchecked item\n- [x] checked item\n- [ ] another unchecked\n`;
    const doc = parseMarkdown(taskMd);
    const output = serializeMarkdown(doc);
    expect(output).toContain("- [ ] unchecked item");
    expect(output).toContain("- [x] checked item");
    expect(output).toContain("- [ ] another unchecked");

    // Double round-trip
    const doc2 = parseMarkdown(output);
    const output2 = serializeMarkdown(doc2);
    expect(output2).toBe(output);
  });

  it("round-trips twice without change", () => {
    const doc1 = parseMarkdown(TEST_FIXTURE);
    const md1 = serializeMarkdown(doc1);
    const doc2 = parseMarkdown(md1);
    const md2 = serializeMarkdown(doc2);
    expect(md2).toBe(md1);
  });

  describe("blank line preservation", () => {
    it("preserves 1 explicit blank line between paragraphs (1 empty paragraph)", () => {
      // [P1, EmptyP, P2] in editor → 2 blank lines in source ("Para1\n\n\nPara2\n")
      const doc = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Para1" }] },
          { type: "paragraph" },
          { type: "paragraph", content: [{ type: "text", text: "Para2" }] },
        ],
      };
      const md = serializeMarkdown(doc);
      expect(md).toBe("Para1\n\n\nPara2\n");
      const reparsed = parseMarkdown(md);
      // Three paragraph nodes, middle one empty
      expect(reparsed.content?.length).toBe(3);
      expect(reparsed.content?.[0].type).toBe("paragraph");
      expect(reparsed.content?.[1].type).toBe("paragraph");
      expect(reparsed.content?.[1].content).toBeUndefined();
      expect(reparsed.content?.[2].type).toBe("paragraph");
      // Double round-trip stable
      expect(serializeMarkdown(reparsed)).toBe(md);
    });

    it("preserves 2 explicit blank lines between paragraphs (2 empty paragraphs)", () => {
      const doc = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Para1" }] },
          { type: "paragraph" },
          { type: "paragraph" },
          { type: "paragraph", content: [{ type: "text", text: "Para2" }] },
        ],
      };
      const md = serializeMarkdown(doc);
      expect(md).toBe("Para1\n\n\n\nPara2\n");
      const reparsed = parseMarkdown(md);
      expect(reparsed.content?.length).toBe(4);
      expect(reparsed.content?.[1].content).toBeUndefined();
      expect(reparsed.content?.[2].content).toBeUndefined();
      expect(serializeMarkdown(reparsed)).toBe(md);
    });

    it("preserves trailing empty paragraph", () => {
      const doc = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Para1" }] },
          { type: "paragraph" },
        ],
      };
      const md = serializeMarkdown(doc);
      expect(md).toBe("Para1\n\n");
      const reparsed = parseMarkdown(md);
      expect(reparsed.content?.length).toBe(2);
      expect(reparsed.content?.[1].content).toBeUndefined();
      expect(serializeMarkdown(reparsed)).toBe(md);
    });

    it("preserves blank line between two checkboxes (splits the task list)", () => {
      // Source: 2 blank lines between checkbox items. CommonMark merges these
      // into a single loose task list, so we split it back into two task
      // lists with an empty paragraph between to recover the user-typed gap.
      const md = "- [ ] one\n\n\n- [ ] two\n";
      const doc = parseMarkdown(md);
      const types = doc.content?.map((n) => n.type) ?? [];
      expect(types).toEqual(["taskList", "paragraph", "taskList"]);
      const md2 = serializeMarkdown(doc);
      expect(md2).toBe(md);
    });

    it("preserves blank line between two bullet items (splits the list)", () => {
      const md = "- one\n\n\n- two\n";
      const doc = parseMarkdown(md);
      const types = doc.content?.map((n) => n.type) ?? [];
      expect(types).toEqual(["bulletList", "paragraph", "bulletList"]);
      const md2 = serializeMarkdown(doc);
      expect(md2).toBe(md);
    });

    it("preserves blank lines between ordered list items (splits, continues numbering)", () => {
      const md = "1. one\n\n\n2. two\n";
      const doc = parseMarkdown(md);
      const types = doc.content?.map((n) => n.type) ?? [];
      expect(types).toEqual(["orderedList", "paragraph", "orderedList"]);
      // Second list should start at 2 to match the source "2."
      const secondList = doc.content?.[2];
      expect(secondList?.attrs?.start).toBe(2);
      const md2 = serializeMarkdown(doc);
      expect(md2).toBe(md);
    });

    it("tight list (no blank lines between items) stays as one list", () => {
      const md = "- one\n- two\n";
      const doc = parseMarkdown(md);
      const types = doc.content?.map((n) => n.type) ?? [];
      expect(types).toEqual(["bulletList"]);
      expect(serializeMarkdown(doc)).toBe(md);
    });

    it("standard 1-blank-line gap stays untouched", () => {
      // [P1, P2] (no empty paragraph) — standard adjacent paragraphs.
      const doc = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Para1" }] },
          { type: "paragraph", content: [{ type: "text", text: "Para2" }] },
        ],
      };
      const md = serializeMarkdown(doc);
      expect(md).toBe("Para1\n\nPara2\n");
      const reparsed = parseMarkdown(md);
      expect(reparsed.content?.length).toBe(2);
      expect(serializeMarkdown(reparsed)).toBe(md);
    });
  });
});
