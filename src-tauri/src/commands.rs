use serde::{Deserialize, Serialize};
use std::io::BufRead;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::mft_index::{scan_all_drives_background, NativeSearchResult, SharedMftIndex};
use crate::sidecar;

#[tauri::command]
pub fn fast_search_native(
    app: tauri::AppHandle,
    query: String,
    filter_type: Option<String>,
    limit: Option<usize>,
) -> Vec<NativeSearchResult> {
    if let Some(shared_index) = app.try_state::<SharedMftIndex>() {
        if let Ok(index) = shared_index.read() {
            let ftype = filter_type.unwrap_or_else(|| "all".to_string());
            let lim = limit.unwrap_or(25);
            return index.search(&query, &ftype, lim);
        }
    }
    Vec::new()
}

#[tauri::command]
pub fn get_mft_status(app: tauri::AppHandle) -> serde_json::Value {
    if let Some(shared_index) = app.try_state::<SharedMftIndex>() {
        if let Ok(index) = shared_index.read() {
            return serde_json::json!({
                "status": index.status,
                "total_files": index.total_files,
                "total_apps": index.apps.len(),
                "scan_time_ms": index.scan_time_ms,
                "volumes": index.volumes.iter().map(|v| format!("{}:\\", v.drive_letter)).collect::<Vec<_>>()
            });
        }
    }
    serde_json::json!({ "status": "unavailable", "total_files": 0, "total_apps": 0 })
}

#[tauri::command]
pub fn refresh_mft_index(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(shared_index) = app.try_state::<SharedMftIndex>() {
        scan_all_drives_background(shared_index.inner().clone());
        return Ok(());
    }
    Err("MFT Index state not available".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeFilePreview {
    #[serde(rename = "type")]
    pub preview_type: String, // "image" | "text" | "app" | "binary"
    pub content: String,
    pub total_lines: usize,
    pub start_line: usize,
    pub file_ext: String,
    pub file_size: u64,
    pub modified: Option<f64>,
    pub icon: Option<String>,
}

#[tauri::command]
pub fn get_file_preview_native(path: String, line: Option<usize>, context: Option<usize>) -> NativeFilePreview {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return NativeFilePreview {
            preview_type: "unknown".to_string(),
            content: "".to_string(),
            total_lines: 0,
            start_line: 0,
            file_ext: "".to_string(),
            file_size: 0,
            modified: None,
            icon: None,
        };
    }

    let meta = p.metadata().ok();
    let file_size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs_f64())
    });

    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let ext_with_dot = if ext.is_empty() { String::new() } else { format!(".{}", ext) };

    // 1. Image Files
    let image_exts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];
    if image_exts.contains(&ext.as_str()) {
        if let Ok(bytes) = std::fs::read(p) {
            if bytes.len() <= 20 * 1024 * 1024 {
                let mime = match ext.as_str() {
                    "svg" => "image/svg+xml",
                    "jpg" | "jpeg" => "image/jpeg",
                    "png" => "image/png",
                    "gif" => "image/gif",
                    "webp" => "image/webp",
                    "bmp" => "image/bmp",
                    "ico" => "image/x-icon",
                    _ => "image/png",
                };
                let b64 = crate::apps::base64_encode(&bytes);
                return NativeFilePreview {
                    preview_type: "image".to_string(),
                    content: format!("data:{};base64,{}", mime, b64),
                    total_lines: 0,
                    start_line: 0,
                    file_ext: ext_with_dot,
                    file_size,
                    modified,
                    icon: None,
                };
            }
        }
    }

    // 2. Apps (.exe / .lnk)
    if ext == "exe" || ext == "lnk" {
        let icon = crate::apps::extract_file_icon_base64(&path);
        return NativeFilePreview {
            preview_type: "app".to_string(),
            content: "".to_string(),
            total_lines: 0,
            start_line: 0,
            file_ext: ext_with_dot,
            file_size,
            modified,
            icon,
        };
    }

    // 3. PDF Files (delegate to PyMuPDF sidecar for high-res page render & full text extraction)
    if ext == "pdf" {
        return NativeFilePreview {
            preview_type: "pdf_pending".to_string(),
            content: "".to_string(),
            total_lines: 0,
            start_line: 0,
            file_ext: ext_with_dot,
            file_size,
            modified,
            icon: None,
        };
    }

    // 4. Text & Code Files
    if let Ok(bytes) = std::fs::read(p) {
        // If file contains null bytes in first 1024 bytes, likely binary
        let is_binary = bytes.iter().take(1024).any(|&b| b == 0);
        if !is_binary {
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = text.lines().collect();
            let total = lines.len();

            let target_line = line.unwrap_or(0);
            let ctx = context.unwrap_or(80);

            let (start, end) = if target_line > 0 {
                let s = target_line.saturating_sub(ctx / 2);
                let e = (s + ctx).min(total);
                (s, e)
            } else {
                (0, total.min(400))
            };

            let slice = if start < total { &lines[start..end] } else { &[] };
            return NativeFilePreview {
                preview_type: "text".to_string(),
                content: slice.join("\n"),
                total_lines: total,
                start_line: start + 1,
                file_ext: ext_with_dot,
                file_size,
                modified,
                icon: None,
            };
        }
    }

    NativeFilePreview {
        preview_type: "binary".to_string(),
        content: "".to_string(),
        total_lines: 0,
        start_line: 0,
        file_ext: ext_with_dot,
        file_size,
        modified,
        icon: None,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub shortcut: String,
    pub theme: String,
    pub language: String,
    pub autostart: bool,
    pub max_file_size: u64,
    pub indexed_folders: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            shortcut: "Ctrl+Space".to_string(),
            theme: "dark".to_string(),
            language: "en".to_string(),
            autostart: true,
            max_file_size: 50,
            indexed_folders: get_default_folder_list(),
        }
    }
}

