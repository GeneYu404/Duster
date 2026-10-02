//! Parses `UninstallString` / `QuietUninstallString` values and runs them.
//!
//! * `MsiExec.exe /I{GUID}` and `/X{GUID}` are normalised to `msiexec.exe /x {GUID}`
//!   (`/qn /norestart` appended for quiet mode).
//! * Quoted paths, unquoted paths with spaces and trailing arguments are handled.
//! * When the current process is not elevated the uninstaller is started through
//!   `ShellExecuteExW("runas")` so the UAC prompt appears; otherwise `CreateProcess`.
//! * Exit codes are interpreted (0 / 3010 success, 1602 cancelled, 1605 already gone, ...).

use crate::app_model::{InstalledApp, ParsedCommand, UninstallResult};
use crate::error::{AppError, AppResult};
use regex::Regex;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

fn msi_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)^\s*"?[^"\r\n]*?msiexec(?:\.exe)?"?\s+[/-]\s*([ix])\s*(\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\})(.*)$"#).unwrap()
    })
}

fn environment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"%([^%]+)%").expect("valid environment-variable regex"))
}

pub fn expand_environment(command: &str) -> String {
    environment_re()
        .replace_all(command, |caps: &regex::Captures<'_>| {
            std::env::var_os(&caps[1])
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| caps[0].to_string())
        })
        .into_owned()
}

pub fn parse_command(command: &str, quiet: bool) -> AppResult<ParsedCommand> {
    let expanded = expand_environment(command);
    let s = expanded.trim();
    if s.is_empty() {
        return Err(AppError::InvalidCommand("empty command".into()));
    }

    if let Some(caps) = msi_re().captures(s) {
        let code = caps[2].to_uppercase();
        let extra = caps[3].trim();
        let mut parts = vec!["/x".to_string(), code];
        if !extra.is_empty() {
            parts.push(extra.to_string());
        }
        if quiet {
            let extra_lower = extra.to_ascii_lowercase();
            if !extra_lower.contains("/qn") && !extra_lower.contains("/quiet") {
                parts.push("/qn".into());
            }
            if !extra_lower.contains("/norestart") {
                parts.push("/norestart".into());
            }
        }
        let args = parts.join(" ");
        return Ok(ParsedCommand { normalized: format!("msiexec.exe {args}"), program: "msiexec.exe".into(), args, is_msi: true });
    }

    let (program, args) = if let Some(rest) = s.strip_prefix('"') {
        match rest.find('"') {
            Some(end) => (rest[..end].to_string(), rest[end + 1..].trim().to_string()),
            None => (rest.to_string(), String::new()),
        }
    } else {
        split_unquoted(s)
    };

    if program.is_empty() {
        return Err(AppError::InvalidCommand(command.to_string()));
    }
    let quoted = if program.contains(' ') { format!("\"{program}\"") } else { program.clone() };
    let normalized = if args.is_empty() { quoted } else { format!("{quoted} {args}") };
    let is_msi = program.to_lowercase().ends_with("msiexec.exe") || program.eq_ignore_ascii_case("msiexec");
    Ok(ParsedCommand { program, args, is_msi, normalized })
}

/// `C:\Program Files\Foo\unins000.exe /SILENT` → program up to the first existing `.exe`
/// (checked on disk), falling back to the first `.exe`/`.cmd`/`.bat` boundary, then the first space.
fn split_unquoted(s: &str) -> (String, String) {
    let lower = s.to_ascii_lowercase();
    let mut search_from = 0usize;
    let mut first_boundary: Option<usize> = None;
    while let Some(pos) = lower[search_from..].find(".exe") {
        let end = search_from + pos + 4;
        if first_boundary.is_none() {
            first_boundary = Some(end);
        }
        let candidate = &s[..end];
        if Path::new(candidate).is_file() {
            return (candidate.to_string(), s[end..].trim().to_string());
        }
        search_from = end;
        if search_from >= lower.len() {
            break;
        }
    }
    if let Some(end) = first_boundary.or_else(|| lower.find(".cmd").or_else(|| lower.find(".bat")).map(|p| p + 4)) {
        return (s[..end].to_string(), s[end..].trim().to_string());
    }
    match s.find(' ') {
        Some(i) => (s[..i].to_string(), s[i + 1..].trim().to_string()),
        None => (s.to_string(), String::new()),
    }
}

