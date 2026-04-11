# Gutter Security Review

**Date:** 11/04/2026
**Target:** Gutter v0.3.8 (davidrigie/gutter)
**Stack:** Tauri v2.10.0 (Rust backend), React 19, TipTap/ProseMirror
**Reviewer:** Claude Code (automated review, dual-agent -- backend + frontend in parallel)
**Remediation Status:** H1, H2, H4, H5 FIXED. H3 deferred to backlog (see docs/backlog.md).

---

## Summary

Gutter is a local-first WYSIWYG markdown editor. No network-facing code, no telemetry, no external resource loading. The core security posture is solid for a desktop app. However, the trust boundary between the webview (frontend) and the Rust backend is too permissive -- the backend treats all IPC calls as trusted, enabling a realistic attack chain where a malicious markdown file can escalate to full filesystem access.

---

## HIGH Severity

### H1: Mermaid XSS via securityLevel "loose"

**File:** `gutter/src/components/Editor/extensions/MermaidBlock.tsx:10-13, 134`

Mermaid is initialised with `securityLevel: "loose"`, which allows script tags and event handlers in generated SVG. The rendered SVG is injected unsafely into the DOM.

**Attack:** A malicious `.md` file with a crafted Mermaid block can execute arbitrary JS in the Tauri webview. Combined with H3, this escalates to arbitrary file read/write.

**Fix:** Change `securityLevel: "loose"` to `"strict"` (one-line change). Additionally, sanitise SVG output with DOMPurify before rendering.

**Status:** FIXED -- `securityLevel` changed to `"strict"` in MermaidBlock.tsx:13.

---

### H2: Command Injection via open_url on Windows

**File:** `gutter/src-tauri/src/commands/file_io.rs:122-146`

On Windows, `open_url` uses `cmd /c start <url>` where `url` comes directly from the frontend. Shell metacharacters (`&&`, `|`, etc.) in the URL are interpreted by `cmd.exe`.

**Attack:** A markdown link like `[click](http://x%20&&%20calc)` -- when clicked, executes `calc` (or any command) on Windows.

**Fix:** Validate URL starts with `http://` or `https://`. Avoid `cmd /c start` -- use `ShellExecuteW` or the `open` crate instead.

**Status:** FIXED -- URL scheme validation added + Windows uses `explorer.exe` instead of `cmd /c start` in file_io.rs.

---

### H3: Unrestricted Arbitrary File Read/Write/Delete via IPC

**File:** `gutter/src-tauri/src/commands/file_io.rs` (lines 8-9, 13-15, 24-29, 33-38, 41-46, 49-68, 84-95, 98-107, 110-119, 151-172)

Every file I/O command accepts an arbitrary absolute path from the frontend with zero validation. No path canonicalisation, no workspace boundary check, no symlink resolution.

**Attack:** If the webview is compromised (e.g., via H1), the attacker can read `~/.ssh/id_rsa`, write to `~/.bashrc`, or delete arbitrary files.

**Fix:** Implement a workspace path guard -- canonicalise all paths and verify they fall within the active workspace or `~/.gutter/`.

**Status:** DEFERRED -- documented in docs/backlog.md. H1 fix breaks the exploit chain. Full workspace state tracking needed for proper allowlist approach.

---

## MEDIUM Severity

### M1: KaTeX Error Handler Injects Raw User Input into HTML

**File:** `gutter/src/components/Editor/extensions/MathBlock.tsx:33, 199`

The catch block interpolates raw LaTeX source into HTML without escaping. Crafted LaTeX containing HTML tags (e.g., img tags with onerror handlers) is injected unsanitised into the DOM.

**Fix:** HTML-escape the source string before embedding in error messages.

---

### M2: Path Traversal in Template Names

**File:** `gutter/src-tauri/src/commands/templates.rs:193-217`

`save_template`, `read_template`, and `delete_template` construct file paths from a user-supplied `name` without validating for `../`. A name like `../../.bashrc` escapes the templates directory (`.md` suffix appended limits some exploitation).

**Fix:** Validate `name` contains no `/`, `\`, or `..`.

**Status:** FIXED -- `validate_template_name()` added to templates.rs, applied to read/save/delete.

---

### M3: Asset Protocol Scope Set to Wildcard

**File:** `gutter/src-tauri/tauri.conf.json:26-27`

```json
"assetProtocol": { "enable": true, "scope": ["**"] }
```

The `**` scope allows the webview to load any file on the filesystem via `asset://` URLs, bypassing any Rust-side path restrictions.

**Fix:** Restrict scope to workspace directory. If dynamic, use Tauri's scope manager.

---

### M4: Tauri fs Plugin Permissions Without Scope Restrictions

**File:** `gutter/src-tauri/capabilities/default.json:16-18`