fn get_default_folder_list() -> Vec<String> {
    let mut folders = Vec::new();
    if let Some(home) = dirs_next::home_dir() {
        for name in &["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"] {
            let p = home.join(name);
            if p.exists() {
                folders.push(p.to_string_lossy().to_string());
            }
        }
    }
    // Check secondary drives (D:\, E:\, etc.)
    for letter in b'D'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        if std::path::Path::new(&drive).exists() {
            folders.push(drive);
        }
    }
    folders
}

#[tauri::command]
pub fn get_system_drives() -> Vec<String> {
    let mut drives = Vec::new();
    for letter in b'C'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        if std::path::Path::new(&drive).exists() {
            drives.push(drive);
        }
    }
    drives
}

#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("Failed to open file: {}", e))
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let folder = p.parent().unwrap_or(&p);
    open::that(folder).map_err(|e| format!("Failed to open folder: {}", e))
}

#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.map(|p| p.to_string()));
    });
    let result = rx.recv().map_err(|e| format!("Dialog error: {}", e))?;
    Ok(result)
}

#[tauri::command]
pub async fn rebuild_index(app: tauri::AppHandle) -> Result<(), String> {
    let port = sidecar::get_sidecar_port(&app);
    if let Some(port) = port {
        let client = reqwest::Client::new();
        client
            .post(format!("http://127.0.0.1:{}/index/rebuild", port))
            .send()
            .await
            .map_err(|e| format!("Failed to rebuild index: {}", e))?;
    }
    Ok(())
}

pub fn get_config_file_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(config_dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&config_dir);
        return config_dir.join("config.json");
    }
    if let Some(home) = dirs_next::config_dir() {
        let p = home.join("LocalMind");
        let _ = std::fs::create_dir_all(&p);
        return p.join("config.json");
    }
    PathBuf::from("config.json")
}

pub fn load_app_config(app: &tauri::AppHandle) -> AppConfig {
    let path = get_config_file_path(app);
    if path.exists() {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&data) {
                return cfg;
            }
        }
    }
    AppConfig::default()
}

