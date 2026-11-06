//! Headless dev server for UI tests: serves the same OpenSlide tiles the app's
//! `slide://` protocol does, over plain HTTP, so the front end can run in a
//! normal browser (see app/tests/ui).
//!
//!   cargo run --example tileserver -- 8787
//!   GET /open?path=<abs path>             -> SlideInfo JSON
//!   GET /tile/<id>/<level>/<x>_<y>.jpg    -> JPEG tile
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use app_lib::slide::SlideRegistry;

fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                out.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("00"), 16).unwrap_or(b'?'));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn reply(mut s: TcpStream, status: &str, ctype: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
}

fn handle(reg: &SlideRegistry, s: TcpStream) {
    let mut line = String::new();
    let mut r = BufReader::new(s.try_clone().unwrap());
    if r.read_line(&mut line).is_err() {
        return;
    }
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
            break;
        }
    }
    let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
    if let Some(q) = target.strip_prefix("/open?path=") {
        match reg.open(&unescape(q)) {
            Ok(info) => reply(s, "200 OK", "application/json", serde_json::to_string(&info).unwrap().as_bytes()),
            Err(e) => reply(s, "500 Error", "text/plain", e.as_bytes()),
        }
    } else if let Some(p) = target.strip_prefix("/tile/") {
        let parts: Vec<&str> = p.split('/').collect();
        let parsed = (|| {
            let (x, y) = parts.get(2)?.trim_end_matches(".jpg").split_once('_')?;
            Some((parts[0].parse().ok()?, parts[1].parse().ok()?, x.parse().ok()?, y.parse().ok()?))
        })();
        match parsed.and_then(|(id, l, x, y)| reg.get(id).map(|sl| sl.render_tile(l, x, y, 85))) {
            Some(Ok(jpg)) => reply(s, "200 OK", "image/jpeg", &jpg),
            Some(Err(e)) => reply(s, "404 Not Found", "text/plain", e.as_bytes()),
            None => reply(s, "404 Not Found", "text/plain", b"bad tile"),
        }
    } else {
        reply(s, "404 Not Found", "text/plain", b"not found");
    }
}

fn main() {
    let port = std::env::args().nth(1).unwrap_or_else(|| "8787".into());
    let reg = Arc::new(SlideRegistry::default());
    let l = TcpListener::bind(format!("127.0.0.1:{port}")).expect("bind");
    println!("tileserver on http://127.0.0.1:{port}");
    for s in l.incoming().flatten() {
        let reg = reg.clone();
        std::thread::spawn(move || handle(&reg, s));
    }
}
