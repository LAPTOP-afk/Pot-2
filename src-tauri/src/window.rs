use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config::get;
use crate::config::set;
use crate::StringWrapper;
use crate::APP;
use dirs::cache_dir;
use log::{info, warn};
use tauri::Manager;
use tauri::Monitor;
use tauri::Window;
use tauri::WindowBuilder;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use window_shadows::set_shadow;

// 静默截图识别模式标记（识别窗保持隐藏，后台识别后复制/通知并关闭）
static SILENT_RECOGNIZE: AtomicBool = AtomicBool::new(false);

// 未选中文本时的系统通知（静默入口不弹任何窗口，仅提示）
fn notify_no_selection() {
    if let Some(app_handle) = APP.get() {
        let _ = tauri::api::notification::Notification::new(
            &app_handle.config().tauri.bundle.identifier,
        )
        .title("Pot2")
        .body("No text selected. Please select text first.")
        .icon("pot")
        .show();
    }
}

#[tauri::command]
pub fn get_recognize_mode() -> String {
    if SILENT_RECOGNIZE.load(Ordering::Relaxed) {
        "silent".to_string()
    } else {
        String::new()
    }
}

#[tauri::command]
pub fn set_recognize_mode(mode: String) {
    SILENT_RECOGNIZE.store(mode == "silent", Ordering::Relaxed);
}

// Get daemon window instance
fn get_daemon_window() -> Window {
    let app_handle = APP.get().unwrap();
    match app_handle.get_window("daemon") {
        Some(v) => v,
        None => {
            warn!("Daemon window not found, create new daemon window!");
            WindowBuilder::new(
                app_handle,
                "daemon",
                tauri::WindowUrl::App("daemon.html".into()),
            )
            .title("Daemon")
            .additional_browser_args("--disable-web-security")
            .visible(false)
            .build()
            .unwrap()
        }
    }
}

// Get monitor where the mouse is currently located
fn get_current_monitor(x: i32, y: i32) -> Monitor {
    info!("Mouse position: {}, {}", x, y);
    let daemon_window = get_daemon_window();
    let monitors = daemon_window.available_monitors().unwrap();

    for m in monitors {
        let size = m.size();
        let position = m.position();

        if x >= position.x
            && x <= (position.x + size.width as i32)
            && y >= position.y
            && y <= (position.y + size.height as i32)
        {
            info!("Current Monitor: {:?}", m);
            return m;
        }
    }
    warn!("Current Monitor not found, using primary monitor");
    daemon_window.primary_monitor().unwrap().unwrap()
}

// Creating a window on the mouse monitor
fn build_window(label: &str, title: &str) -> (Window, bool) {
    build_window_inner(label, title, true)
}

// Quiet variant: when reusing an existing window, do not steal focus
fn build_window_quiet(label: &str, title: &str) -> (Window, bool) {
    build_window_inner(label, title, false)
}

fn build_window_inner(label: &str, title: &str, focus_existing: bool) -> (Window, bool) {
    use mouse_position::mouse_position::{Mouse, Position};

    let mouse_position = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Position { x, y },
        Mouse::Error => {
            warn!("Mouse position not found, using (0, 0) as default");
            Position { x: 0, y: 0 }
        }
    };
    let current_monitor = get_current_monitor(mouse_position.x, mouse_position.y);
    let position = current_monitor.position();

    let app_handle = APP.get().unwrap();
    match app_handle.get_window(label) {
        Some(v) => {
            info!("Window existence: {}", label);
            if focus_existing {
                v.set_focus().unwrap();
            }
            (v, true)
        }
        None => {
            info!("Window not existence, Creating new window: {}", label);
            let mut builder = tauri::WindowBuilder::new(
                app_handle,
                label,
                tauri::WindowUrl::App("index.html".into()),
            )
            .position(position.x.into(), position.y.into())
            .additional_browser_args("--disable-web-security")
            .focused(true)
            .title(title)
            .visible(false);

            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.transparent(true).decorations(false);
            }
            let window = builder.build().unwrap();

            // 截图与译文叠加是透明覆盖层，加投影会出现可见边框
            if label != "screenshot" && label != "overlay" {
                #[cfg(not(target_os = "linux"))]
                set_shadow(&window, true).unwrap_or_default();
            }
            let _ = window.current_monitor();
            (window, false)
        }
    }
}

pub fn config_window() {
    let (window, _exists) = build_window("config", "Config");
    window
        .set_min_size(Some(tauri::LogicalSize::new(800, 400)))
        .unwrap();
    window.set_size(tauri::LogicalSize::new(800, 600)).unwrap();
    window.center().unwrap();
}

