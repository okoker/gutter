# Backlog

## Security

### IPC Path Boundary Enforcement (H3)

**Priority:** High (defence-in-depth, not currently exploitable if H1 is fixed)

**Problem:** All file I/O IPC commands (`read_file`, `write_file`, `delete_file`, `create_file`, `rename_path`, `delete_path`, `save_image`, `copy_image`, `read_file_data_url`) accept arbitrary absolute paths from the frontend with no validation. If the webview is ever compromised (XSS, malicious extension, dependency supply chain), the attacker can read, write, or delete any file the OS user has access to.

**Why it's deferred:** In normal use the frontend only sends paths within the user's workspace. The primary attack vector (Mermaid XSS, H1) has been fixed, which breaks the realistic exploit chain. Additionally, the app legitimately needs to access files wherever the user opens a workspace, and the backend doesn't currently track which workspaces are open -- that state lives in the frontend.

**Proper fix:** Implement an allowlist approach:
1. Add managed state in the Rust backend to track currently open workspace root paths
2. Update workspace state when the frontend opens/closes workspaces (new IPC command)
3. Add a `validate_path()` guard that canonicalises the path and verifies it falls within an allowed root or `~/.gutter/`
4. Call the guard at the top of every file I/O command
5. Consider also restricting the asset protocol scope (`tauri.conf.json`) and removing the unscoped `fs:allow-read`/`fs:allow-write` permissions from `capabilities/default.json`

**Simpler interim option:** Blocklist known sensitive directories (`~/.ssh/`, `/etc/`, system dirs). Weaker but trivial to implement.
