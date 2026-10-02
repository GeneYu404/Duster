//! Administrator detection and UAC helpers.
//!
//! Viewing the list works as a standard user. Uninstallers and individual machine-wide
//! mutations are launched with `runas` so the current UI process remains alive. The
//! optional startup setting can instead relaunch Duster itself elevated.

use crate::app_model::PrivilegeInfo;
use crate::error::{AppError, AppResult};

pub fn is_elevated() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn info() -> PrivilegeInfo {
    PrivilegeInfo { is_admin: is_elevated(), can_elevate: cfg!(windows) }
}

/// Re-launch the current executable with the `runas` verb. On success the *current*
/// process exits and the elevated instance takes over (the UI restarts).
pub fn relaunch_elevated() -> AppResult<bool> {
    #[cfg(windows)]
    unsafe {
        use windows::core::{HSTRING, PCWSTR};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let exe = std::env::current_exe().map_err(AppError::Io)?;
        let args: Vec<String> = std::env::args().skip(1).collect();
        let verb = HSTRING::from("runas");
        let exe_text = exe.to_string_lossy().into_owned();
        let file = HSTRING::from(exe_text.as_str());
        let params = HSTRING::from(args.join(" "));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOASYNC,
            hwnd: HWND::default(),
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        match ShellExecuteExW(&mut info) {
            Ok(()) => {
                tracing::info!("elevated instance started; exiting standard-user instance");
                std::process::exit(0);
            }
            Err(e) => {
                // 1223 = ERROR_CANCELLED → the user dismissed the UAC dialog.
                tracing::warn!(error = %e, "elevation declined or failed");
                Ok(false)
            }
        }
    }
    #[cfg(not(windows))]
    {
        Err(AppError::Other("elevation is only supported on Windows".into()))
    }
}

/// Runs one administrative helper while keeping the current UI process alive.
/// This is used for narrowly scoped registry/service/file operations; the UI does not
/// need to restart just to remove a machine-wide registry entry.
pub fn run_elevated_process(program: &str, parameters: &str) -> AppResult<i32> {
    #[cfg(windows)]
    unsafe {
        use windows::core::{HSTRING, PCWSTR};
        use windows::Win32::Foundation::{CloseHandle, HWND};
        use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
        use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
        use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

        let verb = HSTRING::from("runas");
        let file = HSTRING::from(program);
        let params = HSTRING::from(parameters);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS,
            hwnd: HWND::default(),
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };

        if let Err(error) = ShellExecuteExW(&mut info) {
            if (error.code().0 as u32 & 0xffff) == 1223 {
                return Err(AppError::ElevationRequired("UAC request was cancelled".into()));
            }
            return Err(AppError::Process(format!("elevated helper failed: {error}")));
        }
        if info.hProcess.is_invalid() {
            return Err(AppError::Process("elevated helper returned no process handle".into()));
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut exit_code = 0u32;
        let exit_result = GetExitCodeProcess(info.hProcess, &mut exit_code);
        let _ = CloseHandle(info.hProcess);
        exit_result.map_err(|e| AppError::Process(format!("could not read elevated helper exit code: {e}")))?;
        Ok(exit_code as i32)
    }
    #[cfg(not(windows))]
    {
        let _ = (program, parameters);
        Err(AppError::Other("elevation is only supported on Windows".into()))
    }
}

/// Guard used by destructive commands.
pub fn require_elevation(what: &str) -> AppResult<()> {
    if is_elevated() {
        Ok(())
    } else {
        Err(AppError::ElevationRequired(what.to_string()))
    }
}