pub fn save_app_config_to_disk(app: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = get_config_file_path(app);
    let data = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&path, data)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
    Ok(())
}

#[cfg(windows)]
pub fn enable_windows_autostart(app_name: &str, app_path: &str, args: &[&str]) -> Result<(), String> {
    let mut cmd_str = format!("\"{}\"", app_path);
    for arg in args {
        cmd_str.push_str(&format!(" {}", arg));
    }

    let output = Command::new("reg")
        .args([
            "add",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            app_name,
            "/t",
            "REG_SZ",
            "/d",
            &cmd_str,
            "/f",
        ])
        .output()
        .map_err(|e| format!("Failed to run reg add: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to enable autostart in registry: {}", err));
    }
    log::info!("Windows autostart enabled for {}: {}", app_name, cmd_str);
    Ok(())
}

#[cfg(windows)]
pub fn disable_windows_autostart(app_name: &str) -> Result<(), String> {
    let _ = Command::new("reg")
        .args([
            "delete",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            app_name,
            "/f",
        ])
        .output();
    log::info!("Windows autostart disabled for {}", app_name);
    Ok(())
}

#[cfg(windows)]
pub fn is_windows_autostart_enabled(app_name: &str) -> bool {
    let output = Command::new("reg")
        .args([
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            app_name,
        ])
        .output();

    match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn update_global_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<String, String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let trimmed = shortcut.trim();
    if trimmed.is_empty() {
        return Err("Shortcut cannot be empty".to_string());
    }

    let parsed_sc: Shortcut = trimmed
        .parse()
        .map_err(|e| format!("Invalid shortcut format '{}': {:?}", trimmed, e))?;

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    gs.register(parsed_sc)
        .map_err(|e| format!("Failed to register hotkey '{}': {}", trimmed, e))?;

    let mut config = load_app_config(&app);
    config.shortcut = trimmed.to_string();
    let _ = save_app_config_to_disk(&app, &config);

    log::info!("Global shortcut updated to: {}", trimmed);
    Ok(trimmed.to_string())
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enable: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Could not determine executable path: {}", e))?;
        let exe_str = exe_path.to_string_lossy();

        if enable {
            enable_windows_autostart("LocalMind", &exe_str, &["--minimized", "--autostart"])?;
        } else {
            disable_windows_autostart("LocalMind")?;
        }
    }

    let mut config = load_app_config(&app);
    config.autostart = enable;
    let _ = save_app_config_to_disk(&app, &config);

    Ok(enable)
}

#[tauri::command]
pub fn get_autostart(_app: tauri::AppHandle) -> bool {
    #[cfg(windows)]
    {
        is_windows_autostart_enabled("LocalMind")
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub fn get_config(app: tauri::AppHandle) -> AppConfig {
    load_app_config(&app)
}

#[tauri::command]
pub fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let _ = save_app_config_to_disk(&app, &config);

    // Sync shortcut
    if !config.shortcut.trim().is_empty() {
        let _ = update_global_shortcut(app.clone(), config.shortcut.clone());
    }

    // Sync autostart
    let _ = set_autostart(app, config.autostart);

    Ok(())
}

#[tauri::command]
pub fn get_default_folders() -> Vec<String> {
    get_default_folder_list()
}

#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "code", &path])
        .spawn()
        .map_err(|e| format!("Failed to open in VS Code: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let folder = if p.is_dir() {
        p
    } else {
        p.parent().unwrap_or(&p).to_path_buf()
    };
    Command::new("cmd")
        .args(["/C", "start", "cmd", "/K", &format!("cd /d {}", folder.display())])
        .spawn()
        .map_err(|e| format!("Failed to open terminal: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))
}

#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String> {
    if path.contains(":") && !path.contains("\\") && !path.contains("/") {
        // Protocol handler like ms-settings: or calculator:
        Command::new("cmd")
            .args(["/C", "start", &path])
            .spawn()
            .map_err(|e| format!("Failed to launch protocol: {}", e))?;
        return Ok(());
    }

    open::that(&path).map_err(|e| format!("Failed to launch app: {}", e))
}

#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
        return Ok(());
    }
    let folder = p.parent().unwrap_or(&p);
    open::that(folder).map_err(|e| format!("Failed to open folder: {}", e))
}

