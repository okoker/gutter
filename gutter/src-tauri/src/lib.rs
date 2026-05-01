mod commands;
mod menu;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

pub struct OpenFileState {
    /// Pending paths queued before the frontend listener was ready. Drained
    /// once on first call to `get_open_file_path`. Subsequent OS file-open
    /// events go straight to the live listener without being stashed.
    pub paths: Mutex<Vec<String>>,
    pub frontend_ready: AtomicBool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Warm-app file open on Windows/Linux: a second launch invocation
            // forwards its argv here. Emit one event per .md / .markdown arg
            // so multi-file selections all open.
            for arg in args.iter().skip(1) {
                if arg.ends_with(".md") || arg.ends_with(".markdown") {
                    let _ = app.emit("open-file", arg);
                }
            }
        }))
        .manage(OpenFileState {
            paths: Mutex::new(Vec::new()),
            frontend_ready: AtomicBool::new(false),
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Handle CLI args on Windows/Linux at startup. Stash all .md /
            // .markdown args into the pending Vec; the frontend drains them
            // once on first call to `get_open_file_path`.
            let args: Vec<String> = std::env::args().collect();
            let state = app.state::<OpenFileState>();
            let mut pending = state.paths.lock().unwrap();
            for arg in args.iter().skip(1) {
                if arg.ends_with(".md") || arg.ends_with(".markdown") {
                    pending.push(arg.clone());
                }
            }

            menu::setup_menu(app)?;
            commands::watcher::init(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::file_io::read_file,
            commands::file_io::write_file,
            commands::file_io::file_exists,
            commands::file_io::delete_file,
            commands::file_io::create_file,
            commands::file_io::create_directory,
            commands::file_io::rename_path,
            commands::file_io::delete_path,
            commands::file_io::save_image,
            commands::file_io::copy_image,
            commands::file_io::open_url,
            commands::file_io::read_file_data_url,
            commands::file_io::get_open_file_path,
            commands::comments::read_comments,
            commands::comments::write_comments,
            commands::comments::delete_comments,
            commands::comments::write_companion,
            commands::comments::delete_companion,
            commands::workspace::read_directory,
            commands::workspace::get_parent_dir,
            commands::settings::read_settings,
            commands::settings::write_settings,
            commands::watcher::start_watcher,
            commands::watcher::stop_watcher,
            commands::watcher::canonicalize_path,
            commands::export::export_html,
            commands::search::search_workspace,
            commands::templates::init_default_templates,
            commands::templates::list_templates,
            commands::templates::read_template,
            commands::templates::save_template,
            commands::templates::delete_template,
            commands::history::save_snapshot,
            commands::history::list_snapshots,
            commands::history::read_snapshot,
            commands::history::update_snapshot_metadata,
            commands::history::delete_snapshot,
            commands::history::list_git_history,
            commands::history::read_git_version,
            commands::snippets::ensure_snippets_dir,
            commands::snippets::list_snippets,
            commands::snippets::read_snippet,
            commands::snippets::save_snippet,
            commands::snippets::delete_snippet,
            commands::snippets::rename_snippet,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                RunEvent::Opened { urls } => {
                    // Emit one event per URL so multi-file Finder selections
                    // all open. Until the frontend has drained the pending
                    // queue (signal: first call to `get_open_file_path`),
                    // also stash each path so cold-start events fired before
                    // the listener attaches aren't lost.
                    let state = app_handle.state::<OpenFileState>();
                    let frontend_ready = state.frontend_ready.load(Ordering::Relaxed);
                    for url in &urls {
                        if let Ok(path) = url.to_file_path() {
                            let path_str = path.to_string_lossy().to_string();
                            if !frontend_ready {
                                state.paths.lock().unwrap().push(path_str.clone());
                            }
                            let _ = app_handle.emit("open-file", path_str);
                        }
                    }
                }
                RunEvent::WindowEvent { event: WindowEvent::Destroyed, .. } => {
                    // Stop the watcher so its background thread shuts down cleanly
                    let _ = commands::watcher::stop_watcher(app_handle.clone(), None);
                    // Force-exit to avoid macOS 26 WebKit crash: after the window
                    // is deallocated, pending run-loop callbacks
                    // (WebPageProxy::dispatchSetObscuredContentInsets) access freed
                    // memory. Exit immediately so those callbacks never fire.
                    std::process::exit(0);
                }
                _ => {}
            }
        });
}
