import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { useSnippetStore } from "../src/stores/snippetStore";

function resetStore() {
  useSnippetStore.setState({ snippets: [], loaded: false });
}

const rawA = { filename: "a.md", path: "/tmp/snippets/a.md", preview: "# A", modified_ms: 2000 };
const rawB = { filename: "b.md", path: "/tmp/snippets/b.md", preview: "# B", modified_ms: 1000 };

describe("Snippet store", () => {
  beforeEach(() => {
    resetStore();
    invokeMock.mockReset();
  });

  it("loadSnippets populates list and sets loaded", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "ensure_snippets_dir") return Promise.resolve("/tmp/snippets");
      if (cmd === "list_snippets") return Promise.resolve([rawA, rawB]);
      return Promise.resolve();
    });
    await useSnippetStore.getState().loadSnippets();
    const s = useSnippetStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.snippets).toHaveLength(2);
    expect(s.snippets[0].filename).toBe("a.md");
    expect(s.snippets[0].modifiedMs).toBe(2000);
  });

  it("loadSnippets tolerates failure: sets loaded, empties list", async () => {
    invokeMock.mockImplementation(() => Promise.reject("nope"));
    await useSnippetStore.getState().loadSnippets();
    const s = useSnippetStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.snippets).toEqual([]);
  });

  it("refreshSnippets replaces list", async () => {
    useSnippetStore.setState({ snippets: [{ filename: "old", path: "/tmp/old", preview: "", modifiedMs: 0 }] });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_snippets") return Promise.resolve([rawA]);
      return Promise.resolve();
    });
    await useSnippetStore.getState().refreshSnippets();
    const s = useSnippetStore.getState();
    expect(s.snippets).toHaveLength(1);
    expect(s.snippets[0].filename).toBe("a.md");
  });

  it("saveNewSnippet calls invoke + refresh, returns path", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "save_snippet") return Promise.resolve(`/tmp/snippets/${args?.filename}`);
      if (cmd === "list_snippets") return Promise.resolve([rawA]);
      return Promise.resolve();
    });
    const path = await useSnippetStore.getState().saveNewSnippet("a.md", "hi");
    expect(path).toBe("/tmp/snippets/a.md");
    expect(useSnippetStore.getState().snippets).toHaveLength(1);
  });

  it("removeSnippet invokes delete + refreshes", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "delete_snippet") return Promise.resolve();
      if (cmd === "list_snippets") return Promise.resolve([]);
      return Promise.resolve();
    });
    await useSnippetStore.getState().removeSnippet("/tmp/snippets/a.md");
    expect(useSnippetStore.getState().snippets).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("delete_snippet", { path: "/tmp/snippets/a.md" });
  });

  it("renameSnippet invokes rename + refreshes, returns new path", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "rename_snippet")
        return Promise.resolve(`/tmp/snippets/${args?.newFilename}`);
      if (cmd === "list_snippets") return Promise.resolve([rawA]);
      return Promise.resolve();
    });
    const newPath = await useSnippetStore
      .getState()
      .renameSnippet("/tmp/snippets/old.md", "new.md");
    expect(newPath).toBe("/tmp/snippets/new.md");
  });
});
