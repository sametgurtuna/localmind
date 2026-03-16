use serde::{Deserialize, Serialize};
use std::io::BufRead;
use std::path::PathBuf;
use std::process::Command;
use tauri_plugin_dialog::DialogExt;

use crate::sidecar;

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
        for name in &["Documents", "Downloads", "Desktop"] {
            let p = home.join(name);
            if p.exists() {
                folders.push(p.to_string_lossy().to_string());
            }
        }
    }
    folders
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

#[tauri::command]
pub fn get_config() -> AppConfig {
    AppConfig::default()
}

#[tauri::command]
pub fn save_config(_config: AppConfig) -> Result<(), String> {
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
    // Check if already running
    if let Some(port) = sidecar::get_sidecar_port(&app) {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();
        if client
            .get(format!("http://127.0.0.1:{}/health", port))
            .send()
            .await
            .is_ok()
        {
            return Ok(port);
        }
    }

    let main_py = find_main_py()?;
    log::info!("Starting AI engine from {:?}", main_py);

    let mut child = Command::new("python")
        .arg(&main_py)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start AI engine: {}", e))?;

    let pid = child.id();
    sidecar::set_sidecar_pid(&app, pid);

    // Read PORT from stdout in a blocking way, but only read one line
    let stdout = child.stdout.take().ok_or("No stdout")?;

    // Spawn a thread to read the port line, with a timeout
    let (tx, rx) = std::sync::mpsc::channel::<Result<u16, String>>();

    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.starts_with("PORT=") {
                        match line[5..].trim().parse::<u16>() {
                            Ok(port) => {
                                let _ = tx.send(Ok(port));
                                return;
                            }
                            Err(e) => {
                                let _ = tx.send(Err(format!("Failed to parse port: {}", e)));
                                return;
                            }
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("Failed to read stdout: {}", e)));
                    return;
                }
            }
        }
        let _ = tx.send(Err("AI engine exited without reporting port".to_string()));
    });

    // Wait up to 30 seconds for port
    let port = rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .map_err(|_| "Timeout waiting for AI engine to start".to_string())?
        .map_err(|e| e)?;

    sidecar::set_sidecar_port(&app, port);
    log::info!("AI engine started on port {}", port);

    // Wait for server to respond to health check (up to 15 seconds)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();

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

    // Return port anyway - server might just be slow
    log::warn!("AI engine health check timed out, returning port anyway");
    Ok(port)
}