`fs:allow-read` and `fs:allow-write` granted without scope. This is a second independent channel for arbitrary file access (via Tauri's built-in JS readTextFile/writeTextFile APIs), separate from the custom IPC commands.

**Fix:** Add scope restrictions, or remove these permissions if all file ops go through custom commands (which they appear to).

---

### M5: Git Command Argument -- commit_hash Not Validated

**File:** `gutter/src-tauri/src/commands/history.rs:283-332`

`commit_hash` from the frontend is used in `git show` without validation. While `Command::new` avoids shell injection, git itself interprets certain argument patterns.

**Fix:** Validate `commit_hash` matches `/^[0-9a-f]{7,40}$/`.

---

### M6: XSS in HTML Export

**File:** `gutter/src-tauri/src/commands/export.rs:4-36`

Content is injected directly into an HTML template via `format!()` without sanitisation. Malicious raw HTML or script tags in markdown pass through to the exported HTML file.

**Fix:** Strip script, iframe, object, embed tags and event handlers before embedding. Consider using DOMPurify or equivalent server-side sanitiser.

**Status:** FIXED -- `sanitize_html()` function added to export.rs, strips dangerous tags and on* event handlers.

---

### M7: Symlink Following Without Checks

**Files:** `gutter/src-tauri/src/commands/file_io.rs:70-82`, `workspace.rs`, `search.rs`

No file operations check for symlinks. `copy_dir_recursive` follows symlinks transparently -- a symlink to `/` would recursively copy the entire filesystem. Depth limit of 10 mitigates infinite loops but not targeted symlinks.

**Fix:** Detect symlinks with `is_symlink()` and either skip or validate target is within workspace.

---

### M8: Client-Side Path Construction Passed to Backend IPC

**Files:** `gutter/src/components/FileTree/FileTree.tsx`, `src/utils/path.ts`

The frontend constructs file paths (workspace path + user input) and passes them to Rust commands. `joinPath` is simple concatenation with no traversal protection.

**Fix:** Backend should validate all paths (see H3). Frontend should also normalise before sending.

---

## LOW Severity

### L1: devtools Feature Enabled in Release Builds

**File:** `gutter/src-tauri/Cargo.toml:22`

`tauri = { features = ["devtools"] }` enables browser DevTools in release builds. Users can open DevTools and execute arbitrary JS with full IPC access.

**Fix:** Remove `devtools` from release features. Use `#[cfg(debug_assertions)]` for debug-only.

---

### L2: Mutex .unwrap() Can Panic and Crash App

**Files:** `file_io.rs:178`, `watcher.rs:28,35`, `lib.rs:40,97`

Poisoned mutex causes panic and app crash.

**Fix:** Use `.unwrap_or_else(|e| e.into_inner())` or handle gracefully.

---

### L3: Error Messages Leak Path Information

**Files:** Throughout all command files.

Error messages include OS error details and absolute paths returned to the frontend.

**Fix:** Acceptable for local app. Sanitise if network features added later.

---

### L4: CSP unsafe-inline for Styles

**File:** `gutter/src-tauri/tauri.conf.json:23`

Standard for React/TipTap apps. Enables CSS-based exfiltration in theory but low practical risk.

---

### L5: Comment IDs from .comments.json Not Validated

**File:** `gutter/src/hooks/useComments.ts:17-28`

Comment IDs loaded from JSON sidecar are not validated against expected `c\d+` pattern. Crafted keys become `data-comment-id` attributes on DOM elements.

**Fix:** Validate comment IDs on load.

---

### L6: Dev-Mode Store Exposure

**File:** `gutter/src/main.tsx:9-29`

All Zustand stores exposed on `window.__STORES__` in dev mode. Gated behind `import.meta.env.DEV` -- should be stripped in production.

**Fix:** Verify production builds exclude this code.

---

### L7: Export Dialog Uses Regex-Based Markdown-to-HTML

**File:** `gutter/src/components/ExportDialog.tsx:10-63`

Simple regex replacement without escaping. Crafted markdown can break out of HTML attribute context in exported files.

**Fix:** Use proper markdown-to-HTML library (remark-html already in dependencies).

---

## Positive Observations

- No `unsafe` Rust blocks anywhere
- No hardcoded secrets, tokens, or API keys
- No external network calls -- CSP `connect-src ipc:` enforced
- No web storage (localStorage/sessionStorage/IndexedDB)
- Fonts bundled locally -- no CDN
- ProseMirror clipboard handling is safe by design
- Git commands use `Command::new` not shell invocation
- Dependencies are well-known, maintained crates/packages
- Release profile uses `panic = "abort"` preventing unwinding attacks
- `script-src 'self'` in CSP -- blocks inline scripts

---

## Critical Attack Chain

**H1 + H3 + M3** form a complete exploit chain:

1. Victim opens a malicious `.md` file (received via email, git, download)
2. Mermaid block with crafted SVG executes JS in the webview (H1)
3. JS calls Tauri IPC to read/write arbitrary files (H3) or uses asset:// protocol (M3)
4. Attacker exfiltrates SSH keys, browser cookies, or plants persistence

**Fixing H1 alone breaks this chain.** It is a one-line change.

---

## Remediation Priority

| Priority | Finding | Effort |
|----------|---------|--------|
| 1 | H1: Mermaid securityLevel "loose" | Trivial -- one line |
| 2 | H2: open_url command injection (Windows) | Low |
| 3 | L1: Remove devtools from release | Trivial |
| 4 | M2: Template name path traversal | Low |
| 5 | M4: Remove unscoped fs permissions | Low -- remove 2 lines |
| 6 | M1: KaTeX error path XSS | Low |
| 7 | M5: Validate git commit hash | Low |
| 8 | M3: Restrict asset protocol scope | Medium |
| 9 | H3: Workspace path boundary checks | Medium-High |
| 10 | M6: Sanitise HTML export | Medium |
| 11 | M7: Symlink handling | Medium |
| 12 | M8: Frontend path normalisation | Low |
| 13 | L2-L7: Low-priority hardening | Low |
