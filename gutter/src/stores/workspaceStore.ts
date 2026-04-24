import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { fileName as pathBasename } from "../utils/path";
import { useToastStore } from "./toastStore";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileEntry[] | null;
}

export interface OpenTab {
  path: string;
  name: string;
  isDirty: boolean;
  isPinned: boolean;
  diskHash: string | null;
  externallyModified: boolean;
}

export interface WorkspaceRoot {
  path: string;           // canonical absolute path
  name: string;           // display (basename)
  tree: FileEntry[];
  expanded: boolean;
}

interface WorkspaceState {
  roots: WorkspaceRoot[];
  activeRootPath: string | null;

  // Backward-compat mirrors — kept in sync by every roots-mutating action via
  // computeCompat(). Deprecated but still consumed by 20+ call sites. Cross-root
  // enumeration deferred to Feature #3.5.
  workspacePath: string | null;
  fileTree: FileEntry[];

  openTabs: OpenTab[];
  activeTabPath: string | null;

  addRoot: (rawPath: string) => Promise<void>;
  removeRoot: (path: string) => void;
  loadRootTree: (path: string) => Promise<void>;
  setRootExpanded: (path: string, expanded: boolean) => void;

  // Compat facade: existing callers use loadFileTree(path) after file ops.
  // If `path` is an existing root, refresh its tree; else add as a new root.
  loadFileTree: (path: string) => Promise<void>;

  // Tab actions (unchanged semantics)
  addTab: (path: string, name: string) => void;
  removeTab: (path: string) => void;
  setActiveTab: (path: string | null) => void;
  setTabDirty: (path: string, dirty: boolean) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  pinTab: (path: string) => void;
  unpinTab: (path: string) => void;
  updateTabPath: (oldPath: string, newPath: string, newName: string) => void;
  setTabDiskHash: (path: string, hash: string | null) => void;
  setTabExternallyModified: (path: string, modified: boolean) => void;
  getTab: (path: string) => OpenTab | undefined;
}

function computeCompat(
  roots: WorkspaceRoot[],
  activeRootPath: string | null,
): { workspacePath: string | null; fileTree: FileEntry[] } {
  const active = activeRootPath
    ? roots.find((r) => r.path === activeRootPath)
    : roots[0];
  return {
    workspacePath: active?.path ?? null,
    fileTree: active?.tree ?? [],
  };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  roots: [],
  activeRootPath: null,
  workspacePath: null,
  fileTree: [],
  openTabs: [],
  activeTabPath: null,

  addRoot: async (rawPath: string) => {
    // canonicalize_path requires the path to exist on disk. Surface failures
    // (missing path / TCC denied / unmounted volume) via toast and rethrow so
    // the caller can decide what to do.
    let path: string;
    try {
      path = await invoke<string>("canonicalize_path", { path: rawPath });
    } catch (e) {
      useToastStore.getState().addToast(`Could not open folder: ${rawPath}`, "error");
      throw e;
    }

    // Duplicate — promote to active and inform the user.
    if (get().roots.some((r) => r.path === path)) {
      const roots = get().roots;
      set({ activeRootPath: path, ...computeCompat(roots, path) });
      useToastStore.getState().addToast("Folder already in workspace", "info");
      return;
    }

    let tree: FileEntry[];
    try {
      tree = await invoke<FileEntry[]>("read_directory", { path });
    } catch (e) {
      useToastStore.getState().addToast(`Could not read folder: ${path}`, "error");
      throw e;
    }

    const newRoot: WorkspaceRoot = {
      path,
      name: pathBasename(path) || path,
      tree,
      expanded: true,
    };
    const roots = [...get().roots, newRoot];
    const activeRootPath = get().activeRootPath ?? path;
    set({ roots, activeRootPath, ...computeCompat(roots, activeRootPath) });
    await invoke("start_watcher", { path }).catch(console.error);
  },

  removeRoot: (path) => {
    const { roots, activeRootPath } = get();
    const next = roots.filter((r) => r.path !== path);
    const nextActive =
      activeRootPath === path ? (next[0]?.path ?? null) : activeRootPath;
    set({ roots: next, activeRootPath: nextActive, ...computeCompat(next, nextActive) });
    invoke("stop_watcher", { path }).catch(console.error);
  },

  loadRootTree: async (path) => {
    try {
      const tree = await invoke<FileEntry[]>("read_directory", { path });
      const { roots, activeRootPath } = get();
      const next = roots.map((r) => (r.path === path ? { ...r, tree } : r));
      set({ roots: next, ...computeCompat(next, activeRootPath) });
    } catch (e) {
      console.error("Failed to refresh root tree:", e);
    }
  },

  setRootExpanded: (path, expanded) => {
    const { roots, activeRootPath } = get();
    const next = roots.map((r) => (r.path === path ? { ...r, expanded } : r));
    set({ roots: next, ...computeCompat(next, activeRootPath) });
  },

  loadFileTree: async (path) => {
    if (get().roots.some((r) => r.path === path)) {
      await get().loadRootTree(path);
    } else {
      await get().addRoot(path);
    }
  },

  addTab: (path, name) => {
    const { openTabs } = get();
    if (!openTabs.find((t) => t.path === path)) {
      set({
        openTabs: [
          ...openTabs,
          { path, name, isDirty: false, isPinned: false, diskHash: null, externallyModified: false },
        ],
      });
    }
    set({ activeTabPath: path });
  },

  removeTab: (path) => {
    const { openTabs, activeTabPath } = get();
    const newTabs = openTabs.filter((t) => t.path !== path);
    let newActive = activeTabPath;
    if (activeTabPath === path) {
      newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].path : null;
    }
    set({ openTabs: newTabs, activeTabPath: newActive });
  },

  setActiveTab: (path) => set({ activeTabPath: path }),

  setTabDirty: (path, dirty) => {
    const { openTabs } = get();
    set({
      openTabs: openTabs.map((t) =>
        t.path === path ? { ...t, isDirty: dirty } : t,
      ),
    });
  },

  reorderTabs: (fromIndex, toIndex) => {
    const { openTabs } = get();
    const tabs = [...openTabs];
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    set({ openTabs: tabs });
  },

  pinTab: (path) => {
    const { openTabs } = get();
    const tabs = openTabs.map((t) =>
      t.path === path ? { ...t, isPinned: true } : t,
    );
    tabs.sort((a, b) => (a.isPinned === b.isPinned ? 0 : a.isPinned ? -1 : 1));
    set({ openTabs: tabs });
  },

  unpinTab: (path) => {
    const { openTabs } = get();
    set({
      openTabs: openTabs.map((t) =>
        t.path === path ? { ...t, isPinned: false } : t,
      ),
    });
  },

  updateTabPath: (oldPath, newPath, newName) => {
    const { openTabs, activeTabPath } = get();
    set({
      openTabs: openTabs.map((t) =>
        t.path === oldPath ? { ...t, path: newPath, name: newName } : t,
      ),
      activeTabPath: activeTabPath === oldPath ? newPath : activeTabPath,
    });
  },

  setTabDiskHash: (path, hash) => {
    const { openTabs } = get();
    set({
      openTabs: openTabs.map((t) =>
        t.path === path ? { ...t, diskHash: hash } : t,
      ),
    });
  },

  setTabExternallyModified: (path, modified) => {
    const { openTabs } = get();
    set({
      openTabs: openTabs.map((t) =>
        t.path === path ? { ...t, externallyModified: modified } : t,
      ),
    });
  },

  getTab: (path) => {
    return get().openTabs.find((t) => t.path === path);
  },
}));
