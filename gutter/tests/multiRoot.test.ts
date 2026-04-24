import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock Tauri IPC before importing the store.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

// Toast store is called from addRoot — stub so it doesn't throw in the test env.
vi.mock("../src/stores/toastStore", () => ({
  useToastStore: {
    getState: () => ({ addToast: vi.fn() }),
  },
}));

// Import after mocks are in place.
import { useWorkspaceStore } from "../src/stores/workspaceStore";

function resetStore() {
  useWorkspaceStore.setState({
    roots: [],
    activeRootPath: null,
    workspacePath: null,
    fileTree: [],
    openTabs: [],
    activeTabPath: null,
  });
}

function setupInvokeMock() {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "canonicalize_path") return Promise.resolve(args?.path as string);
    if (cmd === "read_directory") {
      const p = args?.path as string;
      return Promise.resolve([
        { name: "README.md", path: `${p}/README.md`, is_dir: false, children: null },
      ]);
    }
    if (cmd === "start_watcher") return Promise.resolve();
    if (cmd === "stop_watcher") return Promise.resolve();
    return Promise.resolve(undefined);
  });
}

describe("Multi-root workspace store", () => {
  beforeEach(() => {
    resetStore();
    setupInvokeMock();
  });

  it("addRoot once: sets active to the new root and mirrors workspacePath/fileTree", async () => {
    await useWorkspaceStore.getState().addRoot("/tmp/a");
    const s = useWorkspaceStore.getState();
    expect(s.roots).toHaveLength(1);
    expect(s.activeRootPath).toBe("/tmp/a");
    expect(s.workspacePath).toBe("/tmp/a");
    expect(s.fileTree).toHaveLength(1);
    expect(s.fileTree[0].path).toBe("/tmp/a/README.md");
  });

  it("addRoot twice: activeRootPath stays on first-added", async () => {
    await useWorkspaceStore.getState().addRoot("/tmp/a");
    await useWorkspaceStore.getState().addRoot("/tmp/b");
    const s = useWorkspaceStore.getState();
    expect(s.roots).toHaveLength(2);
    expect(s.activeRootPath).toBe("/tmp/a");
    expect(s.workspacePath).toBe("/tmp/a");
  });

  it("addRoot duplicate: no duplicate row, active promotes to that path", async () => {
    await useWorkspaceStore.getState().addRoot("/tmp/a");
    await useWorkspaceStore.getState().addRoot("/tmp/b");
    await useWorkspaceStore.getState().addRoot("/tmp/b"); // duplicate
    const s = useWorkspaceStore.getState();
    expect(s.roots).toHaveLength(2);
    expect(s.activeRootPath).toBe("/tmp/b");
    expect(s.workspacePath).toBe("/tmp/b");
  });

  it("removeRoot active: promotes next root to active", async () => {
    await useWorkspaceStore.getState().addRoot("/tmp/a");
    await useWorkspaceStore.getState().addRoot("/tmp/b");
    useWorkspaceStore.getState().removeRoot("/tmp/a");
    const s = useWorkspaceStore.getState();
    expect(s.roots).toHaveLength(1);
    expect(s.activeRootPath).toBe("/tmp/b");
    expect(s.workspacePath).toBe("/tmp/b");
  });

  it("removeRoot all: activeRootPath null, fileTree empty", async () => {
    await useWorkspaceStore.getState().addRoot("/tmp/a");
    useWorkspaceStore.getState().removeRoot("/tmp/a");
    const s = useWorkspaceStore.getState();
    expect(s.roots).toHaveLength(0);
    expect(s.activeRootPath).toBeNull();
    expect(s.workspacePath).toBeNull();
    expect(s.fileTree).toEqual([]);
  });

  it("loadRootTree: only that root's tree updates", async () => {
    await useWorkspaceStore.getState().addRoot("/tmp/a");
    await useWorkspaceStore.getState().addRoot("/tmp/b");

    // Change mock to return different content on next read_directory for /tmp/a
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "canonicalize_path") return Promise.resolve(args?.path as string);
      if (cmd === "read_directory") {
        const p = args?.path as string;
        if (p === "/tmp/a") {
          return Promise.resolve([
            { name: "CHANGELOG.md", path: "/tmp/a/CHANGELOG.md", is_dir: false, children: null },
            { name: "README.md", path: "/tmp/a/README.md", is_dir: false, children: null },
          ]);
        }
        return Promise.resolve([
          { name: "README.md", path: `${p}/README.md`, is_dir: false, children: null },
        ]);
      }
      return Promise.resolve();
    });

    await useWorkspaceStore.getState().loadRootTree("/tmp/a");
    const s = useWorkspaceStore.getState();
    expect(s.roots[0].tree).toHaveLength(2);
    expect(s.roots[1].tree).toHaveLength(1);
  });

  it("loadFileTree compat facade: unknown path adds as new root", async () => {
    await useWorkspaceStore.getState().addRoot("/tmp/a");
    // loadFileTree(unknownPath) should call addRoot, growing roots.
    await useWorkspaceStore.getState().loadFileTree("/tmp/c");
    const s = useWorkspaceStore.getState();
    expect(s.roots).toHaveLength(2);
    expect(s.roots.map((r) => r.path).sort()).toEqual(["/tmp/a", "/tmp/c"]);
  });

  it("loadFileTree compat facade: known path refreshes tree without adding root", async () => {
    await useWorkspaceStore.getState().addRoot("/tmp/a");
    await useWorkspaceStore.getState().loadFileTree("/tmp/a");
    const s = useWorkspaceStore.getState();
    expect(s.roots).toHaveLength(1);
  });
});
