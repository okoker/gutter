import { useEffect, useRef } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Restores workspace roots on app launch (if the preference is enabled) and
 * keeps savedWorkspaceRoots in sync with the current roots thereafter.
 *
 * When "Restore workspace on launch" is disabled, the saved paths are left
 * untouched — re-enabling the toggle brings back the last-known state
 * (least-surprise).
 */
export function useWorkspacePersistence() {
  const loaded = useSettingsStore((s) => s.loaded);
  const restoredOnce = useRef(false);

  // Restore roots on first render after settings are loaded.
  useEffect(() => {
    if (!loaded || restoredOnce.current) return;
    restoredOnce.current = true;
    const { rememberWorkspaceRoots, savedWorkspaceRoots } = useSettingsStore.getState();
    if (!rememberWorkspaceRoots || savedWorkspaceRoots.length === 0) {
      useWorkspaceStore.getState().setRestorationComplete(true);
      return;
    }
    (async () => {
      // Sequential — one failing root shouldn't block others. Each addRoot
      // surfaces its own toast on error (TCC-denied, missing, unmounted).
      for (const path of savedWorkspaceRoots) {
        try {
          await useWorkspaceStore.getState().addRoot(path, { silentError: true });
        } catch (e) {
          console.warn(`Could not restore workspace root: ${path}`, e);
        }
      }
      useWorkspaceStore.getState().setRestorationComplete(true);
    })();
  }, [loaded]);

  // Save on change (reactive). The setting store already debounces disk writes.
  const roots = useWorkspaceStore((s) => s.roots);
  const remember = useSettingsStore((s) => s.rememberWorkspaceRoots);
  useEffect(() => {
    if (!loaded || !remember) return;
    const paths = roots.map((r) => r.path);
    useSettingsStore.getState().setSavedWorkspaceRoots(paths);
  }, [loaded, roots, remember]);
}