#[tauri::command]
pub fn run_as_admin(path: String) -> Result<(), String> {
    Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("Start-Process -FilePath '{}' -Verb RunAs", path),
        ])
        .spawn()
        .map_err(|e| format!("Failed to run as administrator: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn system_command(command: String) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", &command])
        .spawn()
        .map_err(|e| format!("Failed to execute command: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn open_file_at_line(path: String, line: u32) -> Result<(), String> {
    let ext = PathBuf::from(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let code_exts = [
        "py", "js", "ts", "tsx", "jsx", "rs", "go", "java", "c", "cpp", "h",
        "rb", "sh", "bat", "json", "yaml", "yml", "toml", "xml", "html", "css",
        "sql", "md", "txt", "log", "env", "csv",
    ];

    if code_exts.contains(&ext.as_str()) && line > 0 {
        let goto = format!("{}:{}", path, line);
        if Command::new("cmd")
            .args(["/C", "code", "--goto", &goto])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }

    open::that(&path).map_err(|e| format!("Failed to open file: {}", e))
}

#[tauri::command]
pub fn get_sidecar_port(app: tauri::AppHandle) -> Option<u16> {
    sidecar::get_sidecar_port(&app)
}

fn find_sidecar_executable(app: &tauri::AppHandle) -> Option<PathBuf> {
    let target_triple = if cfg!(target_arch = "x86_64") {
        "x86_64-pc-windows-msvc"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-pc-windows-msvc"
    } else {
        "x86_64-pc-windows-msvc"
    };

    let mut candidates = Vec::new();

    // 1. Next to current running executable (standard production installer location)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("localmind-ai.exe"));
            candidates.push(dir.join(format!("localmind-ai-{}.exe", target_triple)));
            candidates.push(dir.join("binaries").join(format!("localmind-ai-{}.exe", target_triple)));
            candidates.push(dir.join("resources").join("binaries").join(format!("localmind-ai-{}.exe", target_triple)));
            candidates.push(dir.join("resources").join("localmind-ai.exe"));
        }
    }

    // 2. Tauri resource directory
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join("localmind-ai.exe"));
        candidates.push(res_dir.join(format!("localmind-ai-{}.exe", target_triple)));
        candidates.push(res_dir.join("binaries").join(format!("localmind-ai-{}.exe", target_triple)));
    }

    // 3. Project working directory (e.g. during local dev / test)
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("binaries").join(format!("localmind-ai-{}.exe", target_triple)));
        candidates.push(cwd.join("binaries").join(format!("localmind-ai-{}.exe", target_triple)));
        candidates.push(cwd.join("localmind-ai.exe"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("src-tauri").join("binaries").join(format!("localmind-ai-{}.exe", target_triple)));
        }
    }

    for path in candidates {
        if path.exists() && path.is_file() {
            log::info!("Found AI engine sidecar executable: {:?}", path);
            return Some(path);
        }
    }

    None
}

fn find_main_py() -> Result<PathBuf, String> {
    // Try relative to current working directory
    let cwd = std::env::current_dir().unwrap_or_default();
    let candidates = [
        cwd.join("ai_engine").join("main.py"),
        cwd.parent()
            .map(|p| p.join("ai_engine").join("main.py"))
            .unwrap_or_default(),
        // Relative to executable
        std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .unwrap_or(&PathBuf::new())
            .join("..")
            .join("..")
            .join("..")
            .join("ai_engine")
            .join("main.py"),
    ];

    for path in &candidates {
        if path.exists() {
            return Ok(path.clone());
        }
    }

    Err(format!(
        "AI engine not found. Searched: {:?}",
        candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
    ))
}

