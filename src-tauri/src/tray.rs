use tauri::{
    App, Emitter,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

pub fn create_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show LocalMind", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let rebuild = MenuItem::with_id(app, "rebuild", "Rebuild Index", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &settings, &rebuild, &quit])?;

    let icon = app.default_window_icon().cloned()
        .expect("failed to get default window icon");

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("LocalMind")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "show" => {
                    crate::window::show_main_window(app);
                }
                "settings" => {
                    crate::window::show_main_window(app);
                    let _ = app.emit("open-settings", ());
                }
                "rebuild" => {
                    let _ = app.emit("rebuild-index", ());
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}
