use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
pub struct JobObjectGuard {
    pub handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for JobObjectGuard {}
#[cfg(windows)]
unsafe impl Sync for JobObjectGuard {}

#[cfg(windows)]
impl JobObjectGuard {
    pub fn new() -> Option<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                log::warn!("Failed to create Windows Job Object");
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let res = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if res == 0 {
                log::warn!("Failed to set KILL_ON_JOB_CLOSE on Job Object");
                windows_sys::Win32::Foundation::CloseHandle(job);
                return None;
            }
            log::info!("Created Windows Job Object with KILL_ON_JOB_CLOSE");
            Some(Self { handle: job })
        }
    }

    pub fn assign_raw_handle(&self, process_handle: std::os::windows::io::RawHandle) -> bool {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe {
            let res = AssignProcessToJobObject(self.handle, process_handle as _);
            if res != 0 {
                log::info!("Assigned child process handle to Job Object");
                true
            } else {
                log::warn!("Failed to assign child process handle to Job Object");
                false
            }
        }
    }

    pub fn assign_pid(&self, pid: u32) -> bool {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc.is_null() {
                log::warn!("Could not OpenProcess for PID {} to assign to Job Object", pid);
                return false;
            }
            let ok = self.assign_raw_handle(proc as _);
            windows_sys::Win32::Foundation::CloseHandle(proc);
            ok
        }
    }
}

#[cfg(windows)]
impl Drop for JobObjectGuard {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }
}

pub struct SidecarState {
    pub port: Mutex<Option<u16>>,
    pub child_pid: Mutex<Option<u32>>,
    #[cfg(windows)]
    pub job_object: Mutex<Option<JobObjectGuard>>,
}

impl SidecarState {
    pub fn new() -> Self {
        #[cfg(windows)]
        let job = JobObjectGuard::new();

        Self {
            port: Mutex::new(None),
            child_pid: Mutex::new(None),
            #[cfg(windows)]
            job_object: Mutex::new(job),
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

#[cfg(windows)]
pub fn assign_child_to_job(app: &AppHandle, process_handle: std::os::windows::io::RawHandle) {
    if let Ok(job_guard) = app.state::<SidecarState>().job_object.lock() {
        if let Some(job) = job_guard.as_ref() {
            job.assign_raw_handle(process_handle);
        }
    }
}

#[cfg(windows)]
pub fn assign_pid_to_job(app: &AppHandle, pid: u32) {
    if let Ok(job_guard) = app.state::<SidecarState>().job_object.lock() {
        if let Some(job) = job_guard.as_ref() {
            job.assign_pid(pid);
        }
    }
}

pub fn cleanup_stale_sidecars() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/F", "/IM", "localmind-ai.exe", "/T"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-9", "-f", "localmind-ai"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

pub fn kill_sidecar(app: &AppHandle) {
    let port = get_sidecar_port(app);
    if let Some(p) = port {
        // Attempt fast HTTP shutdown via raw TCP stream
        std::thread::spawn(move || {
            use std::io::Write;
            use std::net::TcpStream;
            use std::time::Duration;
            if let Ok(mut stream) = TcpStream::connect_timeout(
                &format!("127.0.0.1:{}", p).parse().unwrap(),
                Duration::from_millis(300),
            ) {
                let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
                let req = format!("POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", p);
                let _ = stream.write_all(req.as_bytes());
            }
        });
    }

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
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
    }

    // Ensure any leftover localmind-ai.exe process tree is terminated
    cleanup_stale_sidecars();
}
