import { useEffect } from "react";
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
 */
export function useMenuBarListeners(actions: MenuBarActions) {
  // Workspace-root listeners attach once with stable deps. They read the
  // workspace store via getState() and don't depend on `actions`, so they
  // must NOT re-register on every render — otherwise multiple copies stack
  // up and a single menu click fires N dialogs in sequence.
  useEffect(() => {
    const unlisteners = [
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
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  useEffect(() => {
    const unlisteners = [
      listen("menu:new-file", () => actions.handleNewFile()),
      listen("menu:open", () => actions.handleOpenFile()),
      listen("menu:save", () => actions.handleSave()),
      listen("menu:export", () => actions.setShowExport(true)),
      listen("menu:preferences", () => actions.setShowPreferences(true)),
      listen("menu:toggle-tree", () => actions.toggleFileTree()),
      listen("menu:toggle-comments", () => actions.toggleComments()),
      listen("menu:toggle-history", () => actions.toggleHistory()),
      listen("menu:toggle-tags", () => actions.toggleTags()),
      listen("menu:toggle-snippets", () => actions.toggleSnippets()),
      listen("menu:toggle-outline", () => actions.toggleOutline()),
      listen("menu:toggle-source", () => {
        if (useEditorStore.getState().isSourceMode) {
          actions.switchToWysiwyg();
        } else {
          actions.switchToSource();
        }
      }),
      listen("menu:toggle-reading", () => {
        const state = useEditorStore.getState();
        if (state.isSourceMode && !state.isReadingMode) actions.switchToWysiwyg();
        actions.toggleReadingMode();
      }),
      listen("menu:cycle-theme", () => actions.cycleTheme()),
      listen("menu:search", () => actions.setUnifiedSearchMode("all")),
      listen("menu:quick-open", () => actions.setUnifiedSearchMode("files")),
      listen("menu:find", () => actions.setFindReplaceMode("find")),
      listen("menu:replace", () => actions.setFindReplaceMode("replace")),
      listen("menu:new-comment", () => actions.createComment()),
      listen("menu:next-comment", () => actions.navigateComment("next")),
      listen("menu:prev-comment", () => actions.navigateComment("prev")),
      listen("menu:new-from-template", async () => {
        const currentPath = useEditorStore.getState().filePath;
        const ws = useWorkspaceStore.getState().workspacePath;
        let folder = currentPath ? parentDir(currentPath) : ws;
        if (!folder) {
          const picked = await open({ directory: true });
          if (!picked) return;
          folder = typeof picked === "string" ? picked : (picked as { path: string }).path;
        }
        actions.setTemplatePicker({ mode: "new", targetFolder: folder });
      }),
      listen("menu:save-as-template", () => {
        if (!actions.getMarkdown()) return;
        const currentPath = useEditorStore.getState().filePath;
        const ws = useWorkspaceStore.getState().workspacePath;
        const folder = currentPath ? parentDir(currentPath) : (ws || "");
        actions.setTemplatePicker({ mode: "save", targetFolder: folder });
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, [actions]);
}
