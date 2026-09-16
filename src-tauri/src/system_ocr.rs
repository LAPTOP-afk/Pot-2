use dirs::cache_dir;

// 带行级坐标的系统 OCR（仅 Windows 支持；返回 JSON：
// {"image_w":..,"image_h":..,"lines":[{"text":..,"x":..,"y":..,"w":..,"h":..}]}
#[tauri::command(async)]
#[cfg(target_os = "windows")]
pub fn system_ocr_lines(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    use serde_json::json;
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let bitmap = BitmapDecoder::CreateWithIdAsync(
        BitmapDecoder::PngDecoderId().map_err(|e| e.to_string())?,
        &file
            .OpenAsync(FileAccessMode::Read)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?
    .get()
    .map_err(|e| e.to_string())?;
    let bitmap = bitmap
        .GetSoftwareBitmapAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let engine = match lang {
        "auto" => OcrEngine::TryCreateFromUserProfileLanguages(),
        _ => {
            if let Ok(language) = Language::CreateLanguage(&HSTRING::from(lang)) {
                OcrEngine::TryCreateFromLanguage(&language)
            } else {
                return Err("Language Error".to_string());
            }
        }
    };
    let engine = match engine {
        Ok(v) => v,
        Err(e) => {
            return if e.to_string().contains("0x00000000") {
                Err("Language package not installed!\n\nSee: https://learn.microsoft.com/zh-cn/windows/powertoys/text-extractor#supported-languages".to_string())
            } else {
                Err(e.to_string())
            };
        }
    };

    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let image_w = bitmap.PixelWidth().map_err(|e| e.to_string())?;
    let image_h = bitmap.PixelHeight().map_err(|e| e.to_string())?;

    let mut lines = Vec::new();
    for line in result.Lines().map_err(|e| e.to_string())? {
        let text = line.Text().map_err(|e| e.to_string())?.to_string_lossy();
        let words = line.Words().map_err(|e| e.to_string())?;
        // OcrLine 不直接提供外接矩形，聚合其所有单词的 BoundingRect
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        for word in words {
            let r = word.BoundingRect().map_err(|e| e.to_string())?;
            min_x = min_x.min(r.X);
            min_y = min_y.min(r.Y);
            max_x = max_x.max(r.X + r.Width);
            max_y = max_y.max(r.Y + r.Height);
        }
        if min_x <= max_x && min_y <= max_y {
            lines.push(json!({
                "text": text,
                "x": min_x,
                "y": min_y,
                "w": max_x - min_x,
                "h": max_y - min_y,
            }));
        } else {
            lines.push(json!({"text": text}));
        }
    }

    serde_json::to_string(&json!({
        "image_w": image_w,
        "image_h": image_h,
        "lines": lines,
    }))
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
#[cfg(not(target_os = "windows"))]
pub fn system_ocr_lines(_app_handle: tauri::AppHandle, _lang: &str) -> Result<String, String> {
    // macOS/Linux 系统 OCR 不提供行级坐标，前端据此回退纯文本流程
    Err("coordinates unsupported".to_string())
}

#[tauri::command(async)]
#[cfg(target_os = "windows")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");

    let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .unwrap()
        .get()
        .unwrap();

    let bitmap = BitmapDecoder::CreateWithIdAsync(
        BitmapDecoder::PngDecoderId().unwrap(),
        &file.OpenAsync(FileAccessMode::Read).unwrap().get().unwrap(),
    )
    .unwrap()
    .get()
    .unwrap();

    let bitmap = bitmap.GetSoftwareBitmapAsync().unwrap().get().unwrap();

    let engine = match lang {
        "auto" => OcrEngine::TryCreateFromUserProfileLanguages(),
        _ => {
            if let Ok(language) = Language::CreateLanguage(&HSTRING::from(lang)) {
                OcrEngine::TryCreateFromLanguage(&language)
            } else {
                return Err("Language Error".to_string());
            }
        }
    };

    match engine {
        Ok(v) => Ok(v
            .RecognizeAsync(&bitmap)
            .unwrap()
            .get()
            .unwrap()
            .Text()
            .unwrap()
            .to_string_lossy()),
        Err(e) => {
            if e.to_string().contains("0x00000000") {
                Err("Language package not installed!\n\nSee: https://learn.microsoft.com/zh-cn/windows/powertoys/text-extractor#supported-languages".to_string())
            } else {
                Err(e.to_string())
            }
        }
    }
}

#[tauri::command(async)]
#[cfg(target_os = "macos")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");

    let arch = std::env::consts::ARCH;
    let bin_path = match app_handle
        .path_resolver()
        .resolve_resource(format!("resources/ocr-{arch}-apple-darwin"))
    {
        Some(v) => v,
        None => return Err("Failed to resolve ocr binary".to_string()),
    };

    match std::process::Command::new("chmod")
        .arg("+x")
        .arg(bin_path.to_str().unwrap())
        .output()
    {
        Ok(_) => {}
        Err(e) => return Err(e.to_string()),
    }

    let output = match std::process::Command::new(bin_path)
        .arg(app_cache_dir_path.to_str().unwrap())
        .arg(lang)
        .output()
    {
        Ok(v) => v,
        Err(e) => return Err(e.to_string()),
    };

    if output.status.success() {
        let content = String::from_utf8(output.stdout).unwrap_or_default();
        Ok(content)
    } else {
        let content = String::from_utf8(output.stderr).unwrap_or_default();
        Err(content)
    }
}

#[tauri::command(async)]
#[cfg(target_os = "linux")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    let mut args = ["", ""];
    if lang != "auto" {
        args = ["-l", lang];
    }

    let output = match std::process::Command::new("tesseract")
        .arg(app_cache_dir_path.to_str().unwrap())
        .arg("stdout")
        .args(args)
        .output()
    {
        Ok(v) => v,
        Err(e) => {
            if e.to_string().contains("os error 2") {
                return Err("Tesseract not installed!".to_string());
            }
            return Err(e.to_string());
        }
    };
    if output.status.success() {
        let content = String::from_utf8(output.stdout).unwrap_or_default();
        Ok(content)
    } else {
        let content = String::from_utf8(output.stderr).unwrap_or_default();

        if content.contains("data") {
            if lang == "auto" {
                return Err(
                    "Language data not installed!\nPlease try install tesseract-ocr-eng"
                        .to_string(),
                );
            } else {
                return Err(format!(
                    "Language data not installed!\nPlease try install tesseract-ocr-{lang}"
                ));
            }
        }
        Err(content)
    }
}
