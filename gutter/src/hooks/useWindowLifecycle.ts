import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEditorStore } from "../stores/editorStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTagStore } from "../stores/tagStore";
import { useToastStore } from "../stores/toastStore";
import { useUnsavedChangesStore } from "../stores/unsavedChangesStore";
import { parentDir, joinPath, isImageFile } from "../utils/path";

/**
 * Window-level lifecycle effects: close guard, drag-drop, settings load,
 * tag scan, and clearing version preview when history panel closes.
 */
export function useWindowLifecycle(
  editorInstanceRef: React.MutableRefObject<{
    createComment: () => void;
    navigateComment: (direction: "next" | "prev") => void;
    getMarkdown: () => string;
    getEditor: () => import("@tiptap/react").Editor | null;
  } | null>,
  handleFileTreeOpen: (path: string) => Promise<void>,
  setVersionPreview: (v: { content: string; label: string } | null) => void,
  handleSave: () => Promise<void>,
) {
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const showHistory = useEditorStore((s) => s.showHistory);

  // Load settings on startup
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Scan tags when workspace loads
  useEffect(() => {
    if (workspacePath) {
      useTagStore.getState().scanWorkspace(workspacePath);
    }
  }, [workspacePath]);

  // Shared dirty-check + Save/Discard/Cancel flow. Returns true if the
  // caller should proceed with closing, false if the user cancelled or save
  // failed.
  useEffect(() => {
    async function confirmCloseAllowed(): Promise<boolean> {
      const { openTabs: tabs } = useWorkspaceStore.getState();
      const dirtyTabs = tabs.filter((t) => t.isDirty);
      if (dirtyTabs.length === 0) return true;
      const dirtyNames = dirtyTabs.map((t) => t.name).join(", ");
      const message =
        dirtyTabs.length === 1
          ? `"${dirtyTabs[0].name}" has unsaved changes.\nWhat do you want to do?`
          : `${dirtyTabs.length} tabs have unsaved changes (${dirtyNames}).\nWhat do you want to do?\n\nNote: Save will only save the currently active tab.`;
      const result = await useUnsavedChangesStore.getState().confirm(message);
      if (result === "cancel") return false;
      if (result === "save") {
        try {
          await handleSave();
        } catch (e) {
          console.error("[close-handler] save failed:", e);
          useToastStore.getState().addToast("Save failed — close cancelled", "error");
          return false;
        }
      }
      return true;
    }

    // Window red-button (and any future window-close request from the OS).
    const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
      const ok = await confirmCloseAllowed();
      if (!ok) {
        event.preventDefault();
      }
    });

    // Cmd+Q via the custom Quit menu item. Tauri's predefined .quit() calls
    // process::exit directly without firing any RunEvent, so we route Cmd+Q
    // through a custom menu item that emits this event instead.
    const unlistenQuit = listen("menu:quit-requested", async () => {
      const ok = await confirmCloseAllowed();
      if (ok) {
        getCurrentWindow().destroy();
      }
    });

    return () => {
      unlistenClose.then((fn) => fn());
      unlistenQuit.then((fn) => fn());
    };
  }, [handleSave]);

  // Handle files dragged from OS file explorer
  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      const { paths } = event.payload;
      for (const path of paths) {
        if (isImageFile(path)) {
          const filePath = useEditorStore.getState().filePath;
          if (!filePath) {
            useToastStore.getState().addToast("Save the file first to insert images", "error");
            return;
          }
          const dirPath = parentDir(filePath);
          const ext = path.split(".").pop() || "png";
          const filename = `image-${Date.now()}.${ext}`;
          try {
            await invoke("copy_image", { source: path, dirPath, filename });
            const absolutePath = joinPath(dirPath, "assets", filename);
            const displaySrc = convertFileSrc(absolutePath);
            const editor = editorInstanceRef.current?.getEditor();
            if (editor) {
              editor.chain().focus().setImage({ src: displaySrc }).run();
            }
          } catch (e) {
            console.error("Failed to insert dropped image:", e);
            useToastStore.getState().addToast("Failed to insert image", "error");
          }
        } else if (path.endsWith(".md") || path.endsWith(".markdown")) {
          handleFileTreeOpen(path);
        }
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handleFileTreeOpen, editorInstanceRef]);

  // Clear version preview when history panel is closed
  useEffect(() => {
    if (!showHistory) setVersionPreview(null);
  }, [showHistory, setVersionPreview]);
}
