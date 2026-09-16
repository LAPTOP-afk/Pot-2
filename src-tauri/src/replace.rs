// 跨平台"译文替换原文"基础设施：
// - capture_foreground(): 记录划词瞬间的前台窗口（Win=HWND, macOS=PID）
// - paste_replace(): 写剪贴板 -> 恢复前台焦点 -> 模拟粘贴 -> 可选恢复剪贴板
use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use log::{info, warn};
use once_cell::sync::OnceCell;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

// 触发划词时的前台窗口标识：Windows 为 HWND，macOS 为进程 PID
static LAST_FOREGROUND: OnceCell<Mutex<Option<u64>>> = OnceCell::new();
// 剪贴板监听抑制窗口：在此时间点之前，剪贴板监听到变化不触发翻译
static SUPPRESS_UNTIL: OnceCell<Mutex<Option<Instant>>> = OnceCell::new();

fn last_foreground() -> &'static Mutex<Option<u64>> {
    LAST_FOREGROUND.get_or_init(|| Mutex::new(None))
}

fn suppress_until() -> &'static Mutex<Option<Instant>> {
    SUPPRESS_UNTIL.get_or_init(|| Mutex::new(None))
}

/// 在划词类入口（快捷键回调、目标应用仍在前台时）记录原前台窗口
pub fn capture_foreground() {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        unsafe {
            let hwnd = GetForegroundWindow();
            if !hwnd.0.is_null() {
                *last_foreground().lock().unwrap() = Some(hwnd.0 as u64);
                info!("Captured foreground HWND: {:#x}", hwnd.0 as u64);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};
        unsafe {
            let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            let app: *mut Object = msg_send![workspace, frontmostApplication];
            if !app.is_null() {
                let pid: i32 = msg_send![app, processIdentifier];
                *last_foreground().lock().unwrap() = Some(pid as u64);
                info!("Captured foreground application PID: {}", pid);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Linux/X11 下不保存窗口句柄，依赖隐藏 Pot 窗口后焦点自然回落（best-effort）
    }
}

/// 恢复先前记录的前台窗口焦点
fn restore_foreground() {
    let saved = last_foreground().lock().unwrap().clone();
    let Some(saved) = saved else {
        info!("No foreground window recorded, skip restore");
        return;
    };

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{BOOL, HWND};
        use windows::Win32::System::Threading::{
            AttachThreadInput, GetCurrentThreadId,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, GetWindowThreadProcessId, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };
        unsafe {
            let hwnd = HWND(saved as *mut core::ffi::c_void);
            let current_thread = GetCurrentThreadId();
            let target_thread = GetWindowThreadProcessId(hwnd, None);
            // AttachThreadInput 技巧绕过 Windows 前台窗口锁定
            let _ = AttachThreadInput(current_thread, target_thread, BOOL(1));
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(current_thread, target_thread, BOOL(0));
            info!("Restored foreground HWND: {:#x}", saved);
        }
    }
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};
        unsafe {
            let app: *mut Object =
                msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: saved as i32];
            if !app.is_null() {
                // NSApplicationActivateIgnoringOtherApps = 1 << 1
                let _: () = msg_send![app, activateWithOptions: 1u64 << 1];
                info!("Restored foreground application PID: {}", saved);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        // best-effort：无操作
    }
}

/// 供剪贴板监听器调用：当前是否处于"程序性写剪贴板"抑制期
pub fn is_clipboard_suppressed() -> bool {
    let mut guard = suppress_until().lock().unwrap();
    match *guard {
        Some(until) => {
            if Instant::now() < until {
                true
            } else {
                *guard = None;
                false
            }
        }
        None => false,
    }
}

/// 发送粘贴快捷键（macOS: Cmd+V，其他: Ctrl+V）
fn send_paste() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 将译文写入剪贴板并模拟粘贴替换选中原文
/// - text: 译文（空则直接报错且不动剪贴板）
/// - restore_clipboard: 粘贴后是否恢复剪贴板原内容
#[tauri::command(async)]
pub fn paste_replace(text: String, restore_clipboard: bool) -> Result<(), String> {
    if text.trim().is_empty() {
        warn!("paste_replace called with empty text, aborted");
        return Err("Empty translation, nothing to paste".to_string());
    }

    let mut clipboard = Clipboard::new().map_err(|e| format!("Open clipboard failed: {e}"))?;
    let backup = clipboard.get_text().ok();
    // 抑制剪贴板监听，避免程序性写入触发监听翻译（覆盖写入与恢复两次变化）
    *suppress_until().lock().unwrap() = Some(Instant::now() + Duration::from_millis(1500));
    clipboard
        .set_text(text.clone())
        .map_err(|e| format!("Set clipboard failed: {e}"))?;
    drop(clipboard);
    info!(
        "paste_replace: clipboard set ({} chars), restoring foreground then pasting",
        text.chars().count()
    );

    restore_foreground();
    // 等待焦点切换动画/系统响应
    thread::sleep(Duration::from_millis(120));

    if let Err(e) = send_paste() {
        warn!("paste_replace: send paste failed: {e}");
        // 粘贴失败：尽力恢复剪贴板，避免污染用户数据
        if let Some(prev) = backup {
            if let Ok(mut cb) = Clipboard::new() {
                let _ = cb.set_text(prev);
            }
        }
        return Err(e);
    }

    if restore_clipboard {
        if let Some(prev) = backup {
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(500));
                if let Ok(mut cb) = Clipboard::new() {
                    if cb.set_text(prev).is_ok() {
                        info!("paste_replace: clipboard restored to previous content");
                    }
                }
            });
        }
    }
    Ok(())
}