fn translate_window() -> Window {
    use mouse_position::mouse_position::{Mouse, Position};
    // Mouse physical position
    let mut mouse_position = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Position { x, y },
        Mouse::Error => {
            warn!("Mouse position not found, using (0, 0) as default");
            Position { x: 0, y: 0 }
        }
    };
    let (window, exists) = build_window("translate", "Translate");
    if exists {
        return window;
    }
    window.set_skip_taskbar(true).unwrap();
    // Get Translate Window Size
    let width = match get("translate_window_width") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("translate_window_width", 350);
            350
        }
    };
    let height = match get("translate_window_height") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("translate_window_height", 420);
            420
        }
    };

    let monitor = window.current_monitor().unwrap().unwrap();
    let dpi = monitor.scale_factor();

    window
        .set_size(tauri::PhysicalSize::new(
            (width as f64) * dpi,
            (height as f64) * dpi,
        ))
        .unwrap();

    let position_type = match get("translate_window_position") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => "mouse".to_string(),
    };

    match position_type.as_str() {
        "mouse" => {
            // Adjust window position
            let monitor_size = monitor.size();
            let monitor_size_width = monitor_size.width as f64;
            let monitor_size_height = monitor_size.height as f64;
            let monitor_position = monitor.position();
            let monitor_position_x = monitor_position.x as f64;
            let monitor_position_y = monitor_position.y as f64;

            if mouse_position.x as f64 + width as f64 * dpi
                > monitor_position_x + monitor_size_width
            {
                mouse_position.x -= (width as f64 * dpi) as i32;
                if (mouse_position.x as f64) < monitor_position_x {
                    mouse_position.x = monitor_position_x as i32;
                }
            }
            if mouse_position.y as f64 + height as f64 * dpi
                > monitor_position_y + monitor_size_height
            {
                mouse_position.y -= (height as f64 * dpi) as i32;
                if (mouse_position.y as f64) < monitor_position_y {
                    mouse_position.y = monitor_position_y as i32;
                }
            }

            window
                .set_position(tauri::PhysicalPosition::new(
                    mouse_position.x,
                    mouse_position.y,
                ))
                .unwrap();
        }
        _ => {
            let position_x = match get("translate_window_position_x") {
                Some(v) => v.as_i64().unwrap(),
                None => 0,
            };
            let position_y = match get("translate_window_position_y") {
                Some(v) => v.as_i64().unwrap(),
                None => 0,
            };
            window
                .set_position(tauri::PhysicalPosition::new(
                    (position_x as f64) * dpi,
                    (position_y as f64) * dpi,
                ))
                .unwrap();
        }
    }

    window
}

pub fn selection_translate() {
    use selection::get_text;
    // Record the foreground app before Pot window takes focus (for paste replacement)
    crate::replace::capture_foreground();
    // Get Selected Text
    let text = get_text();
    if !text.trim().is_empty() {
        let app_handle = APP.get().unwrap();
        // Write into State
        let state: tauri::State<StringWrapper> = app_handle.state();
        state.0.lock().unwrap().replace_range(.., &text);
    }

    let window = translate_window();
    window.emit("new_text", text).unwrap();
}

// Selection translate then silently paste-replace the original selection (no popup)
pub fn selection_replace_translate() {
    use selection::get_text;
    // Record the foreground app before Pot window takes focus (for paste replacement)
    crate::replace::capture_foreground();
    let text = get_text();
    if !text.trim().is_empty() {
        let app_handle = APP.get().unwrap();
        // Write marked text into State
        let state: tauri::State<StringWrapper> = app_handle.state();
        let marked = format!("[SELECTION_REPLACE]{}", text);
        state.0.lock().unwrap().replace_range(.., &marked);
        // Reuse/create the translate window but keep it hidden
        let _ = build_window_quiet("translate", "Pot2");
        app_handle
            .emit_to("translate", "new_text", marked)
            .unwrap();
    } else {
        // 文本为空时仅通知，不弹任何窗口
        notify_no_selection();
    }
}