#[tauri::command]
pub async fn start_sidecar(app: tauri::AppHandle) -> Result<u16, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();

    // 1. Check if sidecar is already registered and healthy
    if let Some(port) = sidecar::get_sidecar_port(&app) {
        if client
            .get(format!("http://127.0.0.1:{}/health", port))
            .send()
            .await
            .is_ok()
        {
            return Ok(port);
        }
    }

    // 2. Check if a sidecar is running from ~/.localmind/sidecar.port or default port
    if let Some(home) = dirs_next::home_dir() {
        let port_file = home.join(".localmind").join("sidecar.port");
        if let Ok(content) = std::fs::read_to_string(&port_file) {
            if let Ok(port) = content.trim().parse::<u16>() {
                if client
                    .get(format!("http://127.0.0.1:{}/health", port))
                    .send()
                    .await
                    .is_ok()
                {
                    sidecar::set_sidecar_port(&app, port);
                    log::info!("Reconnected to existing AI engine on port {}", port);
                    return Ok(port);
                }
            }
        }
    }

    let mut cmd = if let Some(sidecar_exe) = find_sidecar_executable(&app) {
        let engine_dir = sidecar_exe.parent().unwrap_or(&sidecar_exe);
        log::info!("Starting AI engine sidecar binary from {:?} (dir: {:?})", sidecar_exe, engine_dir);
        let mut c = Command::new(&sidecar_exe);
        c.current_dir(engine_dir);
        c
    } else {
        let main_py = find_main_py()?;
        let engine_dir = main_py.parent().unwrap_or(&main_py);
        log::info!("Starting AI engine from Python script {:?} (dir: {:?})", main_py, engine_dir);
        let mut c = Command::new("python");
        c.arg(&main_py).current_dir(engine_dir);
        c
    };

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start AI engine: {}", e))?;

    let pid = child.id();
    sidecar::set_sidecar_pid(&app, pid);

    let stdout = child.stdout.take().ok_or("No stdout")?;

    // Spawn a persistent thread to read port and continue consuming stdout
    // until the child process exits so the pipe is never closed.
    let (tx, rx) = std::sync::mpsc::channel::<Result<u16, String>>();

    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        let mut port_sent = false;

        for line in reader.lines() {
            match line {
                Ok(line_str) => {
                    log::debug!("[AI Engine stdout] {}", line_str);
                    if !port_sent && line_str.starts_with("PORT=") {
                        match line_str[5..].trim().parse::<u16>() {
                            Ok(port) => {
                                let _ = tx.send(Ok(port));
                                port_sent = true;
                            }
                            Err(e) => {
                                let _ = tx.send(Err(format!("Failed to parse port: {}", e)));
                                port_sent = true;
                            }
                        }
                    }
                }
                Err(e) => {
                    if !port_sent {
                        let _ = tx.send(Err(format!("Failed to read stdout: {}", e)));
                        port_sent = true;
                    }
                    break;
                }
            }
        }

        if !port_sent {
            let _ = tx.send(Err("AI engine exited without reporting port".to_string()));
        }
    });

    // Wait up to 30 seconds for port
    let port = rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .map_err(|_| "Timeout waiting for AI engine to start".to_string())?
        .map_err(|e| e)?;

    sidecar::set_sidecar_port(&app, port);
    log::info!("AI engine started on port {}", port);

    // Wait for server to respond to health check (up to 15 seconds)
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(resp) = client
            .get(format!("http://127.0.0.1:{}/health", port))
            .send()
            .await
        {
            if resp.status().is_success() {
                log::info!("AI engine health check passed on port {}", port);
                return Ok(port);
            }
        }
    }

    log::warn!("AI engine health check timed out, returning port anyway");
    Ok(port)
}
