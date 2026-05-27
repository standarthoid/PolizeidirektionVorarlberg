// BoardDesk — Tauri 2 Backend
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use rusqlite::Connection;

// ── Systemschriften ──────────────────────────────────────────────────────────

#[tauri::command]
fn list_system_fonts() -> Vec<String> {
    let mut fonts = platform_fonts();
    fonts.sort_unstable();
    fonts.dedup();
    fonts.retain(|f| !f.trim().is_empty() && f.len() > 1);
    fonts
}

#[cfg(target_os = "windows")]
fn platform_fonts() -> Vec<String> {
    use std::process::Command;
    let result = Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
            "Add-Type -AssemblyName System.Drawing; \
             (New-Object System.Drawing.Text.InstalledFontCollection).Families | \
             Select-Object -ExpandProperty Name",
        ])
        .output();
    match result {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        }
        _ => scan_font_dirs(&[r"C:\Windows\Fonts"]),
    }
}

#[cfg(target_os = "macos")]
fn platform_fonts() -> Vec<String> {
    if let Some(fonts) = try_fc_list() { return fonts; }
    let home = std::env::var("HOME").unwrap_or_default();
    scan_font_dirs(&[
        "/System/Library/Fonts",
        "/System/Library/Fonts/Supplemental",
        "/Library/Fonts",
        &format!("{}/Library/Fonts", home),
    ])
}

#[cfg(target_os = "linux")]
fn platform_fonts() -> Vec<String> {
    if let Some(fonts) = try_fc_list() { return fonts; }
    let home = std::env::var("HOME").unwrap_or_default();
    scan_font_dirs(&[
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        &format!("{}/.fonts", home),
        &format!("{}/.local/share/fonts", home),
    ])
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn try_fc_list() -> Option<Vec<String>> {
    use std::process::Command;
    let out = Command::new("fc-list").args([":", "family"]).output().ok()?;
    if !out.status.success() { return None; }
    let fonts: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .flat_map(|line| {
            line.split(':')
                .next()
                .unwrap_or("")
                .split(',')
                .map(|f| f.trim().to_string())
                .filter(|f| !f.is_empty())
                .collect::<Vec<_>>()
        })
        .collect();
    if fonts.is_empty() { None } else { Some(fonts) }
}

fn scan_font_dirs(dirs: &[&str]) -> Vec<String> {
    let mut names = Vec::new();
    for dir in dirs {
        scan_dir_recursive(std::path::Path::new(dir), &mut names);
    }
    names
}

fn scan_dir_recursive(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() { scan_dir_recursive(&path, out); continue; }
        let ext = path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(ext.as_str(), "ttf" | "otf" | "ttc" | "woff" | "woff2") { continue; }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            let normalized = stem.replace(['-', '_'], " ");
            let cleaned = normalized
                .split_whitespace()
                .filter(|w| !matches!(
                    *w,
                    "Bold" | "Italic" | "Regular" | "Light" | "Medium"
                    | "Thin" | "Black" | "Heavy" | "Condensed" | "Extended"
                    | "Narrow" | "Wide" | "Semi" | "Extra" | "Ultra"
                    | "BoldItalic" | "LightItalic"
                ))
                .collect::<Vec<_>>()
                .join(" ");
            if !cleaned.is_empty() { out.push(cleaned); }
        }
    }
}

// ── Hilfsfunktionen ─────────────────────────────────────────────────────────

fn read_bytes(path: &PathBuf) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("Lesefehler: {e}"))
}

fn write_bytes(path: &PathBuf, data: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Ordner erstellen: {e}"))?;
    }
    std::fs::write(path, data).map_err(|e| format!("Schreibfehler: {e}"))
}

// ── Tauri Commands ───────────────────────────────────────────────────────────

