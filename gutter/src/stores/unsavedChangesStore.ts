import { create } from "zustand";

export type UnsavedChangesResult = "save" | "discard" | "cancel";

interface State {
  open: boolean;
  message: string;
  resolver: ((r: UnsavedChangesResult) => void) | null;
  /** Returns a promise that resolves when the user picks an option. */
  confirm: (message: string) => Promise<UnsavedChangesResult>;
  /** Called by the modal when a button is clicked. */
  respond: (r: UnsavedChangesResult) => void;
}

/**
 * Promise-returning 3-button "unsaved changes" guard. Backed by a single
 * modal mounted at app root. Used by tab-close, window-close, and (future)
 * Cmd+Q paths so all three share one consistent UX.
 *
 * Usage:
 *   const result = await useUnsavedChangesStore.getState().confirm(msg);
 *   if (result === "save")    { ...save then proceed... }
 *   if (result === "discard") { ...proceed without saving... }
 *   if (result === "cancel")  { ...abort the close... }
 */
export const useUnsavedChangesStore = create<State>((set, get) => ({
  open: false,
  message: "",
  resolver: null,
  confirm: (message) =>
    new Promise<UnsavedChangesResult>((resolve) => {
      // If a prior dialog is still open, resolve it as "cancel" so we don't
      // strand a hung promise.
      const prev = get().resolver;
      if (prev) prev("cancel");
      set({ open: true, message, resolver: resolve });
    }),
  respond: (r) => {
    const { resolver } = get();
    set({ open: false, message: "", resolver: null });
    if (resolver) resolver(r);
  },
}));
