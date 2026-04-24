use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

struct WatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

struct IgnoredPathState {
    // Maps absolute path -> Instant when it should stop being ignored
    paths: Mutex<std::collections::HashMap<PathBuf, Instant>>,
}

pub fn init(app: &tauri::App) {
    app.manage(WatcherState {
        watcher: Mutex::new(None),
    });
    app.manage(IgnoredPathState {
        paths: Mutex::new(std::collections::HashMap::new()),
    });
}

/// Temporarily suppress watcher events for a specific file path
pub fn mark_write(app: &AppHandle, path: &str) {
    let state = app.state::<IgnoredPathState>();
    let mut guard = state.paths.lock().unwrap();
    // Ignore this path for the next 2 seconds
    guard.insert(PathBuf::from(path), Instant::now() + Duration::from_secs(2));
}

fn is_suppressed(app: &AppHandle, path: &Path) -> bool {
    let state = app.state::<IgnoredPathState>();
    let mut guard = state.paths.lock().unwrap();

    // Clean up expired entries while we're here
    let now = Instant::now();
    guard.retain(|_, expiry| *expiry > now);

    guard.contains_key(path)
}

fn is_ignored_path(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".comments.json") || name.ends_with(".comments.md") {
        return true;
    }
    if path.components().any(|c| c.as_os_str() == ".gutter") {
        return true;
    }
    if name.starts_with('.') {
        return true;
    }
    false
}

#[tauri::command]
pub fn start_watcher(app: AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut guard = state.watcher.lock().map_err(|e| e.to_string())?;

    *guard = None;

    let app_handle = app.clone();
    let watch_path = path.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let relevant: Vec<_> = event
                    .paths
                    .iter()
                    .filter(|p| !is_ignored_path(p) && !is_suppressed(&app_handle, p))
                    .collect();
                if relevant.is_empty() {
                    return;
                }

                // Emit file-changed for every affected path. The frontend
                // (useFileWatcher.ts) filters by openTabs, so directory paths
                // and non-open files are harmlessly dropped.
                //
                // This must fire for all event kinds, not just Modify:
                // atomic-rename writes (Typora, VS Code, vim atomic-save) land
                // as Create on the destination and Remove on the old inode,
                // plus coalesced batches arrive as EventKind::Any. The
                // previous Modify-only emit left open tabs stale after atomic
                // saves.
                //
                // FSEvents limitation: no events fire for remote-side changes
                // on network-mounted (AFP/SMB/NFS) volumes or iCloud Drive
                // paths in "Optimise Storage" mode. Local workspaces are
                // unaffected.
                for p in &relevant {
                    let _ = app_handle.emit("file-changed", p.to_string_lossy().to_string());
                }

                let _ = app_handle.emit("tree-changed", &watch_path);
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to start watching: {}", e))?;

    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn stop_watcher(app: AppHandle) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut guard = state.watcher.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}
