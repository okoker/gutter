# File Safety Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Gutter's file handling rock-solid — silently reload clean files on external changes, prompt for dirty conflicts, add read-before-write safety, and default auto-save to off.

**Architecture:** Add `diskHash` and `externallyModified` fields per tab in workspaceStore. Extend the file watcher to cover all tabs (not just active). Add a read-before-write check in the save flow. Unify dirty state. Change auto-save default to 0 (off).

**Tech Stack:** TypeScript (Zustand stores, React hooks), Rust (Tauri commands), vitest for tests.

---

### Task 1: Add `diskHash` and `externallyModified` to OpenTab

**Files:**
- Modify: `gutter/src/stores/workspaceStore.ts:11-16`

**Step 1: Add fields to OpenTab interface and store actions**

Add two new fields to `OpenTab` and three new store actions:

```typescript
// In OpenTab interface (line 11)
export interface OpenTab {
  path: string;
  name: string;
  isDirty: boolean;
  isPinned: boolean;
  diskHash: string | null;          // NEW: hash of content as last read/written to disk
  externallyModified: boolean;      // NEW: watcher detected external change
}
```

Add these store actions to the interface and implementation:

```typescript
// New actions in WorkspaceState interface
setTabDiskHash: (path: string, hash: string | null) => void;
setTabExternallyModified: (path: string, modified: boolean) => void;
getTab: (path: string) => OpenTab | undefined;
```

Update `addTab` to include the new fields with defaults: `diskHash: null`, `externallyModified: false`.

**Step 2: Implement the new actions**

```typescript
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
```

**Step 3: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: May have errors in files that construct OpenTab objects without the new fields. Fix any found.

**Step 4: Commit**

```bash
git add gutter/src/stores/workspaceStore.ts
git commit -m "feat: add diskHash and externallyModified to OpenTab"
```

---

### Task 2: Add `hashContent` utility

**Files:**
- Create: `gutter/src/utils/hash.ts`
- Create: `gutter/tests/hash.test.ts`

**Step 1: Write the failing test**

```typescript
// gutter/tests/hash.test.ts
import { describe, it, expect } from "vitest";
import { hashContent } from "../src/utils/hash";

describe("hashContent", () => {
  it("returns consistent hash for same content", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello world");
    expect(h1).toBe(h2);
  });

  it("returns different hash for different content", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello world!");
    expect(h1).not.toBe(h2);
  });

  it("normalizes line endings before hashing", () => {
    const h1 = hashContent("line1\nline2");
    const h2 = hashContent("line1\r\nline2");
    expect(h1).toBe(h2);
  });

  it("handles empty string", () => {
    const h = hashContent("");
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd gutter && npx vitest run tests/hash.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// gutter/src/utils/hash.ts

/**
 * Compute a fast, deterministic hash of content for change detection.
 * Uses Web Crypto API (SubtleCrypto) in browsers, but for synchronous
 * use we use a simple djb2-based hash. Not cryptographic — just for
 * detecting whether content changed.
 */
export function hashContent(content: string): string {
  // Normalize line endings so \r\n and \n produce the same hash
  const normalized = content.replace(/\r\n/g, "\n");
  // djb2 hash — fast, good distribution for text
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  // Convert to unsigned hex
  return (hash >>> 0).toString(16);
}
```

**Step 4: Run test to verify it passes**

Run: `cd gutter && npx vitest run tests/hash.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add gutter/src/utils/hash.ts gutter/tests/hash.test.ts
git commit -m "feat: add hashContent utility for disk change detection"
```

---

### Task 3: Wire `diskHash` into file open/read flows

**Files:**
- Modify: `gutter/src/hooks/useTabLifecycle.ts:105-155` (activateTab)
- Modify: `gutter/src/hooks/useFileWatcher.ts:78-88` (reloadFromDisk)

**Step 1: Update `activateTab` to set `diskHash` on disk reads**

In `activateTab`, after reading from disk (the `else if (!isUntitled)` branch, line 131), compute and store the disk hash:

```typescript
// After line 138: setContentClean(content);
import { hashContent } from "../utils/hash";

// Inside activateTab, after successful disk read:
const { setTabDiskHash } = useWorkspaceStore.getState();
setTabDiskHash(path, hashContent(content));
```

Also add `setTabDiskHash` to the store selector at the top of the hook (or use `getState()` inline).

**Step 2: Update `reloadFromDisk` to set `diskHash` after reload**

