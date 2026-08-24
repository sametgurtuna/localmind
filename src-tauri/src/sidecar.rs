use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct SidecarState {
    pub port: Mutex<Option<u16>>,
    pub child_pid: Mutex<Option<u32>>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(None),
            child_pid: Mutex::new(None),
        }
    }
}

pub fn get_sidecar_port(app: &AppHandle) -> Option<u16> {
    app.state::<SidecarState>().port.lock().ok()?.clone()
}

pub fn set_sidecar_port(app: &AppHandle, port: u16) {
    if let Ok(mut p) = app.state::<SidecarState>().port.lock() {
        *p = Some(port);
    }
}

pub fn set_sidecar_pid(app: &AppHandle, pid: u32) {
    if let Ok(mut p) = app.state::<SidecarState>().child_pid.lock() {
        *p = Some(pid);
    }
}

pub fn kill_sidecar(app: &AppHandle) {
    if let Ok(mut pid_guard) = app.state::<SidecarState>().child_pid.lock() {
        if let Some(pid) = pid_guard.take() {
            log::info!("Killing AI engine child process (PID: {})", pid);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                let _ = std::process::Command::new("taskkill")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .spawn();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .spawn();
            }
        }
    }
}
