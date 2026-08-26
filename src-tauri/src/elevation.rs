/// Windows Administrator privilege detection and self-elevation.
/// Ensures LocalMind has permissions to read NTFS Master File Tables (MFT)
/// and USN Change Journals directly via `\\.\C:` volume handles.

#[cfg(windows)]
pub fn is_elevated() -> bool {
    use std::mem;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }

        let mut elevation: TOKEN_ELEVATION = mem::zeroed();
        let mut size = mem::size_of::<TOKEN_ELEVATION>() as u32;

        let res = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut _,
            size,
            &mut size,
        );

        CloseHandle(token);

        res != 0 && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    true
}

#[cfg(windows)]
pub fn relaunch_elevated() -> bool {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let current_exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return false,
    };

    let args: Vec<String> = std::env::args().skip(1).collect();
    let args_str = args.join(" ");

    let exe_wide: Vec<u16> = current_exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let args_wide: Vec<u16> = OsStr::new(&args_str).encode_wide().chain(Some(0)).collect();
    let verb_wide: Vec<u16> = OsStr::new("runas").encode_wide().chain(Some(0)).collect();

    unsafe {
        let res = ShellExecuteW(
            null_mut(),
            verb_wide.as_ptr(),
            exe_wide.as_ptr(),
            if args.is_empty() { null_mut() } else { args_wide.as_ptr() },
            null_mut(),
            SW_SHOWNORMAL,
        );

        // ShellExecuteW returns a value > 32 on success
        res as usize > 32
    }
}

#[cfg(not(windows))]
pub fn relaunch_elevated() -> bool {
    false
}

pub fn ensure_elevated() {
    #[cfg(windows)]
    {
        // Don't elevate on debug dev runs, background autostart, minimized tray mode, or when explicitly requested --no-elevate
        let skip_elevation = cfg!(debug_assertions) || std::env::args().any(|arg| {
            arg == "--no-elevate" || arg == "--autostart" || arg == "--minimized"
        });
        if !skip_elevation && !is_elevated() {
            log::info!("LocalMind not running with admin rights. Requesting UAC elevation for MFT access...");
            if relaunch_elevated() {
                std::process::exit(0);
            } else {
                log::warn!("Elevation request declined or failed. Running in standard user mode.");
            }
        }
    }
}