In `useFileWatcher.ts`, after reading from disk in `reloadFromDisk` (line 81):

```typescript
// After: markdownRef.current = content;
const { setTabDiskHash, setTabExternallyModified } = useWorkspaceStore.getState();
const activeTab = useWorkspaceStore.getState().activeTabPath;
if (activeTab) {
  setTabDiskHash(activeTab, hashContent(content));
  setTabExternallyModified(activeTab, false);
}
```

**Step 3: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add gutter/src/hooks/useTabLifecycle.ts gutter/src/hooks/useFileWatcher.ts
git commit -m "feat: set diskHash when reading files from disk"
```

---

### Task 4: Rewrite file watcher to cover all open tabs

**Files:**
- Modify: `gutter/src/hooks/useFileWatcher.ts`

This is the core safety change. The watcher currently only acts on the active tab. We need it to handle ALL open tabs.

**Step 1: Rewrite the `file-changed` listener**

Replace the current `file-changed` listener (lines 34-67) with:

```typescript
let fileChangeDebounces = new Map<string, ReturnType<typeof setTimeout>>();

const unlistenFile = listen<string>("file-changed", (event) => {
  const changedPath = event.payload;
  const { openTabs, activeTabPath } = useWorkspaceStore.getState();

  // Only care about files that are open in tabs
  const tab = openTabs.find(t => t.path === changedPath);
  if (!tab) return;

  // Ignore changes within 1.5s of our own save (watcher suppression)
  if (Date.now() - lastSaveTimeRef.current < 1500) return;

  // Debounce per-path (FSEvents fires multiple times for one save)
  const existing = fileChangeDebounces.get(changedPath);
  if (existing) clearTimeout(existing);

  fileChangeDebounces.set(changedPath, setTimeout(async () => {
    fileChangeDebounces.delete(changedPath);
    try {
      const diskContent = await invoke<string>("read_file", { path: changedPath });
      const diskHash = hashContent(diskContent);
      const currentTab = useWorkspaceStore.getState().openTabs.find(t => t.path === changedPath);
      if (!currentTab) return;

      // If disk content matches what we last knew, nothing actually changed
      if (currentTab.diskHash === diskHash) return;

      const { activeTabPath: currentActive } = useWorkspaceStore.getState();

      if (changedPath === currentActive) {
        // ACTIVE TAB: handle immediately
        if (!currentTab.isDirty) {
          // Clean buffer → silent reload
          markdownRef.current = diskContent;
          useEditorStore.getState().setContentClean(diskContent);
          useEditorStore.getState().bumpContentVersion();
          useEditorStore.getState().setDirty(false);
          useWorkspaceStore.getState().setTabDiskHash(changedPath, diskHash);
          useWorkspaceStore.getState().setTabExternallyModified(changedPath, false);
        } else {
          // Dirty buffer → show conflict prompt
          useWorkspaceStore.getState().setTabExternallyModified(changedPath, true);
          setShowReloadPrompt(true);
        }
      } else {
        // BACKGROUND TAB: mark for handling on tab switch
        useWorkspaceStore.getState().setTabExternallyModified(changedPath, true);
      }
    } catch {
      // File may have been deleted
    }
  }, 500));
});
```

**Step 2: Clean up debounce timers in cleanup function**

In the cleanup return (line 69), also clear per-path debounces:

```typescript
return () => {
  invoke("stop_watcher").catch(console.error);
  unlistenTree.then((fn) => fn());
  unlistenFile.then((fn) => fn());
  clearTimeout(debounceTimer);
  fileChangeDebounces.forEach((t) => clearTimeout(t));
  fileChangeDebounces.clear();
};
```

**Step 3: Add `hashContent` import**

```typescript
import { hashContent } from "../utils/hash";
```

**Step 4: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add gutter/src/hooks/useFileWatcher.ts
git commit -m "feat: extend file watcher to cover all open tabs with silent reload"
```

---

### Task 5: Handle `externallyModified` on tab switch

**Files:**
- Modify: `gutter/src/hooks/useTabLifecycle.ts:105-155` (activateTab)

**Step 1: Add external modification handling to `activateTab`**

In `activateTab`, after the existing cache-or-disk loading logic, add a check for `externallyModified` BEFORE loading from cache:

