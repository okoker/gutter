import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface SnippetInfo {
  filename: string;
  path: string;
  preview: string;
  modifiedMs: number;
}

interface RawSnippet {
  filename: string;
  path: string;
  preview: string;
  modified_ms: number;
}

interface SnippetState {
  snippets: SnippetInfo[];
  loaded: boolean;
  loadSnippets: () => Promise<void>;
  refreshSnippets: () => Promise<void>;
  readSnippetContent: (path: string) => Promise<string>;
  saveNewSnippet: (filename: string, content: string) => Promise<string>;
  removeSnippet: (path: string) => Promise<void>;
  renameSnippet: (oldPath: string, newFilename: string) => Promise<string>;
}

function fromRaw(raw: RawSnippet[]): SnippetInfo[] {
  return raw.map((r) => ({
    filename: r.filename,
    path: r.path,
    preview: r.preview,
    modifiedMs: r.modified_ms,
  }));
}

export const useSnippetStore = create<SnippetState>((set, get) => ({
  snippets: [],
  loaded: false,

  loadSnippets: async () => {
    try {
      await invoke<string>("ensure_snippets_dir");
      const raw = await invoke<RawSnippet[]>("list_snippets");
      set({ snippets: fromRaw(raw), loaded: true });
    } catch (e) {
      console.error("loadSnippets failed:", e);
      set({ snippets: [], loaded: true });
    }
  },

  refreshSnippets: async () => {
    try {
      const raw = await invoke<RawSnippet[]>("list_snippets");
      set({ snippets: fromRaw(raw) });
    } catch (e) {
      console.error("refreshSnippets failed:", e);
    }
  },

  readSnippetContent: (path) => invoke<string>("read_snippet", { path }),

  saveNewSnippet: async (filename, content) => {
    const absPath = await invoke<string>("save_snippet", { filename, content });
    await get().refreshSnippets();
    return absPath;
  },

  removeSnippet: async (path) => {
    await invoke("delete_snippet", { path });
    await get().refreshSnippets();
  },

  renameSnippet: async (oldPath, newFilename) => {
    const newPath = await invoke<string>("rename_snippet", {
      oldPath,
      newFilename,
    });
    await get().refreshSnippets();
    return newPath;
  },
}));