/// Resolve the program path: absolute paths are used as-is; bare names (msiexec.exe,
/// wusa.exe, powershell.exe) are looked up in System32 / PATH.
fn program_exists(program: &str) -> bool {
    let p = Path::new(program);
    if p.is_absolute() {
        return p.is_file();
    }
    if let Ok(windir) = std::env::var("SystemRoot") {
        if Path::new(&windir).join("System32").join(program).is_file() {
            return true;
        }
        if program.eq_ignore_ascii_case("powershell.exe")
            && Path::new(&windir).join(r"System32\WindowsPowerShell\v1.0").join(program).is_file()
        {
            return true;
        }
    }
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
        .unwrap_or(false)
}

pub fn describe_exit_code(code: i32) -> (&'static str, bool, bool, bool) {
    // (message, success, reboot_required, cancelled)
    match code {
        0 => ("Uninstalled successfully", true, false, false),
        3010 | 1641 => ("Uninstalled; a restart is required", true, true, false),
        1602 | 1223 => ("Cancelled by the user", false, false, true),
        1605 => ("Product is not installed (already removed)", true, false, false),
        1603 => ("Fatal error during installation (1603)", false, false, false),
        1618 => ("Another installation is already in progress (1618)", false, false, false),
        2 => ("The system cannot find the file specified", false, false, false),
        5 => ("Access denied", false, false, false),
        _ => ("Uninstaller exited with a non-zero code", false, false, false),
    }
}

/// Runs the uninstaller for `app`, streaming log lines through `on_log`.
pub fn run(app: &InstalledApp, quiet: bool, elevated: bool, mut on_log: impl FnMut(String)) -> AppResult<UninstallResult> {
    let started = Instant::now();
    let mut log: Vec<String> = Vec::new();
    let mut emit = |line: String, log: &mut Vec<String>| {
        let stamped = format!("[{}] {}", chrono::Local::now().format("%H:%M:%S"), line);
        log.push(stamped.clone());
        on_log(stamped);
    };

    let source = if quiet { app.quiet_uninstall_string.as_deref().or(app.uninstall_string.as_deref()) } else { app.uninstall_string.as_deref() };
    emit(format!("Resolving uninstall command for \"{}\"…", app.name), &mut log);
    let Some(source) = source else {
        emit("No UninstallString / QuietUninstallString in the registry key.".into(), &mut log);
        return Ok(UninstallResult {
            app_id: app.id.clone(),
            success: false,
            exit_code: None,
            reboot_required: false,
            cancelled: false,
            message: "No uninstall command available".into(),
            command_line: String::new(),
            duration_ms: started.elapsed().as_millis(),
            log,
        });
    };

    let parsed = parse_command(source, quiet)?;
    emit(format!("Command: {}", parsed.normalized), &mut log);

    if !program_exists(&parsed.program) {
        emit(format!("Uninstaller not found on disk: {}", parsed.program), &mut log);
        return Ok(UninstallResult {
            app_id: app.id.clone(),
            success: false,
            exit_code: Some(2),
            reboot_required: false,
            cancelled: false,
            message: "Uninstaller executable is missing".into(),
            command_line: parsed.normalized,
            duration_ms: started.elapsed().as_millis(),
            log,
        });
    }

    let exit_code = if elevated {
        emit("Launching process…".into(), &mut log);
        spawn_and_wait(&parsed)?
    } else {
        emit("Not elevated — launching through ShellExecute(runas), UAC prompt expected…".into(), &mut log);
        spawn_elevated_and_wait(&parsed)?
    };

    let (message, success, reboot_required, cancelled) = describe_exit_code(exit_code);
    emit(format!("Process exited with code {exit_code}: {message}"), &mut log);
    tracing::info!(app = %app.name, exit_code, success, "uninstall finished");

    Ok(UninstallResult {
        app_id: app.id.clone(),
        success,
        exit_code: Some(exit_code),
        reboot_required,
        cancelled,
        message: message.to_string(),
        command_line: parsed.normalized,
        duration_ms: started.elapsed().as_millis(),
        log,
    })
}

