//! Minimal OpenSlide bindings (loaded at runtime so the same build works on
//! macOS and Windows) plus a Deep-Zoom style tile renderer.

use std::collections::HashMap;
use std::ffi::{c_char, CStr, CString};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, RgbImage};
use libloading::Library;
use serde::Serialize;

pub const TILE_SIZE: u32 = 256;

type OsrPtr = *mut std::ffi::c_void;

struct Api {
    _lib: Library,
    open: unsafe extern "C" fn(*const c_char) -> OsrPtr,
    close: unsafe extern "C" fn(OsrPtr),
    get_error: unsafe extern "C" fn(OsrPtr) -> *const c_char,
    get_level_count: unsafe extern "C" fn(OsrPtr) -> i32,
    get_level_dimensions: unsafe extern "C" fn(OsrPtr, i32, *mut i64, *mut i64),
    get_level_downsample: unsafe extern "C" fn(OsrPtr, i32) -> f64,
    get_best_level_for_downsample: unsafe extern "C" fn(OsrPtr, f64) -> i32,
    read_region: unsafe extern "C" fn(OsrPtr, *mut u32, i64, i64, i32, i64, i64),
    get_property_value: unsafe extern "C" fn(OsrPtr, *const c_char) -> *const c_char,
}

unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn candidate_lib_paths() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["libopenslide-1.dll", "openslide.dll"]
    } else if cfg!(target_os = "macos") {
        &["libopenslide.1.dylib", "libopenslide.dylib"]
    } else {
        &["libopenslide.so.1", "libopenslide.so"]
    };
    // 1. next to the executable / in the app bundle's Frameworks + Resources
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for n in names {
                v.push(dir.join(n));
                v.push(dir.join("../Frameworks").join(n));
                v.push(dir.join("../Resources/lib").join(n));
                v.push(dir.join("lib").join(n));
            }
        }
    }
    // 2. explicit override
    if let Ok(p) = std::env::var("OPENSLIDE_LIB") {
        v.insert(0, PathBuf::from(p));
    }
    // 3. common install locations
    if cfg!(target_os = "macos") {
        for n in names {
            v.push(Path::new("/opt/homebrew/lib").join(n));
            v.push(Path::new("/usr/local/lib").join(n));
        }
    }
    // 4. let the OS loader search
    for n in names {
        v.push(PathBuf::from(n));
    }
    v
}

unsafe fn load_api(lib: Library) -> Result<Api, String> {
    macro_rules! sym {
        ($n:literal) => {
            unsafe { *lib.get(concat!($n, "\0").as_bytes()).map_err(|e| format!("{}: {e}", $n))? }
        };
    }
    let open = sym!("openslide_open");
    let close = sym!("openslide_close");
    let get_error = sym!("openslide_get_error");
    let get_level_count = sym!("openslide_get_level_count");
    let get_level_dimensions = sym!("openslide_get_level_dimensions");
    let get_level_downsample = sym!("openslide_get_level_downsample");
    let get_best_level_for_downsample = sym!("openslide_get_best_level_for_downsample");
    let read_region = sym!("openslide_read_region");
    let get_property_value = sym!("openslide_get_property_value");
    Ok(Api {
        _lib: lib,
        open,
        close,
        get_error,
        get_level_count,
        get_level_dimensions,
        get_level_downsample,
        get_best_level_for_downsample,
        read_region,
        get_property_value,
    })
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| {
        let mut last_err = String::from("no candidates");
        for p in candidate_lib_paths() {
            let lib = match unsafe { Library::new(&p) } {
                Ok(l) => l,
                Err(e) => {
                    last_err = format!("{}: {e}", p.display());
                    continue;
                }
            };
            match unsafe { load_api(lib) } {
                Ok(a) => return Ok(a),
                Err(e) => last_err = e,
            }
        }
        Err(format!(
            "Could not load the OpenSlide library ({last_err}). Install it (macOS: `brew install openslide`) or place it next to the app."
        ))
    })
    .as_ref()
    .map_err(|e| e.clone())
}

pub struct Slide {
    osr: OsrPtr,
    pub info: SlideInfo,
    levels: Vec<(i64, i64, f64)>,
}

unsafe impl Send for Slide {}
unsafe impl Sync for Slide {}

