import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { headingFoldKey } from "../components/Editor/extensions/HeadingFold";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Persists heading-fold state per tab. The editor remounts on tab switch
 * (key in App.tsx), so plugin state would otherwise reset to empty. This
 * hook captures folded heading positions on every transaction and restores
 * them when the editor for a tab is recreated.
 *
 * State lives in workspaceStore (tab.foldedPositions), session-only —
 * never written to disk. When a tab closes, its entry is dropped with the
 * rest of the tab.
 */
export function useFoldStatePersistence(
  editor: Editor | null,
  activeTabPath: string | null,
) {
  const lastSavedRef = useRef<number[]>([]);

  useEffect(() => {
    if (!editor || !activeTabPath) return;

    const savedPositions =
      useWorkspaceStore
        .getState()
        .openTabs.find((t) => t.path === activeTabPath)?.foldedPositions ?? [];
    lastSavedRef.current = [...savedPositions];

    if (savedPositions.length > 0) {
      // Defer one frame so the editor finishes its first render cycle
      // before we dispatch fold meta. The plugin's apply will silently
      // skip positions that no longer point at a top-level heading
      // (file changed externally between captures).
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        for (const pos of savedPositions) {
          editor.view.dispatch(
            editor.state.tr.setMeta(headingFoldKey, { type: "fold", pos }),
          );
        }
      });
    }

    const handler = () => {
      const value = headingFoldKey.getState(editor.state);
      if (!value) return;
      const positions = [...value.folded].sort((a, b) => a - b);
      const last = lastSavedRef.current;
      if (
        positions.length !== last.length ||
        !positions.every((p, i) => p === last[i])
      ) {
        lastSavedRef.current = [...positions];
        useWorkspaceStore
          .getState()
          .setTabFoldedPositions(activeTabPath, positions);
      }
    };

    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor, activeTabPath]);
}
