//! Writes small synthetic stand-ins for the demo class's slides (VMS109, VMS133), so the UI tests
//! can run without the real course slides (tens of GB, and not ours to publish):
//!
//!   cargo run --release --example make_test_slides -- <out dir> [scale]
//!
//! Each file is a Hamamatsu NDPI with the real slide's physical size, its offsets from the glass
//! slide's centre, and its pyramid structure, so the demo's pins (in nm from the slide centre)
//! land where they do on the real slides. The image is made up: pink "tissue" with purple
//! "nuclei", drawn from a fixed seed. `scale` (default 8) divides the resolution: 8 gives
//! 0.231 µm × 8 ≈ 1.85 µm per pixel and files of a few MB.
//!
//! Only these numbers come from the real slides; no image data does.
use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
use std::fs;
use std::path::Path;

struct SlideSpec {
    id: &'static str,
    /// level 0 of the real slide, in pixels
    width: u32,
    height: u32,
    /// pixels per cm at level 0 (x, y)
    res_cm: (f64, f64),
    /// image centre relative to the glass slide's centre, in nm (tags 65422 / 65423)
    offset_nm: (i32, i32),
    /// the real slide's reference (tag 65427)
    reference: &'static str,
}

const SLIDES: &[SlideSpec] = &[
    SlideSpec {
        id: "VMS109",
        width: 51584,
        height: 25344,
        res_cm: (43288.0, 43290.0),
        offset_nm: (7874160, -799942),
        reference: "109 F20",
    },
    SlideSpec {
        id: "VMS133",
        width: 63488,
        height: 76544,
        res_cm: (43288.0, 43290.0),
        offset_nm: (12974831, -1024631),
        reference: "133 B25",
    },
];

/// objective magnification of level 0 (tag 65421); each level down is 4× smaller
const LENS: f32 = 40.0;
/// levels wider than this are split into restart intervals (OpenSlide's tiles); narrower ones are one tile
const TILE_FROM: u32 = 2048;

