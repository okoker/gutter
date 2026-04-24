import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { useEditorStore } from "../stores/editorStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { parentDir } from "../utils/path";

export interface MenuBarActions {
  handleNewFile: () => void;
  handleOpenFile: () => void;
  handleSave: () => void;
  switchToSource: () => void;
  switchToWysiwyg: () => void;
  toggleFileTree: () => void;
  toggleComments: () => void;
  toggleHistory: () => void;
  toggleTags: () => void;
  toggleSnippets: () => void;
  toggleOutline: () => void;
  toggleReadingMode: () => void;
  cycleTheme: () => void;
  navigateComment: (direction: "next" | "prev") => void;
  setUnifiedSearchMode: (mode: "all" | "files" | "commands") => void;
  setFindReplaceMode: (mode: "find" | "replace") => void;
  setShowExport: (show: boolean) => void;
  setShowPreferences: (show: boolean) => void;
  setTemplatePicker: (v: { mode: "new" | "save"; targetFolder: string } | null) => void;
  createComment: () => void;
  getMarkdown: () => string;
}

/**
 * Listens for native menu bar events from Tauri and dispatches to actions.
 *
 * Root-cause fix for the listener-stacking bug: all listeners read actions
 * via a ref that is refreshed on every render. The useEffect has an empty
 * dependency array so the Tauri `listen()` subscriptions are attached exactly
 * once for the lifetime of the hook. Changing `actions` identity re-renders
 * App but does not re-register listeners; stale closure captures are avoided
 * by always reading `actionsRef.current.<fn>` inside each callback.
 */
export function useMenuBarListeners(actions: MenuBarActions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const unlisteners = [
      // Workspace-root listeners — these read the workspace store directly,
      // but living here keeps all menu listeners under one mount/unmount pair.
      listen("menu:open-folder", async () => {
        const { roots } = useWorkspaceStore.getState();
        if (roots.length > 0) {
          const ok = await ask(
            `This will close ${roots.length} folder${roots.length > 1 ? "s" : ""} currently in your workspace. Continue?`,
            { title: "Replace Workspace?", kind: "warning" },
          );
          if (!ok) return;
        }
        const selected = await open({ directory: true });
        if (!selected) return;
        const path = typeof selected === "string" ? selected : (selected as { path: string }).path;
        const current = useWorkspaceStore.getState().roots.map((r) => r.path);
        current.forEach((p) => useWorkspaceStore.getState().removeRoot(p));
        try {
          await useWorkspaceStore.getState().addRoot(path);
        } catch (e) {
          console.error("Open Folder replace failed:", e);
        }
      }),
      listen("menu:add-folder", async () => {
        const selected = await open({ directory: true });
        if (!selected) return;
        const path = typeof selected === "string" ? selected : (selected as { path: string }).path;
        try {
          await useWorkspaceStore.getState().addRoot(path);
        } catch (e) {
          console.error("addRoot from menu failed:", e);
        }
      }),

      // Action-delegating listeners — always use actionsRef.current.
      listen("menu:new-file", () => actionsRef.current.handleNewFile()),
      listen("menu:open", () => actionsRef.current.handleOpenFile()),
      listen("menu:save", () => actionsRef.current.handleSave()),
      listen("menu:export", () => actionsRef.current.setShowExport(true)),
      listen("menu:preferences", () => actionsRef.current.setShowPreferences(true)),
      listen("menu:toggle-tree", () => actionsRef.current.toggleFileTree()),
      listen("menu:toggle-comments", () => actionsRef.current.toggleComments()),
      listen("menu:toggle-history", () => actionsRef.current.toggleHistory()),
      listen("menu:toggle-tags", () => actionsRef.current.toggleTags()),
      listen("menu:toggle-snippets", () => actionsRef.current.toggleSnippets()),
      listen("menu:toggle-outline", () => actionsRef.current.toggleOutline()),
      listen("menu:toggle-source", () => {
        if (useEditorStore.getState().isSourceMode) {
          actionsRef.current.switchToWysiwyg();
        } else {
          actionsRef.current.switchToSource();
        }
      }),
      listen("menu:toggle-reading", () => {
        const state = useEditorStore.getState();
        if (state.isSourceMode && !state.isReadingMode) actionsRef.current.switchToWysiwyg();
        actionsRef.current.toggleReadingMode();
      }),
      listen("menu:cycle-theme", () => actionsRef.current.cycleTheme()),
      listen("menu:search", () => actionsRef.current.setUnifiedSearchMode("all")),
      listen("menu:quick-open", () => actionsRef.current.setUnifiedSearchMode("files")),
      listen("menu:find", () => actionsRef.current.setFindReplaceMode("find")),
      listen("menu:replace", () => actionsRef.current.setFindReplaceMode("replace")),
      listen("menu:new-comment", () => actionsRef.current.createComment()),
      listen("menu:next-comment", () => actionsRef.current.navigateComment("next")),
      listen("menu:prev-comment", () => actionsRef.current.navigateComment("prev")),
      listen("menu:new-from-template", async () => {
        const currentPath = useEditorStore.getState().filePath;
        const ws = useWorkspaceStore.getState().workspacePath;
        let folder = currentPath ? parentDir(currentPath) : ws;
        if (!folder) {
          const picked = await open({ directory: true });
          if (!picked) return;
          folder = typeof picked === "string" ? picked : (picked as { path: string }).path;
        }
        actionsRef.current.setTemplatePicker({ mode: "new", targetFolder: folder });
      }),
      listen("menu:save-as-template", () => {
        if (!actionsRef.current.getMarkdown()) return;
        const currentPath = useEditorStore.getState().filePath;
        const ws = useWorkspaceStore.getState().workspacePath;
        const folder = currentPath ? parentDir(currentPath) : (ws || "");
        actionsRef.current.setTemplatePicker({ mode: "save", targetFolder: folder });
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);
}
