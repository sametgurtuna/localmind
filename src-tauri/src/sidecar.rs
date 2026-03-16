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