fn hash(x: i64, y: i64, seed: u64) -> u64 {
    let mut h = seed
        ^ (x as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ (y as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 33;
    h
}
fn unit(h: u64) -> f64 {
    (h >> 11) as f64 / (1u64 << 53) as f64
}
/// smooth value noise in [0, 1) on a grid of `cell` µm
fn noise(x: f64, y: f64, cell: f64, seed: u64) -> f64 {
    let (gx, gy) = (x / cell, y / cell);
    let (ix, iy) = (gx.floor() as i64, gy.floor() as i64);
    let (fx, fy) = (gx - ix as f64, gy - iy as f64);
    let s = |t: f64| t * t * (3.0 - 2.0 * t);
    let v = |dx: i64, dy: i64| unit(hash(ix + dx, iy + dy, seed));
    let top = v(0, 0) + (v(1, 0) - v(0, 0)) * s(fx);
    let bot = v(0, 1) + (v(1, 1) - v(0, 1)) * s(fx);
    top + (bot - top) * s(fy)
}

/// colour at a point on the slide, in µm from the image's top-left corner
fn colour(x: f64, y: f64, seed: u64) -> [u8; 3] {
    let tissue = 0.65 * noise(x, y, 900.0, seed) + 0.35 * noise(x, y, 220.0, seed + 1);
    if tissue < 0.42 {
        return [244, 242, 245]; // glass
    }
    // a nucleus in some 18 µm cells
    let cell = 18.0;
    let (cx, cy) = ((x / cell).floor() as i64, (y / cell).floor() as i64);
    let h = hash(cx, cy, seed + 2);
    if unit(h) < 0.35 {
        let nx = (cx as f64 + 0.2 + 0.6 * unit(hash(cx, cy, seed + 3))) * cell;
        let ny = (cy as f64 + 0.2 + 0.6 * unit(hash(cx, cy, seed + 4))) * cell;
        if (x - nx).powi(2) + (y - ny).powi(2) < 16.0 {
            return [92, 52, 140];
        }
    }
    let shade = noise(x, y, 60.0, seed + 5);
    let t = ((tissue - 0.42) * 2.5).min(1.0);
    let r = 238.0 - 20.0 * t - 10.0 * shade;
    let g = 188.0 - 50.0 * t - 15.0 * shade;
    let b = 214.0 - 25.0 * t - 10.0 * shade;
    [r as u8, g as u8, b as u8]
}

struct Level {
    width: u32,
    height: u32,
    res_cm: (f64, f64),
    lens: f32,
    jpeg: Vec<u8>,
    /// offset of each restart interval's data within the JPEG (tag 65426)
    mcu_starts: Vec<u32>,
}

fn render(w: u32, h: u32, um_per_px: f64, seed: u64) -> Vec<u8> {
    let mut px = vec![0u8; (w * h * 3) as usize];
    for y in 0..h {
        for x in 0..w {
            let c = colour(
                (x as f64 + 0.5) * um_per_px,
                (y as f64 + 0.5) * um_per_px,
                seed,
            );
            let i = ((y * w + x) * 3) as usize;
            px[i..i + 3].copy_from_slice(&c);
        }
    }
    px
}

/// JPEG-encode, with restart markers on wide levels so OpenSlide can read them in tiles, and find
/// where each restart interval starts
fn encode(px: &[u8], w: u32, h: u32) -> (Vec<u8>, Vec<u32>) {
    let mut out = Vec::new();
    let mut enc = Encoder::new(&mut out, 85);
    enc.set_sampling_factor(SamplingFactor::F_1_1);
    // an interval must be whole 8 px blocks that divide the row; tiles 128–512 px wide
    let mcus = w / 8;
    if w > TILE_FROM
        && let Some(n) = (16..=64).rev().find(|n| mcus.is_multiple_of(*n))
    {
        enc.set_restart_interval(n as u16);
    }
    enc.encode(px, w as u16, h as u16, ColorType::Rgb)
        .expect("jpeg");
    // the scan data starts after the SOS segment; each RSTn marker starts the next interval
    let mut starts = Vec::new();
    let mut i = 2;
    while i + 4 <= out.len() {
        if out[i] == 0xFF && out[i + 1] == 0xDA {
            let len = u16::from_be_bytes([out[i + 2], out[i + 3]]) as usize;
            i += 2 + len;
            starts.push(i as u32);
            break;
        }
        let len = u16::from_be_bytes([out[i + 2], out[i + 3]]) as usize;
        i += 2 + len;
    }
    while i + 1 < out.len() {
        if out[i] == 0xFF && (0xD0..=0xD7).contains(&out[i + 1]) {
            starts.push((i + 2) as u32);
            i += 2;
        } else {
            i += 1;
        }
    }
    (out, starts)
}

// ---- a little-endian classic TIFF writer, just enough for NDPI ----
enum Val {
    Short(Vec<u16>),
    Long(Vec<u32>),
    SLong(i32),
    Rational(u32, u32),
    Float(f32),
    Ascii(String),
}

fn write_ndpi(path: &Path, spec: &SlideSpec, levels: &[Level]) {
    let mut f: Vec<u8> = b"II*\0\0\0\0\0".to_vec();
    let mut data_at = Vec::new();
    for l in levels {
        data_at.push(f.len() as u32);
        f.extend_from_slice(&l.jpeg);
        if f.len() % 2 == 1 {
            f.push(0);
        }
    }
    let mut prev_next_ptr: usize = 4;
    for (l, &at) in levels.iter().zip(&data_at) {
        let mut tags: Vec<(u16, Val)> = vec![
            (256, Val::Long(vec![l.width])),
            (257, Val::Long(vec![l.height])),
            (258, Val::Short(vec![8, 8, 8])),
            (259, Val::Short(vec![7])), // JPEG
            (262, Val::Short(vec![6])), // YCbCr
            (271, Val::Ascii("Hamamatsu".into())),
            (272, Val::Ascii("Synthetic test slide".into())),
            (273, Val::Long(vec![at])),
            (277, Val::Short(vec![3])),
            (278, Val::Long(vec![l.height])),
            (279, Val::Long(vec![l.jpeg.len() as u32])),
            (
                282,
                Val::Rational((l.res_cm.0 * 1000.0).round() as u32, 1000),
            ),
            (
                283,
                Val::Rational((l.res_cm.1 * 1000.0).round() as u32, 1000),
            ),
            (284, Val::Short(vec![1])),
            (296, Val::Short(vec![3])), // centimetres
            (530, Val::Short(vec![1, 1])),
            (65420, Val::Long(vec![1])),
            (65421, Val::Float(l.lens)),
            (65422, Val::SLong(spec.offset_nm.0)),
            (65423, Val::SLong(spec.offset_nm.1)),
            (65424, Val::SLong(0)),
            (65427, Val::Ascii(spec.reference.into())),
        ];
        if l.mcu_starts.len() > 1 {
            tags.push((65426, Val::Long(l.mcu_starts.clone())));
        }
        tags.sort_by_key(|t| t.0);
        if f.len() % 2 == 1 {
            f.push(0);
        }
        let ifd = f.len();
        f[prev_next_ptr..prev_next_ptr + 4].copy_from_slice(&(ifd as u32).to_le_bytes());
        // entries, then the next-IFD pointer, then values that don't fit in 4 bytes
        let n = tags.len();
        let mut extra_at = ifd + 2 + n * 12 + 4;
        let mut entries = Vec::new();
        let mut extra = Vec::new();
        entries.extend_from_slice(&(n as u16).to_le_bytes());
        for (tag, v) in &tags {
            let (ty, count, bytes): (u16, u32, Vec<u8>) = match v {
                Val::Short(xs) => (
                    3,
                    xs.len() as u32,
                    xs.iter().flat_map(|x| x.to_le_bytes()).collect(),
                ),
                Val::Long(xs) => (
                    4,
                    xs.len() as u32,
                    xs.iter().flat_map(|x| x.to_le_bytes()).collect(),
                ),
                Val::SLong(x) => (9, 1, x.to_le_bytes().to_vec()),
                Val::Rational(a, b) => (5, 1, [a.to_le_bytes(), b.to_le_bytes()].concat()),
                Val::Float(x) => (11, 1, x.to_le_bytes().to_vec()),
                Val::Ascii(s) => {
                    let mut b = s.as_bytes().to_vec();
                    b.push(0);
                    (2, b.len() as u32, b)
                }
            };
            entries.extend_from_slice(&tag.to_le_bytes());
            entries.extend_from_slice(&ty.to_le_bytes());
            entries.extend_from_slice(&count.to_le_bytes());
            if bytes.len() <= 4 {
                let mut b = bytes.clone();
                b.resize(4, 0);
                entries.extend_from_slice(&b);
            } else {
                entries.extend_from_slice(&(extra_at as u32).to_le_bytes());
                extra.extend_from_slice(&bytes);
                if bytes.len() % 2 == 1 {
                    extra.push(0);
                }
                extra_at = ifd + 2 + n * 12 + 4 + extra.len();
            }
        }
        f.extend_from_slice(&entries);
        prev_next_ptr = f.len();
        f.extend_from_slice(&0u32.to_le_bytes());
        f.extend_from_slice(&extra);
    }
    fs::write(path, f).expect("write slide");
}

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args
        .next()
        .expect("usage: make_test_slides <out dir> [scale]");
    let scale: u32 = args.next().map(|s| s.parse().expect("scale")).unwrap_or(8);
    fs::create_dir_all(&out).expect("out dir");
    for (n, spec) in SLIDES.iter().enumerate() {
        let seed = 0x5EED_0000 + n as u64;
        // level 0 at 1/scale (whole 8 px blocks); same µm per pixel across and down, as on the real slide
        let w0 = (spec.width / scale / 8).max(1) * 8;
        let h0 = (spec.height / scale / 8).max(1) * 8;
        let res0 = (spec.res_cm.0 / scale as f64, spec.res_cm.1 / scale as f64);
        let um0 = 1e4 / res0.0;
        let mut levels = Vec::new();
        let (mut w, mut h, mut k) = (w0, h0, 1u32);
        loop {
            let px = render(w, h, um0 * k as f64, seed);
            let (jpeg, mcu_starts) = encode(&px, w, h);
            levels.push(Level {
                width: w,
                height: h,
                res_cm: (res0.0 / k as f64, res0.1 / k as f64),
                lens: LENS / scale as f32 / k as f32,
                jpeg,
                mcu_starts,
            });
            if w <= 1024 && h <= 1024 {
                break;
            }
            k *= 4;
            w = (w0 / k / 8).max(1) * 8;
            h = (h0 / k / 8).max(1) * 8;
        }
        let path = Path::new(&out).join(format!("{}.ndpi", spec.id));
        write_ndpi(&path, spec, &levels);
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        println!(
            "{}: {} levels, level 0 {}×{} at {:.2} µm/px, {:.1} MB",
            path.display(),
            levels.len(),
            w0,
            h0,
            um0,
            size as f64 / 1e6
        );
    }
}
