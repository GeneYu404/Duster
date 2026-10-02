//! Extracts a program icon (from `DisplayIcon` → `path,index`, falling back to the
//! executable in the install directory) and returns it as a PNG data URL.
//! Results are cached per app id by the command layer; extraction is done lazily on request
//! so the initial list stays fast.

use crate::app_model::InstalledApp;
use crate::leftover_scanner::exe_from_display_icon;
use std::path::{Path, PathBuf};

/// Candidate files to try, in order.
fn candidates(app: &InstalledApp) -> Vec<(PathBuf, i32)> {
    let mut out = Vec::new();
    if let Some(icon) = &app.display_icon {
        let index = icon.rsplit_once(',').and_then(|(_, i)| i.trim().parse::<i32>().ok()).unwrap_or(0);
        if let Some(p) = exe_from_display_icon(icon) {
            out.push((p, index));
        }
    }
    if let Some(dir) = &app.install_location {
        let dir = Path::new(dir);
        if let Ok(rd) = std::fs::read_dir(dir) {
            let mut exes: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("exe")).unwrap_or(false)).collect();
            // Prefer an exe whose name resembles the product name, skip uninstallers.
            let name = app.name.to_lowercase();
            exes.sort_by_key(|p| {
                let f = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
                (f.contains("unins") || f.contains("setup"), !name.contains(&f))
            });
            out.extend(exes.into_iter().take(3).map(|p| (p, 0)));
        }
    }
    out
}

pub fn extract_png_data_url(app: &InstalledApp) -> Option<String> {
    for (path, index) in candidates(app) {
        if let Some(png) = extract_from_file(&path, index) {
            use base64::Engine;
            return Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)));
        }
    }
    None
}

#[cfg(windows)]
fn extract_from_file(path: &Path, index: i32) -> Option<Vec<u8>> {
    use windows::core::HSTRING;
    use windows::Win32::Graphics::Gdi::{DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ};
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    if !path.is_file() {
        return None;
    }
    let path_text = path.to_string_lossy().into_owned();
    let wide = HSTRING::from(path_text.as_str());
    let mut large = [HICON::default(); 1];
    let count = unsafe { ExtractIconExW(&wide, index, Some(large.as_mut_ptr()), None, 1) };
    if count == 0 || large[0].is_invalid() {
        return None;
    }
    let hicon = large[0];

    let result = unsafe {
        let mut info = ICONINFO::default();
        if GetIconInfo(hicon, &mut info).is_err() {
            None
        } else {
            // windows ≥0.59: HBITMAP is a HANDLE newtype, but these two GDI calls want
            // the distinct HGDIOBJ newtype, so unwrap the raw pointer explicitly.
            let hbm_color = HGDIOBJ(info.hbmColor.0);
            let hbm_mask = HGDIOBJ(info.hbmMask.0);
            let mut bmp = BITMAP::default();
            if GetObjectW(hbm_color, std::mem::size_of::<BITMAP>() as i32, Some(&mut bmp as *mut _ as *mut _)) == 0 {
                let _ = DeleteObject(hbm_color);
                let _ = DeleteObject(hbm_mask);
                let _ = DestroyIcon(hicon);
                return None;
            }
            let (w, h) = (bmp.bmWidth, bmp.bmHeight);
            let mut header = BITMAPINFO::default();
            header.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            let hdc = GetDC(None);
            let lines = GetDIBits(hdc, info.hbmColor, 0, h as u32, Some(pixels.as_mut_ptr() as *mut _), &mut header, DIB_RGB_COLORS);
            ReleaseDC(None, hdc);
            let _ = DeleteObject(hbm_color);
            let _ = DeleteObject(hbm_mask);
            if lines == 0 {
                None
            } else {
                // BGRA → RGBA; icons without an alpha channel come back fully transparent, fix that up.
                let has_alpha = pixels.chunks_exact(4).any(|p| p[3] != 0);
                for px in pixels.chunks_exact_mut(4) {
                    px.swap(0, 2);
                    if !has_alpha {
                        px[3] = 255;
                    }
                }
                encode_png(w as u32, h as u32, &pixels)
            }
        }
    };
    unsafe {
        let _ = DestroyIcon(hicon);
    }
    result
}

#[cfg(not(windows))]
fn extract_from_file(_path: &Path, _index: i32) -> Option<Vec<u8>> {
    None
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}
