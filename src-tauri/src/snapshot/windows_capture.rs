//! Foreground-window lookup and a GDI screen-region capture, mirroring upstream
//! `ActiveWindow.ts` and `RegionSnapShotWorker.ts` on Windows.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use super::platform::Bounds;
use super::window_identity::executable_name;

const WINDOW_TITLE_CHARS: usize = 1_024;

pub struct ActiveWindow {
    pub title: String,
    pub app_name: String,
    pub process_id: u32,
    pub bounds: Bounds,
}

pub struct CapturedBitmap {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub fn active_window() -> Option<ActiveWindow> {
    unsafe {
        let handle = GetForegroundWindow();
        if handle.is_null() {
            return None;
        }
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(handle, &mut rect) == 0 {
            return None;
        }
        let mut process_id = 0u32;
        GetWindowThreadProcessId(handle, &mut process_id);
        let path = process_image_path(process_id);
        Some(ActiveWindow {
            title: window_text(handle),
            app_name: executable_name(&path),
            process_id,
            bounds: Bounds {
                x: rect.left as i64,
                y: rect.top as i64,
                width: (rect.right - rect.left).max(0) as i64,
                height: (rect.bottom - rect.top).max(0) as i64,
            },
        })
    }
}

pub fn capture_bounds(bounds: Bounds) -> Result<CapturedBitmap, String> {
    let virtual_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) } as i64;
    let virtual_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) } as i64;
    let virtual_width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) } as i64;
    let virtual_height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) } as i64;
    let left = bounds.x.max(virtual_x);
    let top = bounds.y.max(virtual_y);
    let right = (bounds.x + bounds.width).min(virtual_x + virtual_width);
    let bottom = (bounds.y + bounds.height).min(virtual_y + virtual_height);
    let width = right - left;
    let height = bottom - top;
    if width <= 0 || height <= 0 {
        return Err(format!(
            "the active window at ({}, {}) {}x{} is outside the screen area",
            bounds.x, bounds.y, bounds.width, bounds.height
        ));
    }
    let width = width as i32;
    let height = height as i32;
    let source_x = (left - virtual_x) as i32;
    let source_y = (top - virtual_y) as i32;

    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("could not read the screen for the snapshot".to_string());
        }
        let memory = CreateCompatibleDC(screen);
        if memory.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("could not create a snapshot drawing surface".to_string());
        }
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if bitmap.is_null() {
            DeleteDC(memory);
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("could not allocate the snapshot bitmap".to_string());
        }
        let previous = SelectObject(memory, bitmap);
        let copied = BitBlt(
            memory, 0, 0, width, height, screen, source_x, source_y, SRCCOPY,
        );

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let lines = if copied == 0 {
            0
        } else {
            GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                pixels.as_mut_ptr().cast::<c_void>(),
                &mut info,
                DIB_RGB_COLORS,
            )
        };

        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);

        if copied == 0 || lines == 0 {
            return Err("could not capture the active window".to_string());
        }
        Ok(CapturedBitmap {
            pixels,
            width: width as u32,
            height: height as u32,
        })
    }
}

fn window_text(handle: HWND) -> String {
    let mut buffer = vec![0u16; WINDOW_TITLE_CHARS];
    let length = unsafe { GetWindowTextW(handle, buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
}

fn process_image_path(process_id: u32) -> String {
    crate::sys::pid::process_image_path(process_id).unwrap_or_default()
}
