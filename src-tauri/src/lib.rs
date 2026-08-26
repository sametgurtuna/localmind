mod apps;
mod commands;
mod elevation;
mod mft_index;
mod ntfs;
mod sidecar;
mod tray;
mod window;

use std::sync::{Arc, RwLock};
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::ShortcutState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 1. Ensure Administrator rights on Windows for direct MFT and USN Journal access
    elevation::ensure_elevated();

    // 2. Initialize Shared In-Memory MFT Index and start background drive scanning
    let shared_mft = Arc::new(RwLock::new(mft_index::MftIndex::new()));
    mft_index::scan_all_drives_background(shared_mft.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = shortcut;
                        window::toggle_main_window(app);
                    }
                })
                .build(),
        )
        .manage(sidecar::SidecarState::new())
        .manage(shared_mft)
        .setup(|app| {
            tray::create_tray(app)?;

            if let Some(win) = app.get_webview_window("main") {
                #[cfg(not(debug_assertions))]
                let _ = win.hide();
                #[cfg(debug_assertions)]
                {
                    let _ = win.show();
                    let _ = win.set_focus();
                    let _ = win.center();
                }
            }

            // Register saved global shortcut
            let handle = app.handle();
            let config = commands::load_app_config(handle);
            let shortcut_str = if config.shortcut.trim().is_empty() {
                "Ctrl+Space"
            } else {
                config.shortcut.as_str()
            };

            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            if let Ok(sc) = shortcut_str.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                if let Err(e) = handle.global_shortcut().register(sc) {
                    log::warn!("Failed to register configured shortcut '{}': {}. Trying fallback Ctrl+Space.", shortcut_str, e);
                    if let Ok(fallback) = "Ctrl+Space".parse::<tauri_plugin_global_shortcut::Shortcut>() {
                        let _ = handle.global_shortcut().register(fallback);
                    }
                } else {
                    log::info!("Registered global shortcut: {}", shortcut_str);
                }
            }

            // Sync autostart registry entry if enabled
            #[cfg(windows)]
            {
                if config.autostart {
                    if let Ok(exe) = std::env::current_exe() {
                        let _ = commands::enable_windows_autostart("LocalMind", &exe.to_string_lossy(), &["--minimized", "--autostart"]);
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::open_folder,
            commands::pick_folder,
            commands::rebuild_index,
            commands::get_config,
            commands::save_config,
            commands::get_default_folders,
            commands::get_system_drives,
            commands::get_sidecar_port,
            commands::start_sidecar,
            commands::open_in_vscode,
            commands::open_in_terminal,
            commands::delete_file,
            commands::open_file_at_line,
            commands::launch_app,
            commands::show_in_folder,
            commands::run_as_admin,
            commands::system_command,
            commands::fast_search_native,
            commands::get_mft_status,
            commands::refresh_mft_index,
            commands::get_file_preview_native,
            commands::update_global_shortcut,
            commands::set_autostart,
            commands::get_autostart,
        ])
        .build(tauri::generate_context!())
        .expect("error while running LocalMind")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                sidecar::kill_sidecar(app_handle);
            }
        });
}