#[tauri::command]
async fn open_board(app: AppHandle) -> Result<(String, Vec<u8>), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("BoardDesk öffnen")
        .add_filter("BoardDesk-Dateien", &["board"])
        .add_filter("Alle Dateien", &["*"])
        .pick_file(move |path| { tx.send(path).ok(); });
    let path = rx.recv().map_err(|_| "Dialog abgebrochen".to_string())?;
    let path = path.ok_or("Kein Pfad gewählt".to_string())?;
    let path_buf: PathBuf = match path {
        FilePath::Path(p) => p,
        FilePath::Url(u)  => PathBuf::from(u.path()),
    };
    let bytes = read_bytes(&path_buf)?;
    Ok((path_buf.to_string_lossy().into_owned(), bytes))
}

#[tauri::command]
async fn save_board(app: AppHandle, path: Option<String>, data: Vec<u8>) -> Result<String, String> {
    let target: PathBuf = if let Some(p) = path {
        PathBuf::from(p)
    } else {
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog()
            .file()
            .set_title("BoardDesk speichern")
            .add_filter("BoardDesk-Dateien", &["board"])
            .set_file_name("Mein Board.board")
            .save_file(move |path| { tx.send(path).ok(); });
        let path = rx.recv().map_err(|_| "Dialog abgebrochen".to_string())?;
        let path = path.ok_or("Kein Pfad gewählt".to_string())?;
        match path {
            FilePath::Path(p) => p,
            FilePath::Url(u)  => PathBuf::from(u.path()),
        }
    };
    let target = if target.extension().and_then(|e| e.to_str()) != Some("board") {
        target.with_extension("board")
    } else { target };
    write_bytes(&target, &data)?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
async fn autosave_board(path: String, data: Vec<u8>) -> Result<(), String> {
    if path.is_empty() { return Err("Kein Pfad für Autosave".into()); }
    write_bytes(&PathBuf::from(path), &data)
}

#[tauri::command]
fn app_tmp_dir(app: AppHandle) -> Result<String, String> {
    app.path().temp_dir().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

// ── MBTiles-Unterstützung ────────────────────────────────────────────────────
// MBTiles ist eine SQLite-Datenbank mit Karten-Kacheln. Wir halten eine offene
// Connection in einem Mutex, damit wir nicht für jeden Tile-Request neu öffnen
// müssen — das wäre sehr langsam bei tausenden Tiles pro Sekunde.

#[derive(Default)]
struct MbtilesState {
    conn: Mutex<Option<Connection>>,
    path: Mutex<Option<String>>,
}

#[derive(serde::Serialize)]
struct MbtilesMetadata {
    name:      Option<String>,
    format:    Option<String>,
    minzoom:   Option<i32>,
    maxzoom:   Option<i32>,
    bounds:    Option<String>,   // "west,south,east,north" in WGS84
    center:    Option<String>,   // "lon,lat,zoom"
    description: Option<String>,
    attribution: Option<String>,
}

#[tauri::command]
fn mbtiles_open(app: AppHandle, state: State<'_, MbtilesState>) -> Result<String, String> {
    // Datei-Dialog für .mbtiles — blockierend mit Channel
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("MBTiles-Karte öffnen")
        .add_filter("MBTiles-Karten", &["mbtiles"])
        .add_filter("Alle Dateien", &["*"])
        .pick_file(move |path| { tx.send(path).ok(); });
    let picked = rx.recv().map_err(|_| "Dialog abgebrochen".to_string())?;
    let picked = picked.ok_or("Kein Pfad gewählt".to_string())?;
    let path_buf: PathBuf = match picked {
        FilePath::Path(p) => p,
        FilePath::Url(u)  => PathBuf::from(u.path()),
    };
    let path_str = path_buf.to_string_lossy().into_owned();
    // SQLite öffnen und in State setzen — inline, kein Self-Call wegen Mutex
    let conn = Connection::open(&path_str)
        .map_err(|e| format!("MBTiles öffnen: {e}"))?;
    conn.query_row(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tiles'",
        [],
        |_row| Ok(()),
    ).map_err(|_| "Datei ist keine gültige MBTiles-Datenbank".to_string())?;
    *state.conn.lock().unwrap() = Some(conn);
    *state.path.lock().unwrap() = Some(path_str.clone());
    Ok(path_str)
}

#[tauri::command]
fn mbtiles_open_path(state: State<'_, MbtilesState>, path: String) -> Result<String, String> {
    let conn = Connection::open(&path)
        .map_err(|e| format!("MBTiles öffnen: {e}"))?;
    // Mini-Sanity-Check: gibt es die Tabelle 'tiles'?
    conn.query_row(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tiles'",
        [],
        |_row| Ok(()),
    ).map_err(|_| "Datei ist keine gültige MBTiles-Datenbank".to_string())?;
    *state.conn.lock().unwrap() = Some(conn);
    *state.path.lock().unwrap() = Some(path.clone());
    Ok(path)
}

#[tauri::command]
fn mbtiles_close(state: State<'_, MbtilesState>) -> Result<(), String> {
    *state.conn.lock().unwrap() = None;
    *state.path.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
fn mbtiles_current_path(state: State<'_, MbtilesState>) -> Option<String> {
    state.path.lock().unwrap().clone()
}

#[tauri::command]
fn mbtiles_metadata(state: State<'_, MbtilesState>) -> Result<MbtilesMetadata, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("Keine MBTiles geöffnet")?;
    let mut meta = MbtilesMetadata {
        name: None, format: None, minzoom: None, maxzoom: None,
        bounds: None, center: None, description: None, attribution: None,
    };
    let mut stmt = conn.prepare("SELECT name, value FROM metadata")
        .map_err(|e| format!("Metadata lesen: {e}"))?;
    let rows = stmt.query_map([], |row| {
        let k: String = row.get(0)?;
        let v: String = row.get(1)?;
        Ok((k, v))
    }).map_err(|e| e.to_string())?;
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        match k.as_str() {
            "name"        => meta.name = Some(v),
            "format"      => meta.format = Some(v),
            "minzoom"     => meta.minzoom = v.parse().ok(),
            "maxzoom"     => meta.maxzoom = v.parse().ok(),
            "bounds"      => meta.bounds = Some(v),
            "center"      => meta.center = Some(v),
            "description" => meta.description = Some(v),
            "attribution" => meta.attribution = Some(v),
            _ => {}
        }
    }
    // Falls minzoom/maxzoom nicht in den Metadaten stehen, aus den tiles ableiten
    if meta.minzoom.is_none() || meta.maxzoom.is_none() {
        if let Ok((mn, mx)) = conn.query_row(
            "SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles",
            [],
            |row| Ok((row.get::<_, i32>(0)?, row.get::<_, i32>(1)?))
        ) {
            if meta.minzoom.is_none() { meta.minzoom = Some(mn); }
            if meta.maxzoom.is_none() { meta.maxzoom = Some(mx); }
        }
    }
    Ok(meta)
}

#[tauri::command]
fn mbtiles_get_tile(
    state: State<'_, MbtilesState>,
    z: i32,
    x: i32,
    y: i32,
) -> Result<Option<Vec<u8>>, String> {
    // MBTiles speichert Tiles im TMS-Schema (Y von unten nach oben). Web/Leaflet
    // erwarten XYZ-Schema (Y von oben). Umrechnung: tms_y = (2^z - 1) - y
    let tms_y = (1i32 << z).saturating_sub(1) - y;
    let guard = state.conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("Keine MBTiles geöffnet")?;
    let result: Result<Vec<u8>, _> = conn.query_row(
        "SELECT tile_data FROM tiles WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
        [z, x, tms_y],
        |row| row.get(0),
    );
    match result {
        Ok(bytes) => Ok(Some(bytes)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Tile-Lesefehler: {e}")),
    }
}

// ── Entry Point ──────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(MbtilesState::default())
        .invoke_handler(tauri::generate_handler![
            open_board,
            save_board,
            autosave_board,
            app_tmp_dir,
            list_system_fonts,
            mbtiles_open,
            mbtiles_open_path,
            mbtiles_close,
            mbtiles_current_path,
            mbtiles_metadata,
            mbtiles_get_tile,
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der BoardDesk-App");
}