// Compact action menu window near the mouse cursor
pub fn action_menu_window() -> Window {
    use mouse_position::mouse_position::{Mouse, Position};
    let mut mouse_position = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Position { x, y },
        Mouse::Error => {
            warn!("Mouse position not found, using (0, 0) as default");
            Position { x: 0, y: 0 }
        }
    };

    let (window, _exists) = build_window("action_menu", "Pot2");
    window.set_skip_taskbar(true).unwrap();
    window.set_always_on_top(true).unwrap();
    window.set_resizable(false).unwrap();

    // Window height follows the number of enabled actions
    let action_count = match get("selection_action_list") {
        Some(v) => v.as_array().map(|a| a.len()).unwrap_or(6),
        None => 6,
    }
    .clamp(1, 6);
    let width: f64 = 260.0;
    // 与前端 DOM 一致：外层 py-8(16) + CardBody p-4(8) + 每个按钮 h-40
    let height: f64 = 24.0 + action_count as f64 * 40.0;

    let monitor = window.current_monitor().unwrap().unwrap();
    let dpi = monitor.scale_factor();
    window
        .set_size(tauri::PhysicalSize::new(
            (width * dpi) as u32,
            (height * dpi) as u32,
        ))
        .unwrap();

    // Keep the menu inside the monitor bounds
    let monitor_size = monitor.size();
    let monitor_position = monitor.position();
    if mouse_position.x as f64 + width * dpi
        > monitor_position.x as f64 + monitor_size.width as f64
    {
        mouse_position.x -= (width * dpi) as i32;
        if mouse_position.x < monitor_position.x {
            mouse_position.x = monitor_position.x;
        }
    }
    if mouse_position.y as f64 + height * dpi
        > monitor_position.y as f64 + monitor_size.height as f64
    {
        mouse_position.y -= (height * dpi) as i32;
        if mouse_position.y < monitor_position.y {
            mouse_position.y = monitor_position.y;
        }
    }
    window
        .set_position(tauri::PhysicalPosition::new(
            mouse_position.x,
            mouse_position.y,
        ))
        .unwrap();
    window.show().unwrap();
    window.set_focus().unwrap();
    window
}

// Pop the selection action menu for the currently selected text
pub fn selection_action_menu() {
    use selection::get_text;
    // Record the foreground app (used by the replace action)
    crate::replace::capture_foreground();
    let text = get_text();
    if !text.trim().is_empty() {
        let app_handle = APP.get().unwrap();
        let state: tauri::State<StringWrapper> = app_handle.state();
        state.0.lock().unwrap().replace_range(.., &text);
        let window = action_menu_window();
        window.emit("new_text", text).unwrap();
    } else {
        // 无选中文本时仅通知，不弹菜单
        notify_no_selection();
    }
}

// Command: run the silent translate-and-replace pipeline with text provided by the action menu
#[tauri::command]
pub fn replace_translate_text(text: String) {
    if !text.trim().is_empty() {
        let app_handle = APP.get().unwrap();
        let state: tauri::State<StringWrapper> = app_handle.state();
        let marked = format!("[SELECTION_REPLACE]{}", text);
        state.0.lock().unwrap().replace_range(.., &marked);
        let _ = build_window_quiet("translate", "Pot2");
        app_handle
            .emit_to("translate", "new_text", marked)
            .unwrap();
    }
}

// 叠加窗不支持/失败时，带着 OCR 文本回退到常规图片翻译窗
#[tauri::command]
pub fn image_translate_text(text: String) {
    if !text.trim().is_empty() {
        let app_handle = APP.get().unwrap();
        let state: tauri::State<StringWrapper> = app_handle.state();
        let marked = format!("[IMAGE_TRANSLATE]{}", text);
        state.0.lock().unwrap().replace_range(.., &marked);
        let _ = build_window_quiet("translate", "Pot2");
        app_handle
            .emit_to("translate", "new_text", marked)
            .unwrap();
    }
}

pub fn input_translate() {
    let app_handle = APP.get().unwrap();
    // Clear State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state
        .0
        .lock()
        .unwrap()
        .replace_range(.., "[INPUT_TRANSLATE]");
    let window = translate_window();
    let position_type = match get("translate_window_position") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => "mouse".to_string(),
    };
    if position_type == "mouse" {
        window.center().unwrap();
    }

    window.emit("new_text", "[INPUT_TRANSLATE]").unwrap();
}

#[tauri::command]
pub fn text_translate(text: String) {
    let app_handle = APP.get().unwrap();
    // Clear State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state.0.lock().unwrap().replace_range(.., &text);
    let window = translate_window();
    window.emit("new_text", text).unwrap();
}

pub fn image_translate() {
    let app_handle = APP.get().unwrap();
    let state: tauri::State<StringWrapper> = app_handle.state();
    state
        .0
        .lock()
        .unwrap()
        .replace_range(.., "[IMAGE_TRANSLATE]");
    let window = translate_window();
    window.emit("new_text", "[IMAGE_TRANSLATE]").unwrap();
}