impl Drop for Slide {
    fn drop(&mut self) {
        if let Ok(a) = api() {
            unsafe { (a.close)(self.osr) }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlideInfo {
    pub id: u32,
    pub path: String,
    pub width: i64,
    pub height: i64,
    pub mpp_x: f64,
    pub mpp_y: f64,
    /// Hamamatsu offsets of the image centre from the slide centre (nm).
    pub x_offset_nm: f64,
    pub y_offset_nm: f64,
    pub tile_size: u32,
    pub max_level: u32,
}

impl Slide {
    fn open(id: u32, path: &str) -> Result<Slide, String> {
        let a = api()?;
        let c = CString::new(path).map_err(|e| e.to_string())?;
        let osr = unsafe { (a.open)(c.as_ptr()) };
        if osr.is_null() {
            return Err(format!("Not a supported slide file: {path}"));
        }
        let err = unsafe { (a.get_error)(osr) };
        if !err.is_null() {
            let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned();
            unsafe { (a.close)(osr) };
            return Err(msg);
        }
        let prop = |k: &str| -> Option<String> {
            let ck = CString::new(k).ok()?;
            let v = unsafe { (a.get_property_value)(osr, ck.as_ptr()) };
            if v.is_null() {
                None
            } else {
                Some(unsafe { CStr::from_ptr(v) }.to_string_lossy().into_owned())
            }
        };
        let n = unsafe { (a.get_level_count)(osr) };
        let mut levels = Vec::new();
        for i in 0..n {
            let (mut w, mut h) = (0i64, 0i64);
            unsafe { (a.get_level_dimensions)(osr, i, &mut w, &mut h) };
            let ds = unsafe { (a.get_level_downsample)(osr, i) };
            levels.push((w, h, ds));
        }
        let (width, height) = (levels[0].0, levels[0].1);
        let num = |k: &str, d: f64| prop(k).and_then(|s| s.parse::<f64>().ok()).unwrap_or(d);
        let max_dim = width.max(height).max(1) as f64;
        let info = SlideInfo {
            id,
            path: path.to_string(),
            width,
            height,
            mpp_x: num("openslide.mpp-x", 0.25),
            mpp_y: num("openslide.mpp-y", 0.25),
            x_offset_nm: num("hamamatsu.XOffsetFromSlideCentre", 0.0),
            y_offset_nm: num("hamamatsu.YOffsetFromSlideCentre", 0.0),
            tile_size: TILE_SIZE,
            max_level: max_dim.log2().ceil() as u32,
        };
        Ok(Slide { osr, info, levels })
    }

    /// Render a Deep-Zoom tile. `level` follows OpenSeadragon conventions:
    /// `max_level` is full resolution, each lower level halves the size.
    pub fn render_tile(&self, level: u32, tx: u32, ty: u32, quality: u8) -> Result<Vec<u8>, String> {
        let a = api()?;
        if level > self.info.max_level {
            return Err("bad level".into());
        }
        let ds = 2f64.powi((self.info.max_level - level) as i32);
        let lw = (self.info.width as f64 / ds).ceil() as u32;
        let lh = (self.info.height as f64 / ds).ceil() as u32;
        let x0 = tx * TILE_SIZE;
        let y0 = ty * TILE_SIZE;
        if x0 >= lw || y0 >= lh {
            return Err("tile out of range".into());
        }
        let tw = TILE_SIZE.min(lw - x0);
        let th = TILE_SIZE.min(lh - y0);

        let best = unsafe { (a.get_best_level_for_downsample)(self.osr, ds) }.max(0) as usize;
        let (_, _, lds) = self.levels[best];
        // region in level-0 coordinates
        let l0x = (x0 as f64 * ds) as i64;
        let l0y = (y0 as f64 * ds) as i64;
        let rw = ((tw as f64 * ds) / lds).ceil().max(1.0) as i64;
        let rh = ((th as f64 * ds) / lds).ceil().max(1.0) as i64;
        let mut buf = vec![0u32; (rw * rh) as usize];
        unsafe { (a.read_region)(self.osr, buf.as_mut_ptr(), l0x, l0y, best as i32, rw, rh) };
        let err = unsafe { (a.get_error)(self.osr) };
        if !err.is_null() {
            return Err(unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned());
        }
        // premultiplied ARGB -> RGB over white
        let mut rgb = RgbImage::new(rw as u32, rh as u32);
        for (i, px) in buf.iter().enumerate() {
            let al = (px >> 24) & 0xff;
            let (r, g, b) = ((px >> 16) & 0xff, (px >> 8) & 0xff, px & 0xff);
            let inv = 255 - al;
            let p = [(r + inv) as u8, (g + inv) as u8, (b + inv) as u8];
            rgb.put_pixel(i as u32 % rw as u32, i as u32 / rw as u32, image::Rgb(p));
        }
        let out = if rw as u32 != tw || rh as u32 != th {
            image::imageops::resize(&rgb, tw, th, FilterType::Triangle)
        } else {
            rgb
        };
        let mut bytes = Vec::with_capacity(32 * 1024);
        JpegEncoder::new_with_quality(Cursor::new(&mut bytes), quality)
            .encode_image(&out)
            .map_err(|e| e.to_string())?;
        Ok(bytes)
    }
}

#[derive(Default)]
pub struct SlideRegistry {
    by_path: Mutex<HashMap<String, u32>>,
    by_id: Mutex<HashMap<u32, Arc<Slide>>>,
    next: Mutex<u32>,
}

impl SlideRegistry {
    pub fn open(&self, path: &str) -> Result<SlideInfo, String> {
        if let Some(id) = self.by_path.lock().unwrap().get(path).copied() {
            if let Some(s) = self.by_id.lock().unwrap().get(&id) {
                return Ok(s.info.clone());
            }
        }
        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            *n
        };
        let s = Slide::open(id, path)?;
        let info = s.info.clone();
        self.by_id.lock().unwrap().insert(id, Arc::new(s));
        self.by_path.lock().unwrap().insert(path.to_string(), id);
        Ok(info)
    }

    pub fn get(&self, id: u32) -> Option<Arc<Slide>> {
        self.by_id.lock().unwrap().get(&id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renders_real_slide_tile() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../images/VMS146.ndpi");
        if !Path::new(p).exists() { return; }
        let reg = SlideRegistry::default();
        let info = reg.open(p).expect("open");
        let s = reg.get(info.id).unwrap();
        let t0 = std::time::Instant::now();
        // full-res tile around the Exam1 Q9 key pin (~7453, 7711)
        let jpg = s.render_tile(info.max_level, 7453 / 256, 7711 / 256, 85).unwrap();
        std::fs::write(std::env::temp_dir().join("msg_tile_full.jpg"), &jpg).unwrap();
        let thumb = s.render_tile(8, 0, 0, 85).unwrap();
        std::fs::write(std::env::temp_dir().join("msg_tile_thumb.jpg"), &thumb).unwrap();
        eprintln!("max_level={} took {:?}", info.max_level, t0.elapsed());
    }
}
