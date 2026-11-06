//! Windows shell integration: Snap Layouts on the custom maximize button, recent files in the taskbar jump list,
//! and making PDForge the default PDF app. On other systems these do nothing.

/// Where the "Make default" registration lives (per user, no administrator rights needed).
#[cfg_attr(not(windows), allow(dead_code))]
const PROG_ID: &str = "PDForge.Document";
#[cfg_attr(not(windows), allow(dead_code))]
const CAPABILITIES: &str = r"Software\PDForge\Capabilities";
#[cfg_attr(not(windows), allow(dead_code))]
const REGISTERED_NAME: &str = "PDForge";

/// Two paths name the same file (Windows paths aren't case-sensitive; `\\?\` prefixes and quotes are ignored).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn same_exe(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_matches('"').trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
    !a.trim().is_empty() && norm(a) == norm(b)
}

#[cfg(windows)]
mod imp {
    use super::{same_exe, CAPABILITIES, PROG_ID, REGISTERED_NAME};
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN,
    };
    use windows::Win32::UI::Shell::{
        AssocQueryStringW, SHAddToRecentDocs, SHChangeNotify, ShellExecuteW, ASSOCF_NONE, ASSOCSTR_EXECUTABLE, SHARD_PATHW,
        SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SW_SHOWNORMAL};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn reg_string(root: HKEY, key: &str, name: &str) -> Option<String> {
        let (key, name) = (wide(key), wide(name));
        let mut buf = vec![0u16; 512];
        let mut size = (buf.len() * 2) as u32;
        let ok = unsafe {
            RegGetValueW(root, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size))
        };
        if ok.is_err() {
            return None;
        }
        let len = (size as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buf[..len.min(buf.len())]))
    }

    fn reg_dword(root: HKEY, key: &str, name: &str) -> Option<u32> {
        let (key, name) = (wide(key), wide(name));
        let mut value = 0u32;
        let mut size = 4u32;
        let ok = unsafe {
            RegGetValueW(root, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr()), RRF_RT_REG_DWORD, None, Some((&mut value as *mut u32).cast()), Some(&mut size))
        };
        ok.is_ok().then_some(value)
    }

    /// Writes a string value under HKEY_CURRENT_USER, creating the key. `name` "" is the key's default value.
    fn set_user_string(key: &str, name: &str, value: &str) -> Result<(), String> {
        let key_w = wide(key);
        let mut hkey = HKEY::default();
        unsafe {
            RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(key_w.as_ptr()), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut hkey, None)
                .ok()
                .map_err(|e| format!("Couldn't write to the registry ({key}): {e}"))?;
            let data = wide(value);
            let bytes = std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), data.len() * 2);
            let name_w = wide(name);
            let r = RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), None, REG_SZ, Some(bytes));
            let _ = RegCloseKey(hkey);
            r.ok().map_err(|e| format!("Couldn't write to the registry ({key}): {e}"))
        }
    }

    fn windows_build() -> u32 {
        reg_string(HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber")
            .and_then(|b| b.trim().parse().ok())
            .unwrap_or(0)
    }

    /// Opens the Snap Layouts flyout for this window, the way Windows 11 does when you rest on a maximize button.
    /// PDForge draws its own title bar, so Windows doesn't know where its maximize button is; pressing Win+Z for the
    /// user gets the same flyout. Skipped unless this is Windows 11 with snap layouts turned on, and the window is
    /// in front (Win+Z acts on whichever window is active).
    pub fn show_snap_layouts(hwnd: HWND) -> bool {
        if windows_build() < 22000 {
            return false;
        }
        let advanced = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
        if reg_dword(HKEY_CURRENT_USER, advanced, "EnableSnapAssistFlyout") == Some(0) {
            return false;
        }
        if reg_string(HKEY_CURRENT_USER, r"Control Panel\Desktop", "WindowArrangementActive").as_deref() == Some("0") {
            return false;
        }
        if unsafe { GetForegroundWindow() } != hwnd {
            return false;
        }
        let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
            },
        };
        let z = VIRTUAL_KEY(b'Z' as u16);
        let inputs = [key(VK_LWIN, false), key(z, false), key(z, true), key(VK_LWIN, true)];
        unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) as usize == inputs.len() }
    }

    /// Adds a file to Windows' recent items, which puts it in PDForge's taskbar jump list.
    pub fn add_recent_document(path: &str) {
        let p = wide(path);
        unsafe { SHAddToRecentDocs(SHARD_PATHW.0 as u32, Some(p.as_ptr().cast())) };
    }

    /// The program Windows opens .pdf files with, if it can tell.
    fn pdf_handler() -> Option<String> {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let r = unsafe { AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_EXECUTABLE, &HSTRING::from(".pdf"), &HSTRING::from("open"), Some(PWSTR(buf.as_mut_ptr())), &mut len) };
        if r.is_err() || len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..(len as usize - 1).min(buf.len())]))
    }

    /// "yes" when PDForge opens .pdf files, "no" when another app does, "unknown" when Windows doesn't say.
    pub fn default_pdf_app() -> &'static str {
        let Ok(me) = std::env::current_exe() else { return "unknown" };
        match pdf_handler() {
            Some(h) if same_exe(&h, &me.to_string_lossy()) => "yes",
            Some(_) => "no",
            None => "unknown",
        }
    }

    /// Lists PDForge in Settings > Default apps (per user), then opens its page there, where the user picks it for .pdf.
    /// Windows doesn't let apps make themselves the default; the choice is the user's.
    pub fn open_default_app_settings() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_string_lossy();
        let classes = format!(r"Software\Classes\{PROG_ID}");
        set_user_string(&classes, "", "PDF document")?;
        set_user_string(&format!(r"{classes}\DefaultIcon"), "", &format!("\"{exe}\",0"))?;
        set_user_string(&format!(r"{classes}\shell\open\command"), "", &format!("\"{exe}\" \"%1\""))?;
        set_user_string(r"Software\Classes\.pdf\OpenWithProgids", PROG_ID, "")?;
        set_user_string(CAPABILITIES, "ApplicationName", "PDForge")?;
        set_user_string(CAPABILITIES, "ApplicationDescription", "Read, edit, sign and organize PDF documents.")?;
        set_user_string(CAPABILITIES, "ApplicationIcon", &format!("\"{exe}\",0"))?;
        set_user_string(&format!(r"{CAPABILITIES}\FileAssociations"), ".pdf", PROG_ID)?;
        set_user_string(r"Software\RegisteredApplications", REGISTERED_NAME, CAPABILITIES)?;
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
        // Opens PDForge's own page in Default apps (Windows 11); older versions show the Default apps list.
        let uri = HSTRING::from(format!("ms-settings:defaultapps?registeredAppUser={REGISTERED_NAME}"));
        let r = unsafe { ShellExecuteW(None, &HSTRING::from("open"), &uri, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        if r.0 as isize <= 32 {
            return Err("Windows Settings didn't open. Open Settings > Apps > Default apps and choose PDForge for .pdf.".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub fn show_snap_layouts(window: tauri::WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        match window.hwnd() {
            Ok(hwnd) => imp::show_snap_layouts(windows::Win32::Foundation::HWND(hwnd.0)),
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

#[tauri::command]
pub fn add_recent_document(path: String) {
    #[cfg(windows)]
    imp::add_recent_document(&path);
    #[cfg(not(windows))]
    let _ = path;
}

#[tauri::command]
pub fn default_pdf_app() -> &'static str {
    #[cfg(windows)]
    return imp::default_pdf_app();
    #[cfg(not(windows))]
    "unknown"
}

#[tauri::command]
pub fn open_default_app_settings() -> Result<(), String> {
    #[cfg(windows)]
    return imp::open_default_app_settings();
    #[cfg(not(windows))]
    Err("Only available on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::same_exe;

    #[test]
    fn compares_windows_exe_paths() {
        assert!(same_exe(r"C:\Users\Me\AppData\Local\PDForge\pdforge.exe", r"c:\users\me\appdata\local\pdforge\PDForge.EXE"));
        assert!(same_exe(r#""C:\Apps\pdforge.exe""#, r"\\?\C:\Apps\pdforge.exe"));
        assert!(!same_exe(r"C:\Program Files\Edge\msedge.exe", r"C:\Apps\pdforge.exe"));
        assert!(!same_exe("", r"C:\Apps\pdforge.exe"));
    }
}
