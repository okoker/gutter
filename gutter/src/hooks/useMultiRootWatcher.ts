import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEditorStore } from "../stores/editorStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { hashContent } from "../utils/hash";

/**
 * Per-root file system watcher. Maintains one watcher per open root plus a
 * fallback single-directory watcher when no roots are open but a file is open
 * (legacy Cmd+O single-file flow).
 *
 * Event routing:
 * - "tree-changed" carries the root's watch path as payload → refresh that root's tree.
 * - "file-changed" carries the individual file's path → per-tab reload logic
 *   (same semantics as the previous useFileWatcher hook).
 *
 * StrictMode note: React 19 dev mode double-invokes effects. The Rust side's
 * start_watcher replaces any existing watcher for the given path, and our
 * diff-and-sync loop is idempotent. No guard needed.
 */
export function useMultiRootWatcher(
  markdownRef: React.MutableRefObject<string>,
  lastSaveTimeRef: React.MutableRefObject<number>,
) {
  const [showReloadPrompt, setShowReloadPrompt] = useState(false);
  const roots = useWorkspaceStore((s) => s.roots);
  const loadRootTree = useWorkspaceStore((s) => s.loadRootTree);
  const filePath = useEditorStore((s) => s.filePath);

  // Track which paths currently have a watcher started, so the diff-and-sync
  // effect below knows what to start/stop on every roots change.
  const activeWatchers = useRef<Set<string>>(new Set());

  // Effect 1: per-root watcher lifecycle — diff roots against active set.
  useEffect(() => {
    const desired = new Set(roots.map((r) => r.path));
    // Start watchers for newly-added roots
    for (const p of desired) {
      if (!activeWatchers.current.has(p)) {
        invoke("start_watcher", { path: p }).catch(console.error);
        activeWatchers.current.add(p);
      }
    }
    // Stop watchers for closed roots
    for (const p of Array.from(activeWatchers.current)) {
      if (!desired.has(p)) {
        invoke("stop_watcher", { path: p }).catch(console.error);
        activeWatchers.current.delete(p);
      }
    }
    return () => {
      // Unmount: stop all watchers managed by this hook.
      invoke("stop_watcher", { path: null }).catch(console.error);
      activeWatchers.current.clear();
    };
  }, [roots]);

  // Effect 2: legacy single-file mode — when no roots are open but a file is
  // open (Cmd+O), watch that file's parent directory so external edits still
  // surface. Intentionally separate from the per-root watcher loop.
  useEffect(() => {
    if (roots.length > 0 || !filePath) return;
    const parent = filePath.substring(0, filePath.lastIndexOf("/"));
    if (!parent) return;
    invoke("start_watcher", { path: parent }).catch(console.error);
    return () => {
      invoke("stop_watcher", { path: parent }).catch(console.error);
    };
  }, [roots.length, filePath]);

  // Effect 3: global event listeners. Attached once, route by payload.
  useEffect(() => {
    let treeDebounces = new Map<string, ReturnType<typeof setTimeout>>();
    const unlistenTree = listen<string>("tree-changed", (event) => {
      const rootPath = event.payload;
      // Debounce per-root: rapid events coalesce into one refresh.
      const existing = treeDebounces.get(rootPath);
      if (existing) clearTimeout(existing);
      treeDebounces.set(
        rootPath,
        setTimeout(() => {
          treeDebounces.delete(rootPath);
          const currentRoots = useWorkspaceStore.getState().roots;
          if (currentRoots.some((r) => r.path === rootPath)) {
            loadRootTree(rootPath);
          }
        }, 500),
      );
    });

    const fileChangeDebounces = new Map<string, ReturnType<typeof setTimeout>>();
    const unlistenFile = listen<string>("file-changed", (event) => {
      const changedPath = event.payload;
      const { openTabs } = useWorkspaceStore.getState();

      const tab = openTabs.find((t) => t.path === changedPath);
      if (!tab) return;

      // Ignore changes within 1.5s of our own save (blanket; per-path Rust
      // suppression already covers the primary case).
      if (Date.now() - lastSaveTimeRef.current < 1500) return;

      const existing = fileChangeDebounces.get(changedPath);
      if (existing) clearTimeout(existing);

      fileChangeDebounces.set(
        changedPath,
        setTimeout(async () => {
          fileChangeDebounces.delete(changedPath);
          try {
            const diskContent = await invoke<string>("read_file", { path: changedPath });
            const diskHash = hashContent(diskContent);
            const currentTab = useWorkspaceStore
              .getState()
              .openTabs.find((t) => t.path === changedPath);
            if (!currentTab) return;

            if (currentTab.diskHash === diskHash) return;

            const { activeTabPath: currentActive } = useWorkspaceStore.getState();

            if (changedPath === currentActive) {
              if (!currentTab.isDirty) {
                markdownRef.current = diskContent;
                useEditorStore.getState().setContentClean(diskContent);
                useEditorStore.getState().bumpContentVersion();
                useEditorStore.getState().setDirty(false);
                useWorkspaceStore.getState().setTabDiskHash(changedPath, diskHash);
                useWorkspaceStore.getState().setTabExternallyModified(changedPath, false);
              } else {
                useWorkspaceStore.getState().setTabExternallyModified(changedPath, true);
                setShowReloadPrompt(true);
              }
            } else {
              useWorkspaceStore.getState().setTabExternallyModified(changedPath, true);
            }
          } catch {
            // File may have been deleted.
          }
        }, 500),
      );
    });

    return () => {
      unlistenTree.then((fn) => fn());
      unlistenFile.then((fn) => fn());
      treeDebounces.forEach((t) => clearTimeout(t));
      treeDebounces.clear();
      fileChangeDebounces.forEach((t) => clearTimeout(t));
      fileChangeDebounces.clear();
    };
  }, [loadRootTree, markdownRef, lastSaveTimeRef]);

  const reloadFromDisk = useCallback(async () => {
    const path = useEditorStore.getState().filePath;
    if (path) {
      const content = await invoke<string>("read_file", { path });
      markdownRef.current = content;
      useEditorStore.getState().setContentClean(content);
      useEditorStore.getState().bumpContentVersion();
      useEditorStore.getState().setDirty(false);
      const activeTab = useWorkspaceStore.getState().activeTabPath;
      if (activeTab) {
        useWorkspaceStore.getState().setTabDirty(activeTab, false);
        useWorkspaceStore.getState().setTabDiskHash(activeTab, hashContent(content));
        useWorkspaceStore.getState().setTabExternallyModified(activeTab, false);
      }
    }
    setShowReloadPrompt(false);
  }, [markdownRef]);

  const dismissReloadPrompt = useCallback(() => {
    setShowReloadPrompt(false);
  }, []);

  return { showReloadPrompt, setShowReloadPrompt, reloadFromDisk, dismissReloadPrompt };
}
