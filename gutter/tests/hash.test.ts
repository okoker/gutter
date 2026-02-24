// gutter/tests/hash.test.ts
import { describe, it, expect } from "vitest";
import { hashContent } from "../src/utils/hash";

describe("hashContent", () => {
  it("returns consistent hash for same content", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello world");
    expect(h1).toBe(h2);
  });

  it("returns different hash for different content", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello world!");
    expect(h1).not.toBe(h2);
  });

  it("normalizes line endings before hashing", () => {
    const h1 = hashContent("line1\nline2");
    const h2 = hashContent("line1\r\nline2");
    expect(h1).toBe(h2);
  });

  it("handles empty string", () => {
    const h = hashContent("");
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });
});