#[cfg(windows)]
fn spawn_and_wait(cmd: &ParsedCommand) -> AppResult<i32> {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new(&cmd.program);
    if !cmd.args.is_empty() {
        // Pass the argument string verbatim – uninstallers are picky about quoting.
        c.raw_arg(&cmd.args);
    }
    let status = c.status().map_err(|e| AppError::Process(format!("CreateProcess failed for {}: {e}", cmd.program)))?;
    Ok(status.code().unwrap_or(-1))
}

#[cfg(windows)]
fn spawn_elevated_and_wait(cmd: &ParsedCommand) -> AppResult<i32> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb = HSTRING::from("runas");
    let file = HSTRING::from(cmd.program.as_str());
    let params = HSTRING::from(cmd.args.as_str());
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: HWND::default(),
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe {
        if let Err(e) = ShellExecuteExW(&mut info) {
            // ERROR_CANCELLED (1223) means the user declined the UAC prompt.
            if (e.code().0 as u32 & 0xffff) == 1223 {
                return Ok(1223);
            }
            return Err(AppError::Process(format!("ShellExecuteEx failed: {e}")));
        }
        if info.hProcess.is_invalid() {
            return Err(AppError::Process("ShellExecuteEx returned no process handle".into()));
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code: u32 = 0;
        GetExitCodeProcess(info.hProcess, &mut code).map_err(|e| AppError::Process(format!("GetExitCodeProcess failed: {e}")))?;
        let _ = CloseHandle(info.hProcess);
        Ok(code as i32)
    }
}

#[cfg(not(windows))]
fn spawn_and_wait(_cmd: &ParsedCommand) -> AppResult<i32> {
    Err(AppError::Other("uninstall is only supported on Windows".into()))
}

#[cfg(not(windows))]
fn spawn_elevated_and_wait(cmd: &ParsedCommand) -> AppResult<i32> {
    spawn_and_wait(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_msiexec() {
        let p = parse_command("MsiExec.exe /I{8A69D345-D564-463C-AFF1-A69D9E530F96}", true).unwrap();
        assert_eq!(p.normalized, "msiexec.exe /x {8A69D345-D564-463C-AFF1-A69D9E530F96} /qn /norestart");
        assert!(p.is_msi);
    }

    #[test]
    fn normalises_quoted_msi_path() {
        let p = parse_command(r#""C:\Windows\System32\MsiExec.exe" /I{8A69D345-D564-463C-AFF1-A69D9E530F96}"#, false).unwrap();
        assert_eq!(p.normalized, "msiexec.exe /x {8A69D345-D564-463C-AFF1-A69D9E530F96}");
    }

    #[test]
    fn handles_quoted_paths() {
        let p = parse_command(r#""C:\Program Files\Foo Bar\unins000.exe" /SILENT"#, false).unwrap();
        assert_eq!(p.program, r"C:\Program Files\Foo Bar\unins000.exe");
        assert_eq!(p.args, "/SILENT");
    }

    #[test]
    fn handles_unquoted_paths_with_spaces() {
        let p = parse_command(r"C:\Program Files\Foo\uninstall.exe --uninstall -s", false).unwrap();
        assert_eq!(p.program, r"C:\Program Files\Foo\uninstall.exe");
        assert_eq!(p.args, "--uninstall -s");
    }
}