pub fn recognize_window() {
    let (window, exists) = build_window("recognize", "Recognize");
    if exists {
        window.emit("new_image", "").unwrap();
        return;
    }
    let width = match get("recognize_window_width") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("recognize_window_width", 800);
            800
        }
    };
    let height = match get("recognize_window_height") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("recognize_window_height", 400);
            400
        }
    };
    let monitor = window.current_monitor().unwrap().unwrap();
    let dpi = monitor.scale_factor();
    window
        .set_size(tauri::PhysicalSize::new(
            (width as f64) * dpi,
            (height as f64) * dpi,
        ))
        .unwrap();
    window.center().unwrap();
    window.emit("new_image", "").unwrap();
}

// 静默识别：复用 recognize 窗但不抢焦点、不显示，后台识别完成后由前端自行关闭
pub fn recognize_window_silent() {
    SILENT_RECOGNIZE.store(true, Ordering::Relaxed);
    let (window, exists) = build_window_quiet("recognize", "Recognize");
    window.set_skip_taskbar(true).unwrap();
    if exists {
        window.emit("new_image", "[SILENT]").unwrap();
        return;
    }
    let width = match get("recognize_window_width") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("recognize_window_width", 800);
            800
        }
    };
    let height = match get("recognize_window_height") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("recognize_window_height", 400);
            400
        }
    };
    let monitor = window.current_monitor().unwrap().unwrap();
    let dpi = monitor.scale_factor();
    window
        .set_size(tauri::PhysicalSize::new(
            (width as f64) * dpi,
            (height as f64) * dpi,
        ))
        .unwrap();
    window.center().unwrap();
    // 保持 visible(false)，事件负载 [SILENT] 通知前端本次为静默识别
    window.emit("new_image", "[SILENT]").unwrap();
}

#[cfg(not(target_os = "macos"))]
fn screenshot_window() -> Window {
    let (window, _exists) = build_window("screenshot", "Screenshot");

    window.set_skip_taskbar(true).unwrap();
    #[cfg(target_os = "macos")]
    {
        let monitor = window.current_monitor().unwrap().unwrap();
        let size = monitor.size();
        window.set_decorations(false).unwrap();
        window.set_size(*size).unwrap();
    }

    #[cfg(not(target_os = "macos"))]
    window.set_fullscreen(true).unwrap();

    window.set_always_on_top(true).unwrap();
    window
}

pub fn ocr_recognize() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            recognize_window();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            recognize_window();
            window_.unlisten(event.id())
        });
    }
}

// 静默截图识别：截图后后台识别，少弹窗、少打断
pub fn ocr_silent_recognize() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            recognize_window_silent();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            recognize_window_silent();
            window_.unlisten(event.id())
        });
    }
}
pub fn ocr_translate() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            image_translate();
            ();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            image_translate();
            window_.unlisten(event.id())
        });
    }
}

// 截图译文叠加窗：覆盖在截图区域对应位置，由前端渲染译文块/原图
pub fn overlay_window() {
    // 行级坐标仅 Windows 系统 OCR 提供，其他平台直接回退常规图片翻译窗
    #[cfg(not(target_os = "windows"))]
    {
        image_translate();
        return;
    }

    #[cfg(target_os = "windows")]
    {
        let (window, _exists) = build_window("overlay", "Overlay");
        window.set_skip_taskbar(true).unwrap();
        window.set_always_on_top(true).unwrap();
        window.set_resizable(false).unwrap();

        // 按截图裁剪矩形设置位置与大小（物理像素）
        let app_handle = APP.get().unwrap();
        if let Some(rect) = app_handle
            .state::<crate::cmd::ScreenshotRectWrapper>()
            .0
            .lock()
            .unwrap()
            .clone()
        {
            window
                .set_size(tauri::PhysicalSize::new(rect.width.max(100), rect.height.max(60)))
                .unwrap();
            window
                .set_position(tauri::PhysicalPosition::new(
                    rect.monitor_x + rect.left,
                    rect.monitor_y + rect.top,
                ))
                .unwrap();
        }
        window.show().unwrap();
        window.set_focus().unwrap();
    }
}

// 截图译文叠加：截图后在原图对应位置显示译文
pub fn ocr_overlay_translate() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get CacheDir Failed");
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            overlay_window();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            overlay_window();
            window_.unlisten(event.id())
        });
    }
}

#[tauri::command(async)]
pub fn updater_window() {
    let (window, _exists) = build_window("updater", "Updater");
    window
        .set_min_size(Some(tauri::LogicalSize::new(600, 400)))
        .unwrap();
    window.set_size(tauri::LogicalSize::new(600, 400)).unwrap();
    window.center().unwrap();
}
