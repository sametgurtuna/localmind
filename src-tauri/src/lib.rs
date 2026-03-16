mod commands;
mod sidecar;
mod tray;
mod window;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::ShortcutState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                .with_shortcuts(["ctrl+space"])
                .expect("failed to register global shortcut")
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = shortcut;
                        window::toggle_main_window(app);
                    }
                })
                .build(),
        )
        .manage(sidecar::SidecarState::new())
        .setup(|app| {
            tray::create_tray(app)?;

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
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
            commands::get_sidecar_port,
            commands::start_sidecar,
            commands::open_in_vscode,
            commands::open_in_terminal,
            commands::delete_file,
            commands::open_file_at_line,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LocalMind");
}