```typescript
// At the start of activateTab, after setShowReloadPrompt(false) (line 110):
const tab = useWorkspaceStore.getState().openTabs.find(t => t.path === path);

// If externally modified, always reload from disk instead of cache
if (tab?.externallyModified && !isUntitled) {
  try {
    const diskContent = await invoke<string>("read_file", { path });
    if (activationIdRef.current !== myActivation) return;
    const newHash = hashContent(diskContent);

    if (tab.isDirty) {
      // Dirty + externally modified → load from cache but show conflict prompt
      // (load cache content so user doesn't lose edits)
      if (tabContentCache.current.has(path)) {
        const content = tabContentCache.current.get(path) || "";
        setFilePath(path);
        markdownRef.current = content;
        setContentClean(content);
        bumpContentVersion();
        setDirty(true);
      }
      setShowReloadPrompt(true);
    } else {
      // Clean + externally modified → silent reload from disk
      setFilePath(path);
      markdownRef.current = diskContent;
      setContentClean(diskContent);
      bumpContentVersion();
      setDirty(false);
      tabContentCache.current.set(path, diskContent);
      useWorkspaceStore.getState().setTabDiskHash(path, newHash);
    }
    useWorkspaceStore.getState().setTabExternallyModified(path, false);

    // Load comments
    if (!isUntitled) {
      await loadCommentsFromFile(path);
      if (activationIdRef.current !== myActivation) return;
    }
    return; // Skip normal cache/disk loading below
  } catch (e) {
    useToastStore.getState().addToast("Failed to open file", "error");
    console.error("Failed to reload externally modified file:", e);
    return;
  }
}

// ... existing cache-or-disk loading continues here ...
```

**Step 2: Add hashContent import**

```typescript
import { hashContent } from "../utils/hash";
```

**Step 3: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add gutter/src/hooks/useTabLifecycle.ts
git commit -m "feat: handle externally modified tabs on switch with silent reload or conflict prompt"
```

---

### Task 6: Add read-before-write safety to save flow

**Files:**
- Modify: `gutter/src/hooks/useSaveHandler.ts:29-60` (handleSave)
- Modify: `gutter/src/hooks/useFileOps.ts:30-46` (saveFile)

**Step 1: Add conflict detection to `handleSave`**

In `useSaveHandler.ts`, before calling `saveFile`, add a read-before-write check:

```typescript
const handleSave = useCallback(async () => {
  const md = markdownRef.current;
  const activeTab = useWorkspaceStore.getState().activeTabPath;
  const wasUntitled = activeTab?.startsWith("untitled:");

  // Read-before-write safety check
  const path = useEditorStore.getState().filePath;
  if (path) {
    try {
      const diskContent = await invoke<string>("read_file", { path });
      const diskHash = hashContent(diskContent);
      const tab = useWorkspaceStore.getState().getTab(path);

      if (tab?.diskHash && tab.diskHash !== diskHash) {
        // Disk changed since we last read/wrote — ask user
        const overwrite = await ask(
          "This file was modified outside of Gutter since you last opened or saved it. Overwrite with your changes?",
          { title: "File Changed on Disk", kind: "warning" },
        );
        if (!overwrite) {
          // User chose not to overwrite — reload from disk instead
          markdownRef.current = diskContent;
          useEditorStore.getState().setContentClean(diskContent);
          useEditorStore.getState().bumpContentVersion();
          useEditorStore.getState().setDirty(false);
          useWorkspaceStore.getState().setTabDiskHash(path, diskHash);
          useWorkspaceStore.getState().setTabDirty(path, false);
          tabContentCache.current.set(path, diskContent);
          return;
        }
      }
    } catch {
      // File doesn't exist yet (new file) — proceed with save
    }
  }

  lastSaveTimeRef.current = Date.now();
  await saveFile(md);
  // ... rest of handleSave unchanged ...
```

**Step 2: Update diskHash after successful write**

After the `saveFile(md)` call, update the disk hash:

```typescript
  await saveFile(md);
  const savedPath = useEditorStore.getState().filePath;

  // Update disk hash to reflect what we just wrote
  if (savedPath) {
    useWorkspaceStore.getState().setTabDiskHash(savedPath, hashContent(md));
    useWorkspaceStore.getState().setTabExternallyModified(savedPath, false);
  }
```

**Step 3: Add imports**

```typescript
import { hashContent } from "../utils/hash";
import { ask } from "@tauri-apps/plugin-dialog";
```

**Step 4: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add gutter/src/hooks/useSaveHandler.ts
git commit -m "feat: add read-before-write safety check to prevent overwriting external changes"
```

---

### Task 7: Make auto-save safe (read-before-write + save comments)

**Files:**
- Modify: `gutter/src/hooks/useFileOps.ts:55-66` (scheduleAutoSave)

**Step 1: Add read-before-write to auto-save**

Auto-save should silently skip if disk content diverged, rather than showing a dialog:

```typescript
const scheduleAutoSave = useCallback(
  (markdown: string, opts?: { saveComments?: () => Promise<void>; generateCompanion?: (md: string) => Promise<void> }) => {
    cancelAutoSave();
    const filePath = useEditorStore.getState().filePath;
    if (!filePath || autoSaveInterval === 0) return;
    autoSaveTimerRef.current = setTimeout(async () => {
      // Read-before-write: check if disk content matches our last known state
      try {
        const diskContent = await invoke<string>("read_file", { path: filePath });
        const diskHash = hashContent(diskContent);
        const tab = useWorkspaceStore.getState().getTab(filePath);

        if (tab?.diskHash && tab.diskHash !== diskHash) {
          // Disk diverged — skip auto-save, mark as externally modified
          useWorkspaceStore.getState().setTabExternallyModified(filePath, true);
          return;
        }
      } catch {
        // File doesn't exist — skip auto-save (user needs to manual save first)
        return;
      }

      await saveFile(markdown);
      // Update disk hash after successful auto-save
      useWorkspaceStore.getState().setTabDiskHash(filePath, hashContent(markdown));

      // Auto-save now also saves comments and companion
      if (opts?.saveComments) await opts.saveComments();
      if (opts?.generateCompanion) await opts.generateCompanion(markdown);

      // Clear tab dirty state too (unifying dirty state)
      useWorkspaceStore.getState().setTabDirty(filePath, false);
    }, autoSaveInterval);
  },
  [saveFile, autoSaveInterval, cancelAutoSave],
);
```

**Step 2: Add imports**

```typescript
import { hashContent } from "../utils/hash";
import { useWorkspaceStore } from "../stores/workspaceStore";
```

**Step 3: Update callers to pass comment save functions**

In `useTabLifecycle.ts`, update `handleEditorUpdate` and `handleSourceChange` to pass comment functions to `scheduleAutoSave`. This requires threading `saveComments` and `generateCompanion` through.

The simplest approach: in `useTabLifecycle.ts`, import `useComments` and pass the functions:

```typescript
const { saveComments, generateCompanion } = useComments(); // already available via useComments in the hook

// In handleEditorUpdate:
scheduleAutoSave(markdown, { saveComments, generateCompanion });
```

Wait — `useTabLifecycle` doesn't currently have `useComments` for save. It has `loadCommentsFromFile`. The save functions are used in `useSaveHandler`.

Simpler approach: instead of passing opts, have `useFileOps` accept a `onAutoSaveComplete` callback:

```typescript
const scheduleAutoSave = useCallback(
  (markdown: string, onComplete?: () => Promise<void>) => {
    cancelAutoSave();
    const filePath = useEditorStore.getState().filePath;
    if (!filePath || autoSaveInterval === 0) return;
    autoSaveTimerRef.current = setTimeout(async () => {
      try {
        const diskContent = await invoke<string>("read_file", { path: filePath });
        const diskHash = hashContent(diskContent);
        const tab = useWorkspaceStore.getState().getTab(filePath);
        if (tab?.diskHash && tab.diskHash !== diskHash) {
          useWorkspaceStore.getState().setTabExternallyModified(filePath, true);
          return;
        }
      } catch {
        return;
      }
      await saveFile(markdown);
      useWorkspaceStore.getState().setTabDiskHash(filePath, hashContent(markdown));
      useWorkspaceStore.getState().setTabDirty(filePath, false);
      if (onComplete) await onComplete();
    }, autoSaveInterval);
  },
  [saveFile, autoSaveInterval, cancelAutoSave],
);
```

Then in `useTabLifecycle.ts`, wire up comment saving in `handleEditorUpdate`:

```typescript
// Get saveComments and generateCompanion from useComments
const { loadCommentsFromFile, saveComments, generateCompanion } = useComments();

// In handleEditorUpdate and handleSourceChange:
scheduleAutoSave(markdown, async () => {
  await saveComments();
  await generateCompanion(markdown);
});
```

**Step 4: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add gutter/src/hooks/useFileOps.ts gutter/src/hooks/useTabLifecycle.ts
git commit -m "feat: make auto-save safe with read-before-write and comment saving"
```

---

### Task 8: Change auto-save default to OFF

**Files:**
- Modify: `gutter/src/stores/settingsStore.ts:42`

**Step 1: Change the default**

```typescript
// Line 42, change:
autoSaveInterval: 2000,
// To:
autoSaveInterval: 0,
```

That's it — the Preferences dialog already has an "Off" option for value `"0"`, and all the auto-save logic already checks `autoSaveInterval === 0` to skip scheduling. Existing users who have already saved settings will keep their saved preference. Only new users (no `~/.gutter/config.json`) get the new default.

**Step 2: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add gutter/src/stores/settingsStore.ts
git commit -m "feat: default auto-save to off (manual save by default)"
```

---

### Task 9: Unify dirty state

**Files:**
- Modify: `gutter/src/hooks/useFileWatcher.ts:78-88` (reloadFromDisk)
- Modify: `gutter/src/hooks/useTabLifecycle.ts` (handleEditorUpdate, handleSourceChange)

Currently `editorStore.isDirty` and `workspaceStore.tab.isDirty` can diverge. The fix: ensure both are always set together.

**Step 1: Create a helper to set dirty state consistently**

Add to `useTabLifecycle.ts`:

```typescript
const setDirtyBoth = useCallback((path: string, dirty: boolean) => {
  setDirty(dirty);
  setTabDirty(path, dirty);
}, [setDirty, setTabDirty]);
```

**Step 2: Use it everywhere dirty state is set**

Audit all places where `setDirty` or `setTabDirty` are called and ensure they're synchronized. Key locations:

- `handleEditorUpdate` — already sets both (setContent sets isDirty=true, then setTabDirty)
- `handleSourceChange` — same pattern
- `activateTab` — sets `setDirty(false)` on disk read; also needs `setTabDirty`
- `reloadFromDisk` — sets `setDirty(false)`; should also set tab dirty
- `handleSave` — sets `setTabDirty(path, false)` but `saveFile` also sets `setDirty(false)` separately

For `reloadFromDisk`, add tab dirty clearing:

```typescript
const reloadFromDisk = useCallback(async () => {
  const path = useEditorStore.getState().filePath;
  if (path) {
    const content = await invoke<string>("read_file", { path });
    markdownRef.current = content;
    useEditorStore.getState().setContentClean(content); // does not set isDirty
    useEditorStore.getState().bumpContentVersion();
    useEditorStore.getState().setDirty(false);
    // Sync workspace tab dirty state
    useWorkspaceStore.getState().setTabDirty(path, false);
    // Update disk hash
    useWorkspaceStore.getState().setTabDiskHash(path, hashContent(content));
    useWorkspaceStore.getState().setTabExternallyModified(path, false);
    // Update cache
    // (tabContentCache not available here — handled by caller)
  }
  setShowReloadPrompt(false);
}, [markdownRef]);
```

**Step 3: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: PASS

**Step 4: Run all tests**

Run: `cd gutter && npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add gutter/src/hooks/useFileWatcher.ts gutter/src/hooks/useTabLifecycle.ts
git commit -m "fix: unify dirty state between editorStore and workspaceStore"
```

---

### Task 10: Show externally-modified indicator on background tabs

**Files:**
- Modify: `gutter/src/components/TabBar.tsx`

**Step 1: Add visual indicator for externally modified tabs**

In the TabBar component, tabs that have `externallyModified: true` should show a visual indicator (e.g., a different dot color or a small icon).

Find where `tab.isDirty` is used to render the dirty indicator dot. Add an additional indicator:

```typescript
{tab.externallyModified && (
  <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-info)]" title="Modified externally" />
)}
```

**Step 2: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add gutter/src/components/TabBar.tsx
git commit -m "feat: show indicator on tabs with external modifications"
```

---

### Task 11: Wire diskHash into tab cache flow

**Files:**
- Modify: `gutter/src/hooks/useTabLifecycle.ts` (activateTab cache branch)

**Step 1: Set diskHash when loading from cache with clean state**

When `activateTab` loads content from cache and the tab is NOT dirty (i.e., it was clean when we cached it), the disk hash should already be set from the original read. No change needed.

When `activateTab` reads from disk (cache miss), diskHash is already set from Task 3.

The remaining gap: when a file is first opened via `handleFileTreeOpen` or `handleOpenFile`, the initial `activateTab` call reads from disk and sets `diskHash` (Task 3). Good.

**Verify:** Run through the full lifecycle mentally:
1. Open file → `activateTab` → reads disk → sets `diskHash` ✓
2. Edit → `handleEditorUpdate` → `setTabDirty(true)` ✓, `diskHash` unchanged ✓
3. Save → `handleSave` → read-before-write compares `diskHash` → writes → updates `diskHash` ✓
4. External change → watcher → active clean tab → silent reload → updates `diskHash` ✓
5. External change → watcher → background tab → marks `externallyModified` ✓
6. Switch to modified tab → `activateTab` → checks `externallyModified` → reloads or prompts ✓
7. Auto-save → read-before-write → compares `diskHash` → writes or skips ✓

**Step 2: No code changes needed — this is a verification task**

Run: `cd gutter && npx tsc --noEmit && npm test`
Expected: PASS

---

### Task 12: Final integration test and cleanup

**Files:**
- Modify: `gutter/tests/smoke.test.ts` (add file safety assertions)

**Step 1: Add a smoke test for hashContent in the workflow**

```typescript
import { hashContent } from "../src/utils/hash";

describe("file safety", () => {
  it("hashContent produces stable hashes", () => {
    const content = "# Hello\n\nWorld";
    expect(hashContent(content)).toBe(hashContent(content));
  });

  it("hashContent detects changes", () => {
    expect(hashContent("v1")).not.toBe(hashContent("v2"));
  });

  it("hashContent normalizes line endings", () => {
    expect(hashContent("a\nb")).toBe(hashContent("a\r\nb"));
  });
});
```

**Step 2: Run all tests**

Run: `cd gutter && npm test`
Expected: ALL PASS

**Step 3: Run type check**

Run: `cd gutter && npx tsc --noEmit`
Expected: PASS

**Step 4: Manual verification checklist**

Run `npm run tauri dev` and verify:
- [ ] Open a file, check tab has no indicators
- [ ] Modify the file externally (e.g., `echo "new content" > file.md`) — editor silently reloads
- [ ] Edit in Gutter, modify externally — conflict prompt appears
- [ ] Open file in tab A, switch to tab B, modify A externally — tab A shows blue dot
- [ ] Switch back to tab A — silently reloads
- [ ] Edit in Gutter, save — works normally
- [ ] Edit in Gutter, modify externally, then save — conflict dialog appears
- [ ] Auto-save is OFF by default in fresh install
- [ ] Enable auto-save in preferences — saves work correctly
- [ ] Auto-save with external modification — auto-save skips, shows indicator

**Step 5: Commit**

```bash
git add gutter/tests/smoke.test.ts
git commit -m "test: add file safety smoke tests"
```

---

### Task 13: Update CLAUDE.md and memory

**Files:**
- Modify: `CLAUDE.md`
- Modify: `memory/MEMORY.md`

**Step 1: Update CLAUDE.md**

Add to the Architecture section, after "Comment System":

```markdown
### File Safety (Disk-Truth Model)

The file on disk is always the source of truth. Key behaviors:

- **Clean files auto-reload silently** when changed externally (all tabs, not just active)
- **Dirty files show conflict dialog** when changed externally
- **Read-before-write**: every save checks disk hash before writing; aborts if external changes detected
- **Auto-save OFF by default** — manual Cmd+S. Opt-in via Preferences.
- **`diskHash`** per tab tracks last known disk state (djb2 hash via `src/utils/hash.ts`)
- **`externallyModified`** flag on tabs triggers reload-or-prompt on tab switch

Relevant files: `useFileWatcher.ts`, `useSaveHandler.ts`, `useFileOps.ts`, `useTabLifecycle.ts`, `workspaceStore.ts`
```

**Step 2: Update memory**

Add to MEMORY.md Key Lessons:

```markdown
### File Safety Model
- Disk is source of truth. Clean files auto-reload silently, dirty files get conflict dialog
- `diskHash` (djb2) per tab in workspaceStore tracks last known disk content
- Read-before-write in `handleSave` and auto-save prevents overwriting external changes
- Auto-save default is 0 (off). When enabled, includes comments + companion
- Watcher covers ALL open tabs, not just active. Background tabs get `externallyModified` flag
```

**Step 3: Commit**

```bash
git add CLAUDE.md memory/MEMORY.md
git commit -m "docs: document file safety model in CLAUDE.md and memory"
```
