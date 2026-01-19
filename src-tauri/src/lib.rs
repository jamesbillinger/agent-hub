use axum::{
    Router,
    extract::{Path, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json,
};

// App name - different for dev vs prod to easily distinguish them
#[cfg(debug_assertions)]
const APP_NAME: &str = "Agent Hub (Dev)";
#[cfg(not(debug_assertions))]
const APP_NAME: &str = "Agent Hub";
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
#[cfg(not(target_os = "ios"))]
use futures::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
#[cfg(not(target_os = "ios"))]
use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(target_os = "ios"))]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(not(target_os = "ios"))]
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

// MCP server module for Claude Code integration
#[cfg(not(target_os = "ios"))]
mod mcp;

// Flag to track if MCP mode is enabled
#[cfg(not(target_os = "ios"))]
static MCP_MODE: Lazy<std::sync::atomic::AtomicBool> =
    Lazy::new(|| std::sync::atomic::AtomicBool::new(false));

#[cfg(not(target_os = "ios"))]
struct PtySession {
    pair: PtyPair,
    writer: Box<dyn Write + Send>,
}

#[cfg(not(target_os = "ios"))]
static PTY_SESSIONS: Lazy<Mutex<HashMap<String, Arc<Mutex<PtySession>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// Broadcast channels for PTY output - used by both Tauri and WebSocket clients
#[cfg(not(target_os = "ios"))]
static PTY_BROADCASTERS: Lazy<Mutex<HashMap<String, broadcast::Sender<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// JSON process sessions (non-PTY, for streaming JSON communication)
#[cfg(not(target_os = "ios"))]
struct JsonProcess {
    stdin: tokio::sync::mpsc::Sender<String>,
    #[allow(dead_code)]
    child_id: u32,
}

#[cfg(not(target_os = "ios"))]
static JSON_PROCESSES: Lazy<Mutex<HashMap<String, JsonProcess>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// Broadcast channels for JSON process output - used by WebSocket clients
#[cfg(not(target_os = "ios"))]
static JSON_BROADCASTERS: Lazy<Mutex<HashMap<String, broadcast::Sender<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// Global AppHandle for web server to use
static APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

// Web server port - determined at runtime with failover
static WEB_SERVER_PORT: Lazy<Mutex<Option<u16>>> = Lazy::new(|| Mutex::new(None));

// Authentication: Active pairing requests (pairing_id -> code)
static PAIRING_REQUESTS: Lazy<Mutex<HashMap<String, PairingRequest>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// Authentication: Paired devices (token -> device info)
static PAIRED_DEVICES: Lazy<Mutex<HashMap<String, PairedDevice>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// MCP HTTP: Pending requests waiting for JS execution results
static MCP_HTTP_RESULTS: Lazy<Mutex<HashMap<String, Option<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// PIN authentication: Rate limiting (IP -> (attempts, last_attempt_time))
static PIN_RATE_LIMIT: Lazy<Mutex<HashMap<String, (u32, std::time::Instant)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PairingRequest {
    code: String,
    created_at: chrono::DateTime<chrono::Utc>,
    device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PairedDevice {
    id: String,
    name: String,
    paired_at: String,
    last_seen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PtyOutput {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct WindowState {
    width: Option<u32>,
    height: Option<u32>,
    x: Option<i32>,
    y: Option<i32>,
    sidebar_width: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppSettings {
    font_size: u32,
    font_family: String,
    theme: String,
    default_working_dir: String,
    default_agent_type: String,
    notifications_enabled: bool,
    #[serde(default = "default_true")]
    bell_notifications_enabled: bool,
    #[serde(default = "default_true")]
    bounce_dock_on_bell: bool,
    #[serde(default)]
    read_aloud_enabled: bool,
    #[serde(default = "default_renderer")]
    renderer: String,
    #[serde(default)]
    remote_pin: Option<String>,
}

fn default_renderer() -> String {
    "webgl".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: 13,
            font_family: "Menlo, Monaco, 'Courier New', monospace".to_string(),
            theme: "dark".to_string(),
            default_working_dir: "~/dev/pplsi".to_string(),
            default_agent_type: "claude".to_string(),
            notifications_enabled: true,
            bell_notifications_enabled: true,
            bounce_dock_on_bell: true,
            read_aloud_enabled: false,
            renderer: "webgl".to_string(),
            remote_pin: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionData {
    id: String,
    name: String,
    agent_type: String,
    command: String,
    working_dir: String,
    created_at: String,
    claude_session_id: Option<String>,
    sort_order: i32,
}

/// Get the app data directory name based on build type
/// In debug builds, use "agent-hub-dev" to separate data from production
fn get_app_data_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "agent-hub-dev"
    } else {
        "agent-hub"
    }
}

fn get_db_path() -> PathBuf {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(get_app_data_dir_name());
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("sessions.db")
}

fn init_db() -> rusqlite::Result<Connection> {
    let conn = Connection::open(get_db_path())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            agent_type TEXT NOT NULL,
            command TEXT NOT NULL,
            working_dir TEXT NOT NULL,
            created_at TEXT NOT NULL,
            claude_session_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )?;
    // Migration: Add sort_order column if it doesn't exist
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0", []);

    // Create terminal_buffers table for scrollback persistence
    // Stores compressed (gzip + base64) terminal buffer content
    conn.execute(
        "CREATE TABLE IF NOT EXISTS terminal_buffers (
            session_id TEXT PRIMARY KEY,
            buffer_data TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Create paired_devices table for remote access authentication
    conn.execute(
        "CREATE TABLE IF NOT EXISTS paired_devices (
            token TEXT PRIMARY KEY,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            paired_at TEXT NOT NULL,
            last_seen TEXT NOT NULL
        )",
        [],
    )?;

    Ok(conn)
}

// Load paired devices from database into memory
fn load_paired_devices() {
    if let Ok(conn) = init_db() {
        if let Ok(mut stmt) = conn.prepare("SELECT token, id, name, paired_at, last_seen FROM paired_devices") {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    PairedDevice {
                        id: row.get(1)?,
                        name: row.get(2)?,
                        paired_at: row.get(3)?,
                        last_seen: row.get(4)?,
                    },
                ))
            }) {
                let mut devices = PAIRED_DEVICES.lock();
                for row in rows.flatten() {
                    devices.insert(row.0, row.1);
                }
            }
        }
    }
}

// Save a paired device to database
fn save_paired_device(token: &str, device: &PairedDevice) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO paired_devices (token, id, name, paired_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![token, device.id, device.name, device.paired_at, device.last_seen],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// Delete a paired device from database
fn delete_paired_device_db(token: &str) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM paired_devices WHERE token = ?1", params![token])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Generate a random 6-digit pairing code
fn generate_pairing_code() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:06}", (seed % 1_000_000) as u32)
}

// Generate a random token for device auth
fn generate_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}{:x}", seed, seed.wrapping_mul(0x5DEECE66D))
}

// Check if a token is valid
fn is_valid_token(token: &str) -> bool {
    let devices = PAIRED_DEVICES.lock();
    devices.contains_key(token)
}

#[tauri::command]
fn load_sessions() -> Result<Vec<SessionData>, String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, agent_type, command, working_dir, created_at, claude_session_id, sort_order FROM sessions ORDER BY sort_order ASC, created_at DESC")
        .map_err(|e| e.to_string())?;

    let sessions = stmt
        .query_map([], |row| {
            Ok(SessionData {
                id: row.get(0)?,
                name: row.get(1)?,
                agent_type: row.get(2)?,
                command: row.get(3)?,
                working_dir: row.get(4)?,
                created_at: row.get(5)?,
                claude_session_id: row.get(6)?,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(sessions)
}

#[tauri::command]
fn save_session(session: SessionData) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO sessions (id, name, agent_type, command, working_dir, created_at, claude_session_id, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            session.id,
            session.name,
            session.agent_type,
            session.command,
            session.working_dir,
            session.created_at,
            session.claude_session_id,
            session.sort_order,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_session_orders(session_orders: Vec<(String, i32)>) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    for (session_id, sort_order) in session_orders {
        conn.execute(
            "UPDATE sessions SET sort_order = ?1 WHERE id = ?2",
            params![sort_order, session_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn delete_session(session_id: String) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_session_claude_id(session_id: String, claude_session_id: String) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions SET claude_session_id = ?1 WHERE id = ?2",
        params![claude_session_id, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Detect the actual Claude session ID by scanning the project folder for the newest session file.
/// Claude creates session files at ~/.claude/projects/[project-path]/[session-id].jsonl
/// The project-path is derived from the working directory by replacing / with - (and removing leading -)
/// Only considers files modified after `min_time` to avoid matching old session files.
#[cfg(not(target_os = "ios"))]
fn detect_claude_session_id(
    working_dir: &Option<std::path::PathBuf>,
    min_time: std::time::SystemTime,
) -> Option<String> {
    // Get home directory
    let home = dirs::home_dir()?;

    // Build the claude projects path
    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.exists() {
        return None;
    }

    // Resolve the working directory
    let work_dir = working_dir.as_ref()
        .map(|p| p.to_path_buf())
        .or_else(|| dirs::home_dir())?;

    // Convert path to Claude's folder naming convention: /Users/foo/bar -> -Users-foo-bar
    let project_folder_name = work_dir.to_string_lossy()
        .replace('/', "-")
        .trim_start_matches('-')
        .to_string();

    // Full project folder path
    let project_folder = claude_projects.join(format!("-{}", project_folder_name));
    if !project_folder.exists() {
        return None;
    }

    // Find the newest .jsonl file in the project folder that was created after min_time
    let mut newest_session: Option<(String, std::time::SystemTime)> = None;

    if let Ok(entries) = std::fs::read_dir(&project_folder) {
        for entry in entries.flatten() {
            let path = entry.path();

            // Skip directories and non-jsonl files
            if path.is_dir() {
                continue;
            }

            if let Some(ext) = path.extension() {
                if ext != "jsonl" {
                    continue;
                }
            } else {
                continue;
            }

            // Get file stem (filename without extension) as the session ID
            let session_id = match path.file_stem() {
                Some(s) => s.to_string_lossy().to_string(),
                None => continue,
            };

            // Skip if it doesn't look like a UUID
            if session_id.len() != 36 || session_id.chars().filter(|c| *c == '-').count() != 4 {
                continue;
            }

            // Get modification time
            if let Ok(metadata) = entry.metadata() {
                if let Ok(mtime) = metadata.modified() {
                    // Only consider files modified after min_time
                    if mtime <= min_time {
                        continue;
                    }

                    match &newest_session {
                        None => newest_session = Some((session_id, mtime)),
                        Some((_, prev_mtime)) if mtime > *prev_mtime => {
                            newest_session = Some((session_id, mtime));
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    newest_session.map(|(id, _)| id)
}

/// Struct for emitting detected Claude session ID event
#[derive(Clone, Serialize)]
struct ClaudeSessionDetected {
    session_id: String,         // Our internal session ID
    claude_session_id: String,  // Claude's actual session ID
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn spawn_pty(
    app: AppHandle,
    session_id: String,
    command: Option<String>,
    working_dir: Option<String>,
    cols: u16,
    rows: u16,
    claude_session_id: Option<String>,
    resume_session: Option<bool>,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd_str = command.unwrap_or_else(|| {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    });

    // Handle Claude session resume
    // Only use --resume flag when explicitly resuming an existing session
    // For new sessions, start Claude fresh and let it create its own session ID
    if cmd_str.contains("claude") {
        if let Some(ref claude_id) = claude_session_id {
            if resume_session.unwrap_or(false) {
                // Replace the command to use --resume with the existing session ID
                // Keep --dangerously-skip-permissions if it was present
                let has_skip_perms = cmd_str.contains("--dangerously-skip-permissions");
                cmd_str = if has_skip_perms {
                    format!("claude --resume {} --dangerously-skip-permissions", claude_id)
                } else {
                    format!("claude --resume {}", claude_id)
                };
            }
            // For new sessions, don't use --session-id as it expects an existing session
            // Claude will create its own session ID, which we'll capture from output
        }
    }

    // Resolve working directory
    let work_dir = working_dir
        .map(|d| {
            if d.starts_with("~/") {
                dirs::home_dir()
                    .map(|h| h.join(&d[2..]))
                    .unwrap_or_else(|| std::path::PathBuf::from(&d))
            } else if d == "~" {
                dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(&d))
            } else {
                std::path::PathBuf::from(&d)
            }
        })
        .or_else(|| dirs::home_dir());

    // Get user's home directory and shell
    let home_dir = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/Users".to_string());
    let user_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Build PATH with common tool locations (GUI apps have minimal PATH)
    let existing_path = std::env::var("PATH").unwrap_or_default();
    let enhanced_path = format!(
        "{}/.local/bin:{}/.nvm/versions/node/v24.10.0/bin:{}/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:{}",
        home_dir, home_dir, home_dir, existing_path
    );

    // Always use login shell for agent commands to get proper environment
    // This ensures nvm, pyenv, rbenv, etc. are properly initialized
    let mut cmd = if cmd_str.contains("claude") || cmd_str.contains("aider") || cmd_str.contains("codex") {
        let mut c = CommandBuilder::new(&user_shell);
        // Use -l (login) and -i (interactive) to source all profile files
        c.args(&["-l", "-i", "-c", &cmd_str]);
        c
    } else {
        CommandBuilder::new(&cmd_str)
    };

    // Set up environment for GUI app context
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("HOME", &home_dir);
    cmd.env("PATH", &enhanced_path);
    cmd.env("SHELL", &user_shell);

    // Set working directory
    if let Some(ref dir) = work_dir {
        cmd.cwd(dir);
    }

    // Capture current time before spawning (for session ID detection)
    let spawn_time = std::time::SystemTime::now();

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let session = Arc::new(Mutex::new(PtySession { pair, writer }));

    // Create broadcast channel for this session (for WebSocket clients)
    let (tx, _rx) = broadcast::channel::<Vec<u8>>(256);

    {
        let mut sessions = PTY_SESSIONS.lock();
        sessions.insert(session_id.clone(), session);
    }
    {
        let mut broadcasters = PTY_BROADCASTERS.lock();
        broadcasters.insert(session_id.clone(), tx.clone());
    }

    // For new Claude sessions (not resuming), spawn a thread to detect the actual session ID
    // Claude creates its own session ID, so we need to scan the projects folder
    let is_claude_command = cmd_str.contains("claude");
    let is_new_session = !resume_session.unwrap_or(false);

    if is_claude_command && is_new_session {
        let app_for_detection = app.clone();
        let session_id_for_detection = session_id.clone();
        let work_dir_for_detection = work_dir.clone();

        thread::spawn(move || {
            // Wait for Claude to start and create its session file
            // We poll multiple times with increasing delays to catch the session file
            let delays_ms = [500, 1000, 2000, 3000, 5000];

            for delay in delays_ms.iter() {
                thread::sleep(std::time::Duration::from_millis(*delay));

                // Only detect sessions created after we spawned the process
                if let Some(detected_id) = detect_claude_session_id(&work_dir_for_detection, spawn_time) {
                    // Update the database
                    if let Err(e) = update_session_claude_id(
                        session_id_for_detection.clone(),
                        detected_id.clone(),
                    ) {
                        eprintln!("Failed to update session claude_id in DB: {}", e);
                    }

                    // Emit event to frontend
                    let _ = app_for_detection.emit(
                        "claude-session-detected",
                        ClaudeSessionDetected {
                            session_id: session_id_for_detection.clone(),
                            claude_session_id: detected_id,
                        },
                    );

                    // Successfully detected, stop polling
                    break;
                }
            }
        });
    }

    // Spawn reader thread
    let session_id_clone = session_id.clone();
    let app_clone = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF - process exited
                    let _ = app_clone.emit(
                        "pty-exit",
                        PtyOutput {
                            session_id: session_id_clone.clone(),
                            data: String::new(),
                        },
                    );
                    break;
                }
                Ok(n) => {
                    let data_bytes = buf[..n].to_vec();
                    let data = String::from_utf8_lossy(&data_bytes).to_string();

                    // Emit to Tauri app
                    let _ = app_clone.emit(
                        "pty-output",
                        PtyOutput {
                            session_id: session_id_clone.clone(),
                            data,
                        },
                    );

                    // Broadcast to WebSocket clients
                    let _ = tx.send(data_bytes);
                }
                Err(_) => break,
            }
        }
        // Clean up session
        {
            let mut sessions = PTY_SESSIONS.lock();
            sessions.remove(&session_id_clone);
        }
        {
            let mut broadcasters = PTY_BROADCASTERS.lock();
            broadcasters.remove(&session_id_clone);
        }
    });

    Ok(())
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn write_pty(session_id: String, data: String) -> Result<(), String> {
    let sessions = PTY_SESSIONS.lock();
    if let Some(session) = sessions.get(&session_id) {
        let mut session = session.lock();
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn resize_pty(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = PTY_SESSIONS.lock();
    if let Some(session) = sessions.get(&session_id) {
        let session = session.lock();
        session
            .pair
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn kill_pty(session_id: String) -> Result<(), String> {
    let mut sessions = PTY_SESSIONS.lock();
    sessions.remove(&session_id);
    Ok(())
}

// ============================================
// JSON Process Commands (for claude-json sessions)
// ============================================

/// Spawn a JSON streaming process (non-PTY)
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn spawn_json_process(
    app: AppHandle,
    session_id: String,
    command: String,
    working_dir: Option<String>,
    claude_session_id: Option<String>,
    resume_session: Option<bool>,
) -> Result<(), String> {
    use std::process::Stdio;
    use std::sync::mpsc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command;

    // Build the command with resume flag if needed
    let mut cmd_str = command;
    if let Some(ref claude_id) = claude_session_id {
        if resume_session.unwrap_or(false) {
            // Add --resume flag for existing sessions
            if !cmd_str.contains("--resume") {
                cmd_str = cmd_str.replace("claude ", &format!("claude --resume {} ", claude_id));
            }
        }
    }

    let work_dir = working_dir
        .map(|d| shellexpand::tilde(&d).to_string())
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".to_string()));

    // Create channel for stdin
    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<String>(100);

    // Create channel to signal when process is ready (registered in JSON_PROCESSES)
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    let session_id_clone = session_id.clone();
    let app_clone = app.clone();

    // Spawn the process in a tokio task
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create runtime");
        rt.block_on(async move {
            // Check for empty command
            if cmd_str.trim().is_empty() {
                let _ = app_clone.emit("json-process-error", serde_json::json!({
                    "session_id": session_id_clone,
                    "error": "Empty command"
                }));
                let _ = ready_tx.send(Err("Empty command".to_string()));
                return;
            }

            // Use an interactive shell to ensure PATH includes user-installed tools like nvm
            // GUI apps on macOS don't inherit the user's shell PATH
            // -i sources ~/.zshrc (where nvm is typically configured)
            // -l sources ~/.zprofile (login files)
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

            let mut child = match Command::new(&shell)
                .args(&["-i", "-l", "-c", &cmd_str])
                .current_dir(&work_dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    let err_msg = format!("Failed to spawn process: {}", e);
                    let _ = app_clone.emit("json-process-error", serde_json::json!({
                        "session_id": session_id_clone,
                        "error": &err_msg
                    }));
                    let _ = ready_tx.send(Err(err_msg));
                    return;
                }
            };

            let child_id = child.id().unwrap_or(0);

            // Take ownership of stdin/stdout/stderr
            let mut stdin = child.stdin.take().expect("Failed to get stdin");
            let stdout = child.stdout.take().expect("Failed to get stdout");
            let stderr = child.stderr.take().expect("Failed to get stderr");

            // Create broadcast channel for WebSocket clients
            let (broadcast_tx, _rx) = broadcast::channel::<String>(256);

            // Store the process handle and broadcast channel
            {
                let mut processes = JSON_PROCESSES.lock();
                processes.insert(session_id_clone.clone(), JsonProcess {
                    stdin: stdin_tx.clone(),
                    child_id,
                });
            }
            {
                let mut broadcasters = JSON_BROADCASTERS.lock();
                broadcasters.insert(session_id_clone.clone(), broadcast_tx.clone());
            }

            // Signal that process is ready - WebSocket connections can now find it
            let _ = ready_tx.send(Ok(()));

            // Notify that process started
            let _ = app_clone.emit("json-process-started", serde_json::json!({
                "session_id": session_id_clone
            }));

            // Spawn task to handle stdin
            let session_id_stdin = session_id_clone.clone();
            tokio::spawn(async move {
                while let Some(data) = stdin_rx.recv().await {
                    if let Err(e) = stdin.write_all(data.as_bytes()).await {
                        eprintln!("Error writing to stdin for {}: {}", session_id_stdin, e);
                        break;
                    }
                    if let Err(e) = stdin.flush().await {
                        eprintln!("Error flushing stdin for {}: {}", session_id_stdin, e);
                        break;
                    }
                }
            });

            // Spawn task to handle stdout
            let app_stdout = app_clone.clone();
            let session_id_stdout = session_id_clone.clone();
            let broadcast_stdout = broadcast_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let data = line + "\n";
                    // Emit to Tauri (for desktop app)
                    let _ = app_stdout.emit("json-process-output", serde_json::json!({
                        "session_id": session_id_stdout,
                        "data": &data
                    }));
                    // Broadcast to WebSocket clients (for mobile web)
                    let _ = broadcast_stdout.send(data);
                }
            });

            // Spawn task to handle stderr
            let app_stderr = app_clone.clone();
            let session_id_stderr = session_id_clone.clone();
            let broadcast_stderr = broadcast_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let data = line + "\n";
                    // Emit to Tauri (for desktop app)
                    let _ = app_stderr.emit("json-process-output", serde_json::json!({
                        "session_id": session_id_stderr,
                        "data": &data
                    }));
                    // Broadcast to WebSocket clients (for mobile web)
                    let _ = broadcast_stderr.send(data);
                }
            });

            // Wait for process to exit
            match child.wait().await {
                Ok(status) => {
                    let _ = app_clone.emit("json-process-exit", serde_json::json!({
                        "session_id": session_id_clone,
                        "exit_code": status.code()
                    }));
                }
                Err(e) => {
                    let _ = app_clone.emit("json-process-error", serde_json::json!({
                        "session_id": session_id_clone,
                        "error": format!("Process error: {}", e)
                    }));
                }
            }

            // Clean up
            {
                let mut processes = JSON_PROCESSES.lock();
                processes.remove(&session_id_clone);
            }
            {
                let mut broadcasters = JSON_BROADCASTERS.lock();
                broadcasters.remove(&session_id_clone);
            }
        });
    });

    // Wait for the process to be ready (registered in JSON_PROCESSES)
    // This ensures WebSocket connections can find the session immediately
    // Timeout after 10 seconds to avoid blocking forever
    match ready_rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Timeout waiting for process to start".to_string()),
    }
}

/// Write data to a JSON process stdin
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn write_to_process(session_id: String, data: String) -> Result<(), String> {
    let processes = JSON_PROCESSES.lock();
    if let Some(process) = processes.get(&session_id) {
        process.stdin.try_send(data)
            .map_err(|e| format!("Failed to send to stdin: {}", e))?;
        Ok(())
    } else {
        Err("Process not found".to_string())
    }
}

/// Kill a JSON process
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn kill_json_process(session_id: String) -> Result<(), String> {
    let mut processes = JSON_PROCESSES.lock();
    processes.remove(&session_id);
    // Note: This drops the stdin sender which should cause the process to eventually exit
    // For force kill, we'd need to store the Child handle
    Ok(())
}

/// Compress and save terminal buffer content to the database
/// The buffer_content is the raw terminal content from xterm.js serialization
#[tauri::command]
fn save_terminal_buffer(session_id: String, buffer_content: String) -> Result<(), String> {
    // Compress the buffer content using gzip
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(buffer_content.as_bytes())
        .map_err(|e| format!("Failed to compress buffer: {}", e))?;
    let compressed = encoder
        .finish()
        .map_err(|e| format!("Failed to finish compression: {}", e))?;

    // Encode to base64 for safe text storage
    let encoded = BASE64.encode(&compressed);

    let conn = init_db().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT OR REPLACE INTO terminal_buffers (session_id, buffer_data, updated_at)
         VALUES (?1, ?2, ?3)",
        params![session_id, encoded, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Load and decompress terminal buffer content from the database
/// Returns the raw terminal content to be written to xterm.js
#[tauri::command]
fn load_terminal_buffer(session_id: String) -> Result<Option<String>, String> {
    let conn = init_db().map_err(|e| e.to_string())?;

    let result: Result<String, _> = conn.query_row(
        "SELECT buffer_data FROM terminal_buffers WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    );

    match result {
        Ok(encoded) => {
            // Decode from base64
            let compressed = BASE64
                .decode(&encoded)
                .map_err(|e| format!("Failed to decode buffer: {}", e))?;

            // Decompress using gzip
            let mut decoder = GzDecoder::new(&compressed[..]);
            let mut decompressed = String::new();
            decoder
                .read_to_string(&mut decompressed)
                .map_err(|e| format!("Failed to decompress buffer: {}", e))?;

            Ok(Some(decompressed))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete terminal buffer when session is deleted
#[tauri::command]
fn delete_terminal_buffer(session_id: String) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM terminal_buffers WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get the web server port (for frontend to know which port to use for remote access)
#[tauri::command]
fn get_web_server_port() -> Result<Option<u16>, String> {
    let port = WEB_SERVER_PORT.lock();
    Ok(*port)
}

fn get_config_path() -> PathBuf {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(get_app_data_dir_name());
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("config.json")
}

fn get_window_state_path() -> PathBuf {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(get_app_data_dir_name());
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("window_state.json")
}

/// Save window state to config file
#[tauri::command]
fn save_window_state(state: WindowState) -> Result<(), String> {
    let path = get_window_state_path();
    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize window state: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write window state: {}", e))?;
    Ok(())
}

/// Load window state from config file
#[tauri::command]
fn load_window_state() -> Result<WindowState, String> {
    let path = get_window_state_path();
    if !path.exists() {
        return Ok(WindowState::default());
    }
    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read window state: {}", e))?;
    let state: WindowState = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse window state: {}", e))?;
    Ok(state)
}

/// Save app settings to config file
#[tauri::command]
fn save_app_settings(settings: AppSettings) -> Result<(), String> {
    let path = get_config_path();
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write settings: {}", e))?;
    Ok(())
}

/// Load app settings from config file
#[tauri::command]
fn load_app_settings() -> Result<AppSettings, String> {
    let path = get_config_path();
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;
    let settings: AppSettings = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse settings: {}", e))?;
    Ok(settings)
}

/// MCP callback - receives results from JS execution
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn mcp_callback(request_id: String, result: String) {
    mcp::resolve_mcp_request(request_id, result);
}

#[cfg(not(target_os = "ios"))]
fn create_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // App menu (macOS standard - has Quit)
    let about_text = format!("About {}", APP_NAME);
    let hide_text = format!("Hide {}", APP_NAME);
    let quit_text = format!("Quit {}", APP_NAME);

    let app_menu = Submenu::with_items(
        app,
        APP_NAME,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&about_text), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("Services"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&hide_text))?,
            &PredefinedMenuItem::hide_others(app, Some("Hide Others"))?,
            &PredefinedMenuItem::show_all(app, Some("Show All"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&quit_text))?,
        ],
    )?;

    // File menu
    let new_session = MenuItem::with_id(app, "new_session", "New Session", true, Some("CmdOrCtrl+T"))?;
    let close_session = MenuItem::with_id(app, "close_session", "Close Session", true, Some("CmdOrCtrl+W"))?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_session,
            &close_session,
            &PredefinedMenuItem::separator(app)?,
            &settings,
        ],
    )?;

    // Edit menu
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Undo"))?,
            &PredefinedMenuItem::redo(app, Some("Redo"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Cut"))?,
            &PredefinedMenuItem::copy(app, Some("Copy"))?,
            &PredefinedMenuItem::paste(app, Some("Paste"))?,
            &PredefinedMenuItem::select_all(app, Some("Select All"))?,
        ],
    )?;

    // View menu
    let toggle_sidebar = MenuItem::with_id(app, "toggle_sidebar", "Toggle Sidebar", true, Some("CmdOrCtrl+B"))?;
    let zoom_in = MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+Plus"))?;
    let zoom_out = MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let reset_zoom = MenuItem::with_id(app, "reset_zoom", "Reset Zoom", true, Some("CmdOrCtrl+0"))?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &toggle_sidebar,
            &PredefinedMenuItem::separator(app)?,
            &zoom_in,
            &zoom_out,
            &reset_zoom,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some("Toggle Full Screen"))?,
        ],
    )?;

    // Session menu
    let rename_session = MenuItem::with_id(app, "rename_session", "Rename Session", true, Some("CmdOrCtrl+I"))?;
    let duplicate_session = MenuItem::with_id(app, "duplicate_session", "Duplicate Session", true, Some("CmdOrCtrl+Shift+D"))?;
    let reset_session_id = MenuItem::with_id(app, "reset_session_id", "Reset Session ID", true, None::<&str>)?;
    let next_session = MenuItem::with_id(app, "next_session", "Next Session", true, Some("Ctrl+Tab"))?;
    let prev_session = MenuItem::with_id(app, "prev_session", "Previous Session", true, Some("Ctrl+Shift+Tab"))?;

    let session_menu = Submenu::with_items(
        app,
        "Session",
        true,
        &[
            &rename_session,
            &duplicate_session,
            &reset_session_id,
            &PredefinedMenuItem::separator(app)?,
            &next_session,
            &prev_session,
        ],
    )?;

    // Window menu
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Minimize"))?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
        ],
    )?;

    // Help menu
    let help_about_text = format!("About {}", APP_NAME);
    let about = MenuItem::with_id(app, "about", &help_about_text, true, None::<&str>)?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &about,
        ],
    )?;

    // Build the menu (app_menu first for macOS standard layout)
    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &session_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

// ============== Web API ==============

// Port configuration - dev and prod use different ports to avoid conflicts
// Prod: 3847 (fixed, no fallback - it's the primary instance)
// Dev:  3857 (with fallback - in case multiple dev instances)
#[cfg(debug_assertions)]
const WEB_PORT_BASE: u16 = 3857;
#[cfg(not(debug_assertions))]
const WEB_PORT_BASE: u16 = 3847;

#[cfg(debug_assertions)]
const WEB_PORT_MAX_ATTEMPTS: u16 = 10;
#[cfg(not(debug_assertions))]
const WEB_PORT_MAX_ATTEMPTS: u16 = 1; // Prod doesn't fallback - it owns port 3847

// Mobile web client with Messages-style navigation
const MOBILE_HTML: &str = r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>{{APP_NAME}}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      background: #1a1a1a;
      color: #e6e6e6;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      height: 100%;
      width: 100%;
      overflow: hidden;
      position: fixed;
    }

    /* Navigation container - handles slide transitions */
    #nav-container {
      display: flex;
      width: 200%;
      height: 100%;
      transition: transform 0.3s ease-out;
    }
    #nav-container.show-session {
      transform: translateX(-50%);
    }

    /* Sessions List View */
    #sessions-view {
      width: 50%;
      height: 100%;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }

    .view-header {
      padding: 12px 16px;
      padding-top: max(12px, env(safe-area-inset-top));
      background: #252526;
      border-bottom: 1px solid #3c3c3c;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .view-header h1 {
      font-size: 20px;
      font-weight: 600;
    }
    .view-header-actions {
      display: flex;
      gap: 8px;
    }
    .view-header button {
      padding: 8px 12px;
      background: transparent;
      border: none;
      color: #0e9fd8;
      font-size: 16px;
      cursor: pointer;
    }
    .view-header button:active {
      opacity: 0.6;
    }

    #session-list {
      flex: 1;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .session-item {
      display: flex;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid #3c3c3c;
      cursor: pointer;
      transition: background-color 0.1s;
    }
    .session-item:active {
      background: #2a2a2a;
    }
    .session-status {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 12px;
      flex-shrink: 0;
    }
    .session-status.running { background: #4ec9b0; }
    .session-status.stopped { background: #555; }
    .session-info {
      flex: 1;
      min-width: 0;
    }
    .session-name {
      font-size: 16px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-meta {
      font-size: 13px;
      color: #808080;
      margin-top: 2px;
    }
    .session-chevron {
      color: #555;
      font-size: 18px;
      margin-left: 8px;
    }

    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
      color: #808080;
    }
    .empty-state-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
    .empty-state h2 { font-size: 18px; margin-bottom: 8px; color: #aaa; }

    /* Session Detail View */
    #session-view {
      width: 50%;
      height: 100%;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }

    .session-header {
      padding: 12px 16px;
      padding-top: max(12px, env(safe-area-inset-top));
      background: #252526;
      border-bottom: 1px solid #3c3c3c;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .back-btn {
      padding: 8px;
      margin: -8px;
      margin-right: 0;
      background: none;
      border: none;
      color: #0e9fd8;
      font-size: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .back-btn:active { opacity: 0.6; }
    .session-title {
      flex: 1;
      font-size: 17px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .start-btn {
      padding: 6px 14px;
      background: #388a34;
      border: none;
      border-radius: 6px;
      color: white;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    .start-btn:disabled { background: #555; }

    #terminal-container {
      flex: 1;
      padding: 4px;
      overflow: hidden;
      position: relative;
      /* Shrinks when keyboard appears */
      min-height: 0;
    }

    /* Chat container for JSON sessions */
    #chat-container {
      flex: 1;
      display: none;
      flex-direction: column;
      min-height: 0;
    }
    #chat-container.active {
      display: flex;
    }
    #chat-messages {
      flex: 1;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: 12px;
    }
    .chat-msg {
      margin-bottom: 12px;
      padding: 10px 14px;
      border-radius: 12px;
      max-width: 85%;
      word-wrap: break-word;
    }
    .chat-msg.user {
      background: #0e9fd8;
      color: white;
      margin-left: auto;
      border-bottom-right-radius: 4px;
    }
    .chat-msg.assistant {
      background: #2a2a2a;
      color: #e6e6e6;
      border-bottom-left-radius: 4px;
    }
    .chat-msg.system {
      background: transparent;
      color: #808080;
      font-size: 12px;
      text-align: center;
      max-width: 100%;
      padding: 4px;
    }
    .chat-msg.tool-use {
      background: #1e3a4c;
      color: #4ec9b0;
      font-size: 13px;
    }
    .chat-msg pre {
      margin: 8px 0 0 0;
      padding: 8px;
      background: rgba(0,0,0,0.3);
      border-radius: 6px;
      overflow-x: auto;
      white-space: pre-wrap;
      font-size: 12px;
    }
    .chat-msg code {
      font-family: Menlo, Monaco, monospace;
      font-size: 13px;
    }
    .chat-msg :not(pre) > code {
      background: rgba(0,0,0,0.3);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .chat-msg p { margin: 0 0 8px 0; }
    .chat-msg p:last-child { margin-bottom: 0; }
    #chat-input-container {
      display: flex;
      gap: 8px;
      padding: 8px 12px;
      padding-bottom: max(8px, env(safe-area-inset-bottom));
      background: #252526;
      border-top: 1px solid #3c3c3c;
    }
    #chat-input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #3c3c3c;
      border-radius: 20px;
      background: #1a1a1a;
      color: #e6e6e6;
      font-size: 16px;
      resize: none;
      min-height: 40px;
      max-height: 120px;
      font-family: inherit;
    }
    #chat-input:focus {
      outline: none;
      border-color: #0e9fd8;
    }
    #chat-send {
      padding: 10px 16px;
      background: #0e9fd8;
      color: white;
      border: none;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    #chat-send:disabled {
      background: #555;
    }

    /* Paste indicator (shows on long-press) */
    #paste-indicator {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      padding: 12px 24px;
      background: rgba(14, 99, 156, 0.95);
      border-radius: 8px;
      color: white;
      font-size: 16px;
      font-weight: 500;
      z-index: 30;
      display: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    #paste-indicator.visible { display: block; }
    #terminal-container .xterm { height: 100%; width: 100%; }
    #terminal-container .xterm-viewport {
      overflow-y: auto !important;
    }
    /* Touch overlay for iOS scroll fix */
    #touch-overlay {
      display: none;
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: 10;
      touch-action: pan-y;
    }
    @media (pointer: coarse) {
      #touch-overlay { display: block; }
    }

    #status {
      padding: 6px 16px;
      padding-bottom: max(6px, env(safe-area-inset-bottom));
      background: #252526;
      font-size: 12px;
      color: #808080;
      flex-shrink: 0;
    }
    .connected { color: #4ec9b0 !important; }
    .disconnected { color: #f14c4c !important; }

    /* Pairing screen */
    #pairing-screen {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      text-align: center;
      background: #1a1a1a;
      z-index: 100;
    }
    #pairing-screen h2 { margin-bottom: 20px; font-size: 24px; }
    #pairing-screen p { margin-bottom: 20px; color: #808080; }
    #pairing-screen input {
      width: 200px;
      padding: 12px;
      font-size: 24px;
      text-align: center;
      letter-spacing: 8px;
      background: #3c3c3c;
      border: 1px solid #5a5a5a;
      border-radius: 8px;
      color: #e6e6e6;
      margin-bottom: 16px;
    }
    #pairing-screen button {
      padding: 14px 28px;
      font-size: 16px;
      background: #0e639c;
      border: none;
      border-radius: 8px;
      color: white;
      cursor: pointer;
    }
    #pairing-screen button:disabled { background: #555; }
    #pairing-screen .error { color: #f14c4c; margin-top: 12px; }

    /* Auth Tabs */
    #auth-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
    }
    .auth-tab {
      flex: 1;
      padding: 10px;
      background: #3c3c3c;
      border: 1px solid #5a5a5a;
      border-radius: 8px;
      color: #808080;
      font-size: 14px;
      cursor: pointer;
    }
    .auth-tab.active {
      background: #0e639c;
      border-color: #1177bb;
      color: white;
    }
    #pin-auth input, #pairing-auth input {
      width: 100%;
      padding: 16px;
      font-size: 24px;
      text-align: center;
      letter-spacing: 8px;
      background: #3c3c3c;
      border: 1px solid #5a5a5a;
      border-radius: 8px;
      color: #e6e6e6;
      margin-bottom: 16px;
    }
    #pin-auth input { letter-spacing: 2px; }

    /* New Session Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      align-items: flex-end;
      justify-content: center;
    }
    .modal-overlay.visible { display: flex; }
    .modal-content {
      background: #252526;
      border-radius: 12px 12px 0 0;
      padding: 20px;
      padding-bottom: max(20px, env(safe-area-inset-bottom));
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
    }
    .modal-content h3 { margin-bottom: 20px; font-size: 20px; text-align: center; }
    .modal-content .form-group { margin-bottom: 16px; }
    .modal-content label { display: block; margin-bottom: 6px; font-size: 14px; color: #808080; }
    .modal-content input, .modal-content select {
      width: 100%;
      padding: 12px;
      background: #3c3c3c;
      border: 1px solid #5a5a5a;
      border-radius: 8px;
      color: #e6e6e6;
      font-size: 16px;
    }
    .modal-content .modal-actions {
      display: flex;
      gap: 10px;
      margin-top: 24px;
    }
    .modal-content .modal-actions button {
      flex: 1;
      padding: 14px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
    }
    .modal-content .cancel-btn { background: #5a5a5a; color: #e6e6e6; }
    .modal-content .create-btn { background: #388a34; color: white; }
    .modal-content .create-btn:disabled { background: #555; }
    .modal-content .error { color: #f14c4c; margin-top: 8px; font-size: 14px; text-align: center; }

    #main-app { display: none; height: 100%; }
  </style>
</head>
<body>
  <!-- Pairing Screen -->
  <div id="pairing-screen">
    <h2>Connect to Agent Hub</h2>
    <div id="auth-tabs" style="display:none;">
      <button class="auth-tab active" data-tab="pin">PIN</button>
      <button class="auth-tab" data-tab="pairing">Pairing Code</button>
    </div>
    <!-- PIN Auth -->
    <div id="pin-auth" style="display:none;">
      <p id="pin-status">Enter your remote access PIN</p>
      <input type="password" id="pin-input" maxlength="20" placeholder="PIN" autocomplete="off" inputmode="numeric">
      <button id="pin-submit">Connect</button>
      <p class="error" id="pin-error"></p>
    </div>
    <!-- Pairing Code Auth (existing) -->
    <div id="pairing-auth">
      <p id="pairing-status">Enter the code shown on your desktop</p>
      <input type="text" id="pairing-code" maxlength="6" placeholder="000000" autocomplete="off" inputmode="numeric">
      <button id="pairing-submit">Pair</button>
      <p class="error" id="pairing-error"></p>
    </div>
  </div>

  <!-- New Session Modal -->
  <div id="new-session-modal" class="modal-overlay">
    <div class="modal-content">
      <h3>New Session</h3>
      <div class="form-group">
        <label for="new-session-name">Session Name (optional)</label>
        <input type="text" id="new-session-name" placeholder="My Session">
      </div>
      <div class="form-group">
        <label for="new-session-agent">Agent Type</label>
        <select id="new-session-agent">
          <option value="claude-json">Claude</option>
          <option value="claude">Claude (xterm)</option>
          <option value="aider">Aider</option>
          <option value="shell">Shell</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div class="form-group" id="custom-command-group" style="display:none;">
        <label for="new-session-command">Custom Command</label>
        <input type="text" id="new-session-command" placeholder="/bin/zsh">
      </div>
      <div class="form-group">
        <label for="new-session-dir">Working Directory (optional)</label>
        <input type="text" id="new-session-dir" placeholder="~/dev/pplsi">
      </div>
      <p class="error" id="new-session-error"></p>
      <div class="modal-actions">
        <button class="cancel-btn" id="new-session-cancel">Cancel</button>
        <button class="create-btn" id="new-session-create">Create</button>
      </div>
    </div>
  </div>

  <!-- Main App with slide navigation -->
  <div id="main-app">
    <div id="nav-container">
      <!-- Sessions List View -->
      <div id="sessions-view">
        <div class="view-header">
          <h1>Sessions</h1>
          <div class="view-header-actions">
            <button id="refresh-btn" title="Refresh">↻</button>
            <button id="new-btn" title="New Session">+</button>
          </div>
        </div>
        <div id="session-list"></div>
      </div>

      <!-- Session Detail View -->
      <div id="session-view">
        <div class="session-header">
          <button class="back-btn" id="back-btn">‹ Back</button>
          <span class="session-title" id="session-title">Session</span>
          <button class="start-btn" id="start-btn" style="display:none;">Start</button>
        </div>
        <div id="terminal-container">
          <div id="touch-overlay"></div>
          <div id="paste-indicator">Paste</div>
        </div>
        <div id="chat-container">
          <div id="chat-messages"></div>
          <div id="chat-input-container">
            <textarea id="chat-input" placeholder="Type a message..." rows="1"></textarea>
            <button id="chat-send">Send</button>
          </div>
        </div>
        <div id="status" class="disconnected">Disconnected</div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
    // Auth token management
    const TOKEN_KEY = 'agent_hub_token';
    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
    function clearToken() { localStorage.removeItem(TOKEN_KEY); }

    // Fetch with auth
    async function authFetch(url, options = {}) {
      const token = getToken();
      const headers = { ...options.headers };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(url, { ...options, headers });
      if (res.status === 401) {
        clearToken();
        showPairingScreen();
        throw new Error('Unauthorized');
      }
      return res;
    }

    // UI elements
    const pairingScreen = document.getElementById('pairing-screen');
    const mainApp = document.getElementById('main-app');
    const navContainer = document.getElementById('nav-container');
    const sessionList = document.getElementById('session-list');
    const sessionTitle = document.getElementById('session-title');
    const startBtn = document.getElementById('start-btn');
    const status = document.getElementById('status');
    let pairingId = null;

    function showPairingScreen() {
      pairingScreen.style.display = 'flex';
      mainApp.style.display = 'none';
    }

    function showMainApp() {
      pairingScreen.style.display = 'none';
      mainApp.style.display = 'block';
      initMainApp();
    }

    // Navigation functions
    function showSessionsList() {
      navContainer.classList.remove('show-session');
      if (ws) ws.close();
      history.replaceState(null, '', window.location.pathname);
    }

    function showSessionView(sessionId) {
      navContainer.classList.add('show-session');
      window.location.hash = sessionId;
      // Fit terminal after transition
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
      }, 350);
    }

    // Pairing flow
    async function requestPairing() {
      document.getElementById('pairing-status').textContent = 'Requesting pairing code...';
      try {
        const res = await fetch('/api/auth/request-pairing', { method: 'POST' });
        const data = await res.json();
        pairingId = data.pairing_id;
        document.getElementById('pairing-status').textContent = 'Enter the code shown on your desktop';
        document.getElementById('pairing-code').focus();
      } catch (e) {
        document.getElementById('pairing-error').textContent = 'Failed to request pairing';
      }
    }

    async function submitPairing() {
      const code = document.getElementById('pairing-code').value;
      const btn = document.getElementById('pairing-submit');
      const error = document.getElementById('pairing-error');

      if (!code || code.length !== 6) {
        error.textContent = 'Please enter a 6-digit code';
        return;
      }
      if (!pairingId) {
        error.textContent = 'No pairing request active';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Pairing...';
      error.textContent = '';

      try {
        const res = await fetch('/api/auth/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairing_id: pairingId, code, device_name: 'Mobile Browser' })
        });
        const data = await res.json();
        if (data.token) {
          setToken(data.token);
          showMainApp();
        } else {
          error.textContent = data.message || 'Pairing failed';
        }
      } catch (e) {
        error.textContent = 'Failed to pair';
      }
      btn.disabled = false;
      btn.textContent = 'Pair';
    }

    // Check auth on load
    async function checkAuth() {
      // First check if PIN is configured
      await checkPinStatus();

      if (!getToken()) {
        showPairingScreen();
        // Only auto-request pairing if PIN is not configured
        if (!pinConfigured) {
          requestPairing();
        }
        return;
      }

      try {
        const res = await fetch('/api/auth/check', {
          headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        const data = await res.json();
        if (data.authenticated) {
          showMainApp();
        } else {
          localStorage.removeItem('agent_hub_token');
          showPairingScreen();
          if (!pinConfigured) {
            requestPairing();
          }
        }
      } catch (e) {
        showPairingScreen();
        if (!pinConfigured) {
          requestPairing();
        }
      }
    }

    // PIN authentication
    let pinConfigured = false;

    async function checkPinStatus() {
      try {
        const res = await fetch('/api/auth/pin-status');
        const data = await res.json();
        pinConfigured = data.pin_configured;
        if (pinConfigured) {
          document.getElementById('auth-tabs').style.display = 'flex';
          document.getElementById('pin-auth').style.display = 'block';
          document.getElementById('pairing-auth').style.display = 'none';
        }
      } catch (e) {
        console.log('PIN status check failed');
      }
    }

    function switchAuthTab(tab) {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelector(`.auth-tab[data-tab="${tab}"]`).classList.add('active');

      if (tab === 'pin') {
        document.getElementById('pin-auth').style.display = 'block';
        document.getElementById('pairing-auth').style.display = 'none';
        document.getElementById('pin-input').focus();
      } else {
        document.getElementById('pin-auth').style.display = 'none';
        document.getElementById('pairing-auth').style.display = 'block';
        document.getElementById('pairing-code').focus();
        if (!pairingId) requestPairing();
      }
    }

    async function submitPin() {
      const pin = document.getElementById('pin-input').value;
      const btn = document.getElementById('pin-submit');
      const error = document.getElementById('pin-error');

      if (!pin) {
        error.textContent = 'Please enter your PIN';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Connecting...';
      error.textContent = '';

      try {
        const res = await fetch('/api/auth/pin-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin, device_name: 'Mobile Browser (PIN)' })
        });
        const data = await res.json();
        if (data.token) {
          setToken(data.token);
          showMainApp();
        } else {
          error.textContent = data.message || 'Invalid PIN';
        }
      } catch (e) {
        error.textContent = 'Failed to connect';
      }
      btn.disabled = false;
      btn.textContent = 'Connect';
    }

    // Auth tab event listeners
    document.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab));
    });

    // PIN event listeners
    document.getElementById('pin-submit').addEventListener('click', submitPin);
    document.getElementById('pin-input').addEventListener('keyup', (e) => {
      if (e.key === 'Enter') submitPin();
    });

    // Pairing event listeners
    document.getElementById('pairing-submit').addEventListener('click', submitPairing);
    document.getElementById('pairing-code').addEventListener('keyup', (e) => {
      if (e.key === 'Enter') submitPairing();
    });

    // Main app initialization
    let term, fitAddon;
    let ws = null;
    let sessionsData = [];
    let currentSessionId = null;
    let dataHandler = null;
    let resizeHandler = null;

    function initMainApp() {
      if (term) return;

      term = new Terminal({
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, monospace',
        theme: { background: '#1a1a1a', foreground: '#e6e6e6' },
        scrollback: 5000
      });
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(document.getElementById('terminal-container'));

      // Fix iOS keyboard input - enable autocorrect/autocomplete
      const textarea = document.querySelector('#terminal-container textarea');
      if (textarea) {
        textarea.setAttribute('autocomplete', 'on');
        textarea.setAttribute('autocorrect', 'on');
        textarea.setAttribute('autocapitalize', 'sentences');
        textarea.setAttribute('spellcheck', 'true');
      }

      // Mobile momentum scrolling
      setupMobileTouchScroll();

      // Long-press to paste handler
      const pasteIndicator = document.getElementById('paste-indicator');
      let longPressTimer = null;
      const LONG_PRESS_DURATION = 500; // ms

      async function doPaste() {
        try {
          const text = await navigator.clipboard.readText();
          if (text && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(text);
            // Brief feedback
            pasteIndicator.textContent = 'Pasted!';
            pasteIndicator.classList.add('visible');
            setTimeout(() => {
              pasteIndicator.classList.remove('visible');
              pasteIndicator.textContent = 'Paste';
            }, 500);
          }
        } catch (e) {
          console.error('Paste failed:', e);
          pasteIndicator.textContent = 'Paste failed';
          pasteIndicator.classList.add('visible');
          setTimeout(() => {
            pasteIndicator.classList.remove('visible');
            pasteIndicator.textContent = 'Paste';
          }, 1000);
        }
      }

      // Add long-press detection to touch overlay
      const overlay = document.getElementById('touch-overlay');
      overlay.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
          pasteIndicator.classList.add('visible');
          doPaste();
          longPressTimer = null;
        }, LONG_PRESS_DURATION);
      }, { passive: true });

      overlay.addEventListener('touchend', () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }, { passive: true });

      overlay.addEventListener('touchmove', () => {
        // Cancel long-press if user moves finger (scrolling)
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }, { passive: true });

      // Handle iOS keyboard resize using visualViewport
      if (window.visualViewport) {
        const sessionView = document.getElementById('session-view');
        window.visualViewport.addEventListener('resize', () => {
          if (navContainer.classList.contains('show-session')) {
            // Adjust height when keyboard appears/disappears
            const vh = window.visualViewport.height;
            sessionView.style.height = vh + 'px';
            fitAddon.fit();
            term.scrollToBottom();
          }
        });
        window.visualViewport.addEventListener('scroll', () => {
          // Prevent iOS from scrolling the page when keyboard opens
          window.scrollTo(0, 0);
        });
      }

      window.addEventListener('resize', () => {
        if (navContainer.classList.contains('show-session')) {
          fitAddon.fit();
        }
      });

      initSessionHandlers();
    }

    // Mobile touch scrolling with momentum
    // Uses a touch overlay to capture events before xterm.js
    function setupMobileTouchScroll() {
      const overlay = document.getElementById('touch-overlay');
      if (!overlay || !('ontouchstart' in window)) return;

      let touchStartY = 0, touchStartX = 0, lastTouchY = 0, lastTouchTime = 0;
      let velocity = 0, momentumId = null, isScrolling = false;
      let accumulatedScroll = 0;
      const velocitySamples = [];
      const friction = 0.94, minVelocity = 0.3;
      const SCROLL_THRESHOLD = 5; // Pixels before we decide it's a scroll vs tap

      function cancelMomentum() {
        if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
        velocity = 0;
        accumulatedScroll = 0;
      }

      function scrollByPixels(pixels) {
        if (!term) return;
        const lineHeight = 17; // Approximate, works well enough
        accumulatedScroll += pixels / lineHeight;
        const lines = Math.trunc(accumulatedScroll);
        if (lines !== 0) {
          term.scrollLines(lines);
          accumulatedScroll -= lines;
        }
      }

      overlay.addEventListener('touchstart', (e) => {
        cancelMomentum();
        const touch = e.touches[0];
        touchStartY = lastTouchY = touch.clientY;
        touchStartX = touch.clientX;
        lastTouchTime = performance.now();
        velocitySamples.length = 0;
        isScrolling = false;
      }, { passive: true });

      overlay.addEventListener('touchmove', (e) => {
        const touch = e.touches[0];
        const deltaY = lastTouchY - touch.clientY;
        const totalDeltaY = touchStartY - touch.clientY;
        const totalDeltaX = touchStartX - touch.clientX;
        const currentTime = performance.now();
        const deltaTime = currentTime - lastTouchTime;

        // Determine if this is a scroll gesture (vertical) vs something else
        if (!isScrolling && Math.abs(totalDeltaY) > SCROLL_THRESHOLD) {
          // More vertical than horizontal = scroll
          if (Math.abs(totalDeltaY) > Math.abs(totalDeltaX)) {
            isScrolling = true;
          }
        }

        if (isScrolling) {
          scrollByPixels(deltaY);
          e.preventDefault(); // Prevent page scroll

          if (deltaTime > 0) {
            velocitySamples.push({ dy: deltaY, dt: deltaTime });
            if (velocitySamples.length > 5) velocitySamples.shift();
          }
        }

        lastTouchY = touch.clientY;
        lastTouchTime = currentTime;
      }, { passive: false });

      overlay.addEventListener('touchend', (e) => {
        // If it was a tap (not a scroll), focus terminal for keyboard
        if (!isScrolling) {
          term?.focus();
        }

        if (!isScrolling) return;

        // Calculate momentum
        if (velocitySamples.length > 0) {
          let totalDy = 0, totalDt = 0;
          velocitySamples.forEach(s => { totalDy += s.dy; totalDt += s.dt; });
          velocity = totalDt > 0 ? (totalDy / totalDt) * 16 : 0;
        }

        if (Math.abs(velocity) > minVelocity) {
          function animate() {
            if (Math.abs(velocity) < minVelocity) { cancelMomentum(); return; }
            scrollByPixels(velocity);
            velocity *= friction;
            momentumId = requestAnimationFrame(animate);
          }
          momentumId = requestAnimationFrame(animate);
        }

        isScrolling = false;
      }, { passive: true });

      console.log('Touch overlay scroll initialized');
    }

    function initSessionHandlers() {
      // Render sessions list
      function renderSessionsList() {
        if (sessionsData.length === 0) {
          sessionList.innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">⌘</div>
              <h2>No Sessions</h2>
              <p>Tap + to create your first session</p>
            </div>
          `;
          return;
        }

        sessionList.innerHTML = sessionsData.map(s => `
          <div class="session-item" data-id="${s.id}">
            <div class="session-status ${s.running ? 'running' : 'stopped'}"></div>
            <div class="session-info">
              <div class="session-name">${escapeHtml(s.name)}</div>
              <div class="session-meta">${s.agent_type}${s.working_dir ? ' • ' + s.working_dir : ''}</div>
            </div>
            <span class="session-chevron">›</span>
          </div>
        `).join('');

        // Add click handlers
        sessionList.querySelectorAll('.session-item').forEach(item => {
          item.addEventListener('click', () => openSession(item.dataset.id));
        });
      }

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      async function loadSessions() {
        try {
          const res = await authFetch('/api/sessions');
          sessionsData = await res.json();
          renderSessionsList();
        } catch (e) {
          console.error('Failed to load sessions', e);
        }
      }

      // Check if session uses JSON chat interface
      function isJsonSession(session) {
        return session.agent_type === 'claude-json';
      }

      async function openSession(sessionId, autoStart = false) {
        currentSessionId = sessionId;
        const session = sessionsData.find(s => s.id === sessionId);
        if (!session) return;

        sessionTitle.textContent = session.name;
        showSessionView(sessionId);

        // Toggle between terminal and chat UI based on session type
        const terminalContainer = document.getElementById('terminal-container');
        const chatContainer = document.getElementById('chat-container');

        if (isJsonSession(session)) {
          terminalContainer.style.display = 'none';
          chatContainer.classList.add('active');
          if (session.running) {
            startBtn.style.display = 'none';
            connectChatWebSocket(sessionId);
          } else if (autoStart) {
            startBtn.style.display = 'none';
            await startCurrentSession();
          } else {
            startBtn.style.display = 'inline-block';
            await loadChatHistory(sessionId);
          }
        } else {
          chatContainer.classList.remove('active');
          terminalContainer.style.display = 'block';
          if (session.running) {
            startBtn.style.display = 'none';
            connectWebSocket(sessionId);
          } else if (autoStart) {
            startBtn.style.display = 'none';
            await startCurrentSession();
          } else {
            startBtn.style.display = 'inline-block';
            await showBuffer(sessionId);
          }
        }
      }

      async function showBuffer(sessionId) {
        term.clear();
        status.textContent = 'Loading history...';
        status.className = 'disconnected';
        try {
          const res = await authFetch(`/api/sessions/${sessionId}/buffer`);
          const data = await res.json();
          if (data.buffer) {
            term.write(data.buffer);
            term.scrollToBottom(); // Scroll to latest content
            status.textContent = 'Viewing saved history (tap Start to resume)';
          } else {
            status.textContent = 'No history - tap Start to begin';
          }
        } catch (e) {
          status.textContent = 'Failed to load history';
        }
      }

      function connectWebSocket(sessionId) {
        if (ws) ws.close();
        if (dataHandler) dataHandler.dispose();
        if (resizeHandler) resizeHandler.dispose();

        term.clear();
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${location.host}/api/ws/${sessionId}`);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          status.textContent = 'Connected';
          status.className = 'connected';
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        };
        ws.onclose = () => {
          status.textContent = 'Disconnected';
          status.className = 'disconnected';
        };
        ws.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(e.data));
            // Auto-scroll to bottom on new output
            term.scrollToBottom();
          }
        };

        dataHandler = term.onData(data => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        });

        resizeHandler = term.onResize(({ cols, rows }) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        });
      }

      // Chat functions for JSON sessions
      const chatMessages = document.getElementById('chat-messages');
      const chatInput = document.getElementById('chat-input');
      const chatSend = document.getElementById('chat-send');
      let chatWs = null;
      let isProcessing = false;

      async function loadChatHistory(sessionId) {
        chatMessages.innerHTML = '';
        status.textContent = 'Loading chat history...';
        status.className = 'disconnected';
        try {
          const res = await authFetch(`/api/sessions/${sessionId}/buffer`);
          const data = await res.json();
          if (data.buffer) {
            try {
              const messages = JSON.parse(data.buffer);
              messages.forEach(msg => renderChatMessage(msg));
              chatMessages.scrollTop = chatMessages.scrollHeight;
              status.textContent = 'Viewing chat history (tap Start to resume)';
            } catch (e) {
              status.textContent = 'Chat history format error';
            }
          } else {
            status.textContent = 'No chat history - tap Start to begin';
          }
        } catch (e) {
          status.textContent = 'Failed to load chat history';
        }
      }

      function connectChatWebSocket(sessionId) {
        if (chatWs) chatWs.close();
        chatMessages.innerHTML = '';

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        chatWs = new WebSocket(`${protocol}//${location.host}/api/ws/${sessionId}`);

        chatWs.onopen = () => {
          status.textContent = 'Connected';
          status.className = 'connected';
          chatSend.disabled = false;
        };
        chatWs.onclose = () => {
          status.textContent = 'Disconnected';
          status.className = 'disconnected';
          isProcessing = false;
          chatSend.disabled = false;
        };
        chatWs.onmessage = (e) => {
          if (typeof e.data === 'string') {
            try {
              const msg = JSON.parse(e.data);
              renderChatMessage(msg);
              chatMessages.scrollTop = chatMessages.scrollHeight;
              if (msg.type === 'result') {
                isProcessing = false;
                chatSend.disabled = false;
                status.textContent = 'Done';
                status.className = 'connected';
              }
            } catch (err) {
              console.warn('Failed to parse message:', e.data);
            }
          }
        };
      }

      function renderChatMessage(msg) {
        const div = document.createElement('div');
        div.className = 'chat-msg';

        if (msg.type === 'user') {
          if (!msg.result?.trim()) return; // Skip empty
          div.classList.add('user');
          div.textContent = msg.result;
        } else if (msg.type === 'assistant' && msg.message?.content) {
          div.classList.add('assistant');
          let html = '';
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              // Simple markdown: code blocks, inline code, bold
              let text = escapeHtml(block.text);
              // Code blocks
              text = text.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
              // Inline code
              text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
              // Bold
              text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
              // Paragraphs
              text = text.split('\n\n').map(p => '<p>' + p + '</p>').join('');
              html += text;
            } else if (block.type === 'tool_use') {
              div.classList.remove('assistant');
              div.classList.add('tool-use');
              html += '<strong>' + escapeHtml(block.name || 'Tool') + '</strong>';
              if (block.input) {
                html += '<pre><code>' + escapeHtml(JSON.stringify(block.input, null, 2)) + '</code></pre>';
              }
            }
          }
          div.innerHTML = html || '(empty)';
        } else if (msg.type === 'system' && msg.subtype === 'init') {
          div.classList.add('system');
          div.textContent = 'Session started • ' + (msg.model || 'Claude');
        } else if (msg.type === 'result' && msg.is_error) {
          div.classList.add('system');
          div.style.color = '#f14c4c';
          div.textContent = 'Error: ' + msg.result;
        } else {
          return; // Skip other types
        }
        chatMessages.appendChild(div);
      }

      function sendChatMessage() {
        const text = chatInput.value.trim();
        if (!text || isProcessing || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;

        // Show user message
        renderChatMessage({ type: 'user', result: text });
        chatMessages.scrollTop = chatMessages.scrollHeight;
        chatInput.value = '';

        // Send to server
        isProcessing = true;
        chatSend.disabled = true;
        status.textContent = 'Thinking...';
        status.className = '';

        const jsonMsg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: text }
        }) + '\n';
        chatWs.send(jsonMsg);
      }

      chatSend.addEventListener('click', sendChatMessage);
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });

      async function startCurrentSession() {
        if (!currentSessionId) return;
        const session = sessionsData.find(s => s.id === currentSessionId);
        if (!session) return;

        startBtn.disabled = true;
        startBtn.textContent = 'Starting...';
        try {
          const res = await authFetch(`/api/sessions/${currentSessionId}/start`, { method: 'POST' });
          const data = await res.json();
          if (data.status === 'started' || data.status === 'already_running') {
            await loadSessions();
            startBtn.style.display = 'none';
            // Use appropriate connection for session type
            if (isJsonSession(session)) {
              connectChatWebSocket(currentSessionId);
            } else {
              connectWebSocket(currentSessionId);
            }
          } else {
            status.textContent = 'Failed to start session';
          }
        } catch (e) {
          status.textContent = 'Failed to start session';
        }
        startBtn.disabled = false;
        startBtn.textContent = 'Start';
      }

      // Event listeners
      document.getElementById('back-btn').addEventListener('click', () => {
        showSessionsList();
        loadSessions(); // Refresh list when going back
      });

      startBtn.addEventListener('click', startCurrentSession);
      document.getElementById('refresh-btn').addEventListener('click', loadSessions);

      // Handle browser back button
      window.addEventListener('popstate', () => {
        if (!window.location.hash) {
          showSessionsList();
        }
      });

      // New Session Modal handlers
      const newSessionModal = document.getElementById('new-session-modal');
      const newSessionName = document.getElementById('new-session-name');
      const newSessionAgent = document.getElementById('new-session-agent');
      const newSessionCommand = document.getElementById('new-session-command');
      const newSessionDir = document.getElementById('new-session-dir');
      const customCommandGroup = document.getElementById('custom-command-group');
      const newSessionError = document.getElementById('new-session-error');
      const newSessionCreate = document.getElementById('new-session-create');

      newSessionAgent.addEventListener('change', () => {
        customCommandGroup.style.display = newSessionAgent.value === 'custom' ? 'block' : 'none';
      });

      document.getElementById('new-btn').addEventListener('click', () => {
        newSessionModal.classList.add('visible');
        newSessionName.value = '';
        newSessionAgent.value = 'claude';
        newSessionCommand.value = '';
        newSessionDir.value = '';
        newSessionError.textContent = '';
        customCommandGroup.style.display = 'none';
        setTimeout(() => newSessionName.focus(), 100);
      });

      document.getElementById('new-session-cancel').addEventListener('click', () => {
        newSessionModal.classList.remove('visible');
      });
      newSessionModal.addEventListener('click', (e) => {
        if (e.target === newSessionModal) newSessionModal.classList.remove('visible');
      });

      async function createNewSession() {
        const name = newSessionName.value.trim();
        const agentType = newSessionAgent.value;
        const customCommand = newSessionCommand.value.trim();
        const workingDir = newSessionDir.value.trim() || '~/dev/pplsi';

        newSessionCreate.disabled = true;
        newSessionCreate.textContent = 'Creating...';
        newSessionError.textContent = '';

        try {
          const res = await authFetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: name || null,
              agent_type: agentType,
              custom_command: agentType === 'custom' ? customCommand : null,
              working_dir: workingDir
            })
          });
          const data = await res.json();
          if (data.id) {
            newSessionModal.classList.remove('visible');
            await loadSessions();
            // Open and auto-start the new session
            openSession(data.id, true);
          } else {
            newSessionError.textContent = data.error || 'Failed to create session';
          }
        } catch (e) {
          newSessionError.textContent = 'Failed to create session';
        }
        newSessionCreate.disabled = false;
        newSessionCreate.textContent = 'Create';
      }

      newSessionCreate.addEventListener('click', createNewSession);

      // Load sessions and check for deep link
      loadSessions().then(() => {
        const sessionId = window.location.hash.slice(1);
        if (sessionId) {
          openSession(sessionId);
        }
      });
    }

    // Start auth check
    checkAuth();
  </script>
</body>
</html>"#;

// GET / - Serve mobile web client
async fn web_index() -> impl IntoResponse {
    let html = MOBILE_HTML.replace("{{APP_NAME}}", APP_NAME);
    axum::response::Html(html)
}

// Extract auth token from request headers
fn extract_token(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

// Check auth and return error response if not authorized
fn check_auth(headers: &axum::http::HeaderMap) -> Option<impl IntoResponse> {
    let devices = PAIRED_DEVICES.lock();
    if devices.is_empty() {
        // No devices paired yet - allow access (first-time setup)
        return None;
    }
    drop(devices);

    match extract_token(headers) {
        Some(token) if is_valid_token(&token) => None,
        _ => Some((StatusCode::UNAUTHORIZED, Json(serde_json::json!({
            "error": "unauthorized",
            "message": "Device not paired. Request pairing first."
        })))),
    }
}

// POST /api/auth/request-pairing - Request a new pairing code
async fn api_request_pairing(
    _headers: axum::http::HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> impl IntoResponse {
    let device_name = body
        .and_then(|b| b.get("device_name").and_then(|v| v.as_str()).map(|s| s.to_string()));

    let pairing_id = generate_token();
    let code = generate_pairing_code();

    // Store pairing request
    {
        let mut requests = PAIRING_REQUESTS.lock();
        requests.insert(pairing_id.clone(), PairingRequest {
            code: code.clone(),
            created_at: chrono::Utc::now(),
            device_name: device_name.clone(),
        });
    }

    // Log the pairing code for debugging
    println!("🔑 Pairing code requested: {} (device: {:?})", code, device_name);

    // Notify desktop app to show the code
    if let Some(app) = APP_HANDLE.lock().as_ref() {
        let _ = app.emit("pairing-requested", serde_json::json!({
            "pairing_id": pairing_id,
            "code": code,
            "device_name": device_name,
        }));
    }

    Json(serde_json::json!({
        "pairing_id": pairing_id,
        "expires_in": 300  // 5 minutes
    }))
}

// POST /api/auth/pair - Complete pairing with code
async fn api_pair(
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let pairing_id = body.get("pairing_id").and_then(|v| v.as_str());
    let code = body.get("code").and_then(|v| v.as_str());
    let device_name = body.get("device_name").and_then(|v| v.as_str()).unwrap_or("Mobile Device");

    let (pairing_id, code) = match (pairing_id, code) {
        (Some(p), Some(c)) => (p, c),
        _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "missing_fields",
            "message": "pairing_id and code are required"
        }))).into_response(),
    };

    // Verify the code
    let valid = {
        let requests = PAIRING_REQUESTS.lock();
        if let Some(request) = requests.get(pairing_id) {
            // Check code matches and hasn't expired (5 min)
            let age = chrono::Utc::now() - request.created_at;
            request.code == code && age.num_seconds() < 300
        } else {
            false
        }
    };

    if !valid {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({
            "error": "invalid_code",
            "message": "Invalid or expired pairing code"
        }))).into_response();
    }

    // Remove the pairing request
    {
        let mut requests = PAIRING_REQUESTS.lock();
        requests.remove(pairing_id);
    }

    // Generate token and store device
    let token = generate_token();
    let device_id = generate_token();
    let now = chrono::Utc::now().to_rfc3339();

    let device = PairedDevice {
        id: device_id,
        name: device_name.to_string(),
        paired_at: now.clone(),
        last_seen: now,
    };

    // Store in memory and database
    {
        let mut devices = PAIRED_DEVICES.lock();
        devices.insert(token.clone(), device.clone());
    }
    let _ = save_paired_device(&token, &device);

    // Notify desktop
    if let Some(app) = APP_HANDLE.lock().as_ref() {
        let _ = app.emit("device-paired", serde_json::json!({
            "device": device,
        }));
    }

    Json(serde_json::json!({
        "token": token,
        "device_id": device.id
    })).into_response()
}

// GET /api/auth/pin-status - Check if PIN authentication is available
async fn api_pin_status() -> impl IntoResponse {
    let settings = load_app_settings().unwrap_or_default();
    let pin_configured = settings.remote_pin.is_some();

    Json(serde_json::json!({
        "pin_configured": pin_configured
    }))
}

// POST /api/auth/pin-login - Authenticate with PIN
async fn api_pin_login(
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<SocketAddr>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let client_ip = addr.ip().to_string();

    // Rate limiting: 5 attempts per 15 minutes
    {
        let mut rate_limits = PIN_RATE_LIMIT.lock();
        if let Some((attempts, last_time)) = rate_limits.get(&client_ip) {
            let elapsed = last_time.elapsed();
            if elapsed < std::time::Duration::from_secs(900) && *attempts >= 5 {
                let remaining = 900 - elapsed.as_secs();
                return (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({
                    "error": "rate_limited",
                    "message": format!("Too many attempts. Try again in {} minutes.", remaining / 60 + 1)
                }))).into_response();
            }
            // Reset if 15 minutes have passed
            if elapsed >= std::time::Duration::from_secs(900) {
                rate_limits.remove(&client_ip);
            }
        }
    }

    let pin = match body.get("pin").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "missing_pin",
            "message": "PIN is required"
        }))).into_response(),
    };

    let device_name = body.get("device_name").and_then(|v| v.as_str()).unwrap_or("Mobile Device (PIN)");

    // Load settings and check PIN
    let settings = load_app_settings().unwrap_or_default();
    let valid = match &settings.remote_pin {
        Some(configured_pin) => configured_pin == pin,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "pin_not_configured",
            "message": "PIN authentication is not configured"
        }))).into_response(),
    };

    if !valid {
        // Record failed attempt
        {
            let mut rate_limits = PIN_RATE_LIMIT.lock();
            let entry = rate_limits.entry(client_ip).or_insert((0, std::time::Instant::now()));
            entry.0 += 1;
            entry.1 = std::time::Instant::now();
        }

        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({
            "error": "invalid_pin",
            "message": "Invalid PIN"
        }))).into_response();
    }

    // Clear rate limit on success
    {
        let mut rate_limits = PIN_RATE_LIMIT.lock();
        rate_limits.remove(&addr.ip().to_string());
    }

    // Generate token and store device
    let token = generate_token();
    let device_id = generate_token();
    let now = chrono::Utc::now().to_rfc3339();

    let device = PairedDevice {
        id: device_id,
        name: device_name.to_string(),
        paired_at: now.clone(),
        last_seen: now,
    };

    // Store in memory and database
    {
        let mut devices = PAIRED_DEVICES.lock();
        devices.insert(token.clone(), device.clone());
    }
    let _ = save_paired_device(&token, &device);

    // Notify desktop
    if let Some(app) = APP_HANDLE.lock().as_ref() {
        let _ = app.emit("device-paired", serde_json::json!({
            "device": device,
            "method": "pin"
        }));
    }

    Json(serde_json::json!({
        "token": token,
        "device_id": device.id
    })).into_response()
}

// GET /api/auth/check - Check if current token is valid
async fn api_auth_check(
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let devices = PAIRED_DEVICES.lock();
    if devices.is_empty() {
        // No devices paired - no auth required
        return Json(serde_json::json!({
            "authenticated": true,
            "reason": "no_devices_paired"
        })).into_response();
    }
    drop(devices);

    match extract_token(&headers) {
        Some(token) if is_valid_token(&token) => {
            Json(serde_json::json!({ "authenticated": true })).into_response()
        }
        _ => {
            (StatusCode::UNAUTHORIZED, Json(serde_json::json!({
                "authenticated": false,
                "reason": "invalid_token"
            }))).into_response()
        }
    }
}

// GET /api/sessions - List all sessions with running status
#[cfg(not(target_os = "ios"))]
async fn api_list_sessions(headers: axum::http::HeaderMap) -> impl IntoResponse {
    if let Some(err) = check_auth(&headers) {
        return err.into_response();
    }
    match load_sessions() {
        Ok(sessions) => {
            let running_ids: std::collections::HashSet<String> = {
                let broadcasters = PTY_BROADCASTERS.lock();
                broadcasters.keys().cloned().collect()
            };

            // Add running status to each session
            let sessions_with_status: Vec<serde_json::Value> = sessions.into_iter().map(|s| {
                let is_running = running_ids.contains(&s.id);
                serde_json::json!({
                    "id": s.id,
                    "name": s.name,
                    "agent_type": s.agent_type,
                    "command": s.command,
                    "working_dir": s.working_dir,
                    "created_at": s.created_at,
                    "claude_session_id": s.claude_session_id,
                    "sort_order": s.sort_order,
                    "running": is_running
                })
            }).collect();

            Json(sessions_with_status).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// iOS version - no PTY running status
#[cfg(target_os = "ios")]
async fn api_list_sessions(headers: axum::http::HeaderMap) -> impl IntoResponse {
    if let Some(err) = check_auth(&headers) {
        return err.into_response();
    }
    match load_sessions() {
        Ok(sessions) => {
            // On iOS, sessions are never running locally
            let sessions_with_status: Vec<serde_json::Value> = sessions.into_iter().map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "name": s.name,
                    "agent_type": s.agent_type,
                    "command": s.command,
                    "working_dir": s.working_dir,
                    "created_at": s.created_at,
                    "claude_session_id": s.claude_session_id,
                    "sort_order": s.sort_order,
                    "running": false
                })
            }).collect();

            Json(sessions_with_status).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// POST /api/sessions - Create a new session
async fn api_create_session(
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Some(err) = check_auth(&headers) {
        return err.into_response();
    }

    let name = body.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
    let agent_type = body.get("agent_type").and_then(|v| v.as_str()).unwrap_or("claude");
    let custom_command = body.get("custom_command").and_then(|v| v.as_str()).map(|s| s.to_string());
    let working_dir = body.get("working_dir").and_then(|v| v.as_str()).unwrap_or("~/dev/pplsi");

    // Generate session ID
    let session_id = generate_token();

    // Determine command based on agent type
    let command = match agent_type {
        "claude" => "claude --dangerously-skip-permissions".to_string(),
        "claude-json" => "claude --print --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions".to_string(),
        "aider" => "aider".to_string(),
        "shell" => std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()),
        "custom" => custom_command.clone().unwrap_or_else(|| "/bin/zsh".to_string()),
        _ => "claude --dangerously-skip-permissions".to_string(),
    };

    // Generate auto-name if not provided
    let session_name = name.unwrap_or_else(|| {
        // Get count of existing sessions for auto-numbering
        let count = load_sessions().map(|s| s.len()).unwrap_or(0);
        let agent_label = match agent_type {
            "claude" => "Claude",
            "claude-json" => "Claude Chat",
            "aider" => "Aider",
            "shell" => "Shell",
            "custom" => "Custom",
            _ => "Session",
        };
        format!("{} {}", agent_label, count + 1)
    });

    // Don't pre-generate claude_session_id - it will be captured from Claude's output
    // when the session is first started. Only existing sessions with saved IDs should resume.
    let claude_session_id: Option<String> = None;

    // Calculate sort order (put new sessions at top)
    let min_sort_order = load_sessions()
        .map(|sessions| sessions.iter().map(|s| s.sort_order).min().unwrap_or(0))
        .unwrap_or(0);

    let session = SessionData {
        id: session_id.clone(),
        name: session_name,
        agent_type: agent_type.to_string(),
        command,
        working_dir: working_dir.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        claude_session_id,
        sort_order: min_sort_order - 1,
    };

    // Save to database
    if let Err(e) = save_session(session.clone()) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "error": e
        }))).into_response();
    }

    // Notify desktop app about new session
    if let Some(app) = APP_HANDLE.lock().as_ref() {
        let _ = app.emit("remote-session-created", serde_json::json!({
            "session": {
                "id": session.id,
                "name": session.name,
                "agent_type": session.agent_type,
                "working_dir": session.working_dir,
            }
        }));
    }

    Json(serde_json::json!({
        "id": session.id,
        "name": session.name,
        "agent_type": session.agent_type,
        "command": session.command,
        "working_dir": session.working_dir,
        "running": false
    })).into_response()
}

// GET /api/sessions/{id}/buffer - Get saved terminal buffer for a session
async fn api_get_buffer(
    headers: axum::http::HeaderMap,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    if let Some(err) = check_auth(&headers) {
        return err.into_response();
    }
    match load_terminal_buffer(session_id) {
        Ok(Some(buffer)) => Json(serde_json::json!({ "buffer": buffer })).into_response(),
        Ok(None) => Json(serde_json::json!({ "buffer": null })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// POST /api/sessions/{id}/start - Start a session remotely
#[cfg(not(target_os = "ios"))]
async fn api_start_session(
    headers: axum::http::HeaderMap,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    if let Some(err) = check_auth(&headers) {
        return err.into_response();
    }
    // Check if already running (PTY or JSON)
    {
        let pty_broadcasters = PTY_BROADCASTERS.lock();
        if pty_broadcasters.contains_key(&session_id) {
            return Json(serde_json::json!({ "status": "already_running" })).into_response();
        }
    }
    {
        let json_broadcasters = JSON_BROADCASTERS.lock();
        if json_broadcasters.contains_key(&session_id) {
            return Json(serde_json::json!({ "status": "already_running" })).into_response();
        }
    }

    // Get session from database
    let session = match load_sessions() {
        Ok(sessions) => sessions.into_iter().find(|s| s.id == session_id),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };

    let Some(session) = session else {
        return (StatusCode::NOT_FOUND, "Session not found").into_response();
    };

    // Get AppHandle
    let app = {
        let handle = APP_HANDLE.lock();
        handle.clone()
    };

    let Some(app) = app else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "App not initialized").into_response();
    };

    // Check if this is a JSON session (claude-json)
    let is_json_session = session.agent_type == "claude-json";

    if is_json_session {
        // Check if JSON process already running
        {
            let broadcasters = JSON_BROADCASTERS.lock();
            if broadcasters.contains_key(&session_id) {
                return Json(serde_json::json!({ "status": "already_running" })).into_response();
            }
        }

        // Spawn JSON process for chat sessions
        let should_resume = session.claude_session_id.is_some();
        match spawn_json_process(
            app.clone(),
            session.id.clone(),
            session.command,
            Some(session.working_dir),
            session.claude_session_id,
            Some(should_resume),
        ) {
            Ok(()) => {
                let _ = app.emit("remote-session-started", session.id.clone());
                Json(serde_json::json!({ "status": "started", "session_id": session.id })).into_response()
            }
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        }
    } else {
        // Spawn PTY for terminal sessions (use default terminal size, will be resized on connect)
        let should_resume = session.claude_session_id.is_some();
        match spawn_pty(
            app.clone(),
            session.id.clone(),
            Some(session.command),
            Some(session.working_dir),
            120,  // default cols
            30,   // default rows
            session.claude_session_id,
            Some(should_resume),
        ) {
            Ok(()) => {
                // Notify desktop app that session was started remotely
                let _ = app.emit("remote-session-started", session.id.clone());
                Json(serde_json::json!({ "status": "started", "session_id": session.id })).into_response()
            }
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        }
    }
}

// iOS version - cannot start PTY sessions locally
#[cfg(target_os = "ios")]
async fn api_start_session(
    headers: axum::http::HeaderMap,
    Path(_session_id): Path<String>,
) -> impl IntoResponse {
    if let Some(err) = check_auth(&headers) {
        return err.into_response();
    }
    (StatusCode::NOT_IMPLEMENTED, Json(serde_json::json!({
        "error": "not_supported",
        "message": "PTY sessions cannot be started on iOS. Connect to a desktop Agent Hub instance."
    }))).into_response()
}

// POST /api/mcp/execute - Execute JS in the webview and return result
// This allows external MCP bridges to control the UI via HTTP
#[cfg(not(target_os = "ios"))]
async fn api_mcp_execute(
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let code = match body.get("code").and_then(|v| v.as_str()) {
        Some(c) => c.to_string(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "missing_code",
            "message": "Request body must contain 'code' field with JS to execute"
        }))).into_response(),
    };

    let timeout_ms = body.get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);

    // Generate unique request ID
    let request_id = uuid::Uuid::new_v4().to_string();

    // Register the pending request
    {
        let mut results = MCP_HTTP_RESULTS.lock();
        results.insert(request_id.clone(), None);
    }

    // Emit event to frontend to execute the JS
    let app_opt = APP_HANDLE.lock().clone();
    if let Some(app) = app_opt {
        let _ = app.emit("mcp-execute", serde_json::json!({
            "request_id": request_id,
            "code": code
        }));
    } else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
            "error": "app_not_ready",
            "message": "App handle not available"
        }))).into_response();
    }

    // Poll for result with timeout
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);

    loop {
        {
            let mut results = MCP_HTTP_RESULTS.lock();
            if let Some(result_opt) = results.get(&request_id) {
                if let Some(result) = result_opt {
                    let result = result.clone();
                    results.remove(&request_id);
                    return Json(serde_json::json!({
                        "success": true,
                        "result": result
                    })).into_response();
                }
            }
        }

        if start.elapsed() > timeout {
            // Clean up and return timeout
            let mut results = MCP_HTTP_RESULTS.lock();
            results.remove(&request_id);
            return (StatusCode::GATEWAY_TIMEOUT, Json(serde_json::json!({
                "error": "timeout",
                "message": format!("JS execution timed out after {}ms", timeout_ms)
            }))).into_response();
        }

        // Sleep briefly before polling again
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

// POST /api/mcp/result - Frontend calls this to return JS execution result
#[cfg(not(target_os = "ios"))]
async fn api_mcp_result(
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let request_id = match body.get("request_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return (StatusCode::BAD_REQUEST, "missing request_id").into_response(),
    };

    let result = body.get("result")
        .map(|v| if v.is_string() { v.as_str().unwrap().to_string() } else { v.to_string() })
        .unwrap_or_else(|| "null".to_string());

    let mut results = MCP_HTTP_RESULTS.lock();
    if results.contains_key(&request_id) {
        results.insert(request_id, Some(result));
        Json(serde_json::json!({ "success": true })).into_response()
    } else {
        (StatusCode::NOT_FOUND, "request not found").into_response()
    }
}

// WebSocket handler for PTY and JSON streaming
#[cfg(not(target_os = "ios"))]
async fn ws_handler(
    Path(session_id): Path<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, session_id))
}

#[cfg(not(target_os = "ios"))]
async fn handle_ws(socket: WebSocket, session_id: String) {
    let (mut sender, mut receiver) = socket.split();
    let session_id_clone = session_id.clone();

    // Check if this is a JSON session or PTY session
    let is_json_session = {
        let processes = JSON_PROCESSES.lock();
        processes.contains_key(&session_id)
    };

    if is_json_session {
        // Handle JSON session
        let rx = {
            let broadcasters = JSON_BROADCASTERS.lock();
            broadcasters.get(&session_id).map(|tx| tx.subscribe())
        };

        let Some(mut rx) = rx else {
            let _ = sender.send(Message::Text("JSON session not found or not running".into())).await;
            return;
        };

        // Spawn task to forward JSON output to WebSocket
        let send_task = tokio::spawn(async move {
            while let Ok(data) = rx.recv().await {
                if sender.send(Message::Text(data)).await.is_err() {
                    break;
                }
            }
        });

        // Handle incoming messages from WebSocket (user input for JSON process)
        let recv_task = tokio::spawn(async move {
            while let Some(Ok(msg)) = receiver.next().await {
                match msg {
                    Message::Text(text) => {
                        // For JSON sessions, forward text directly to stdin
                        let _ = write_to_process(session_id_clone.clone(), text);
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

        tokio::select! {
            _ = send_task => {},
            _ = recv_task => {},
        }
    } else {
        // Handle PTY session (existing logic)
        let rx = {
            let broadcasters = PTY_BROADCASTERS.lock();
            broadcasters.get(&session_id).map(|tx| tx.subscribe())
        };

        let Some(mut rx) = rx else {
            let _ = sender.send(Message::Text("Session not found or not running".into())).await;
            return;
        };

        // Spawn task to forward PTY output to WebSocket
        let send_task = tokio::spawn(async move {
            while let Ok(data) = rx.recv().await {
                if sender.send(Message::Binary(data)).await.is_err() {
                    break;
                }
            }
        });

        // Handle incoming messages from WebSocket (user input)
        let recv_task = tokio::spawn(async move {
            while let Some(Ok(msg)) = receiver.next().await {
                match msg {
                    Message::Text(text) => {
                        // Check if it's a control message (JSON)
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                            if json.get("type").and_then(|v| v.as_str()) == Some("resize") {
                                if let (Some(cols), Some(rows)) = (
                                    json.get("cols").and_then(|v| v.as_u64()),
                                    json.get("rows").and_then(|v| v.as_u64()),
                                ) {
                                    let _ = resize_pty(session_id_clone.clone(), cols as u16, rows as u16);
                                }
                            }
                        } else {
                            // Regular text input
                            let _ = write_pty(session_id_clone.clone(), text);
                        }
                    }
                    Message::Binary(data) => {
                        if let Ok(text) = String::from_utf8(data) {
                            let _ = write_pty(session_id_clone.clone(), text);
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

        // Wait for either task to finish
        tokio::select! {
            _ = send_task => {},
            _ = recv_task => {},
        }
    }

    // Mobile client disconnected - notify desktop to restore its size
    if let Some(app) = APP_HANDLE.lock().as_ref() {
        let _ = app.emit("remote-client-disconnected", session_id);
    }
}

// iOS stub - WebSocket not supported without PTY
#[cfg(target_os = "ios")]
async fn ws_handler(
    Path(_session_id): Path<String>,
    _ws: WebSocketUpgrade,
) -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "WebSocket PTY streaming not supported on iOS")
}

#[cfg(not(target_os = "ios"))]
fn start_web_server() {
    // Load paired devices from database
    load_paired_devices();

    // Spawn web server in a dedicated thread with its own tokio runtime
    // This avoids issues with Tauri's runtime not being ready during setup
    thread::spawn(|| {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime for web server");
        rt.block_on(async {
            let app = Router::new()
                .route("/", get(web_index))
                // Auth endpoints (no auth required)
                .route("/api/auth/check", get(api_auth_check))
                .route("/api/auth/request-pairing", axum::routing::post(api_request_pairing))
                .route("/api/auth/pair", axum::routing::post(api_pair))
                .route("/api/auth/pin-status", get(api_pin_status))
                .route("/api/auth/pin-login", axum::routing::post(api_pin_login))
                // Protected endpoints
                .route("/api/sessions", get(api_list_sessions).post(api_create_session))
                .route("/api/sessions/:session_id/buffer", get(api_get_buffer))
                .route("/api/sessions/:session_id/start", axum::routing::post(api_start_session))
                .route("/api/ws/:session_id", get(ws_handler))
                // MCP HTTP endpoints for external control
                .route("/api/mcp/execute", axum::routing::post(api_mcp_execute))
                .route("/api/mcp/result", axum::routing::post(api_mcp_result))
                .layer(CorsLayer::permissive());

            // Try ports starting from WEB_PORT_BASE until we find one available
            let mut listener = None;
            let mut bound_port = WEB_PORT_BASE;

            for port_offset in 0..WEB_PORT_MAX_ATTEMPTS {
                let port = WEB_PORT_BASE + port_offset;
                let addr = SocketAddr::from(([0, 0, 0, 0], port));

                match tokio::net::TcpListener::bind(addr).await {
                    Ok(l) => {
                        bound_port = port;
                        listener = Some(l);
                        break;
                    }
                    Err(e) => {
                        println!("Port {} unavailable ({}), trying next...", port, e);
                    }
                }
            }

            let listener = listener.expect(&format!(
                "Failed to bind to any port in range {}-{}",
                WEB_PORT_BASE,
                WEB_PORT_BASE + WEB_PORT_MAX_ATTEMPTS - 1
            ));

            // Store the bound port for other parts of the app to access
            {
                let mut port_guard = WEB_SERVER_PORT.lock();
                *port_guard = Some(bound_port);
            }

            // Notify the app about the bound port
            if let Some(app) = APP_HANDLE.lock().as_ref() {
                let _ = app.emit("web-server-started", serde_json::json!({
                    "port": bound_port
                }));
            }

            println!("Web server listening on http://0.0.0.0:{}", bound_port);
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
        });
    });
}

// iOS version of web server - same functionality but no PTY routes will work
// The iOS app is intended to be a remote client connecting to a desktop instance,
// but we still run the server for potential local testing/development
#[cfg(target_os = "ios")]
fn start_web_server() {
    // Load paired devices from database
    load_paired_devices();

    // Spawn web server in a dedicated thread with its own tokio runtime
    thread::spawn(|| {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime for web server");
        rt.block_on(async {
            let app = Router::new()
                .route("/", get(web_index))
                // Auth endpoints (no auth required)
                .route("/api/auth/check", get(api_auth_check))
                .route("/api/auth/request-pairing", axum::routing::post(api_request_pairing))
                .route("/api/auth/pair", axum::routing::post(api_pair))
                .route("/api/auth/pin-status", get(api_pin_status))
                .route("/api/auth/pin-login", axum::routing::post(api_pin_login))
                // Protected endpoints - PTY start and WebSocket will return errors on iOS
                .route("/api/sessions", get(api_list_sessions).post(api_create_session))
                .route("/api/sessions/:session_id/buffer", get(api_get_buffer))
                .route("/api/sessions/:session_id/start", axum::routing::post(api_start_session))
                .route("/api/ws/:session_id", get(ws_handler))
                .layer(CorsLayer::permissive());

            // Try ports starting from WEB_PORT_BASE until we find one available
            let mut listener = None;
            let mut bound_port = WEB_PORT_BASE;

            for port_offset in 0..WEB_PORT_MAX_ATTEMPTS {
                let port = WEB_PORT_BASE + port_offset;
                let addr = SocketAddr::from(([0, 0, 0, 0], port));

                match tokio::net::TcpListener::bind(addr).await {
                    Ok(l) => {
                        bound_port = port;
                        listener = Some(l);
                        break;
                    }
                    Err(e) => {
                        println!("Port {} unavailable ({}), trying next...", port, e);
                    }
                }
            }

            let listener = listener.expect(&format!(
                "Failed to bind to any port in range {}-{}",
                WEB_PORT_BASE,
                WEB_PORT_BASE + WEB_PORT_MAX_ATTEMPTS - 1
            ));

            // Store the bound port for other parts of the app to access
            {
                let mut port_guard = WEB_SERVER_PORT.lock();
                *port_guard = Some(bound_port);
            }

            // Notify the app about the bound port
            if let Some(app) = APP_HANDLE.lock().as_ref() {
                let _ = app.emit("web-server-started", serde_json::json!({
                    "port": bound_port
                }));
            }

            println!("Web server listening on http://0.0.0.0:{}", bound_port);
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
        });
    });
}

// ============== End Web API ==============

// Desktop setup with menus
#[cfg(not(target_os = "ios"))]
fn setup_app(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Set window title (different for dev vs prod)
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(APP_NAME);
    }

    // Create and set the menu
    let menu = create_menu(app.handle())?;
    app.set_menu(menu)?;

    // Handle menu events
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        match id {
            "new_session" => {
                let _ = app.emit("menu-event", "new_session");
            }
            "close_session" => {
                let _ = app.emit("menu-event", "close_session");
            }
            "settings" => {
                let _ = app.emit("menu-event", "settings");
            }
            "toggle_sidebar" => {
                let _ = app.emit("menu-event", "toggle_sidebar");
            }
            "zoom_in" => {
                let _ = app.emit("menu-event", "zoom_in");
            }
            "zoom_out" => {
                let _ = app.emit("menu-event", "zoom_out");
            }
            "reset_zoom" => {
                let _ = app.emit("menu-event", "reset_zoom");
            }
            "rename_session" => {
                let _ = app.emit("menu-event", "rename_session");
            }
            "duplicate_session" => {
                let _ = app.emit("menu-event", "duplicate_session");
            }
            "reset_session_id" => {
                let _ = app.emit("menu-event", "reset_session_id");
            }
            "next_session" => {
                let _ = app.emit("menu-event", "next_session");
            }
            "prev_session" => {
                let _ = app.emit("menu-event", "prev_session");
            }
            "about" => {
                let _ = app.emit("menu-event", "about");
            }
            _ => {}
        }
    });

    // Store AppHandle for web server to use
    {
        let mut handle = APP_HANDLE.lock();
        *handle = Some(app.handle().clone());
    }

    // Start web server for remote access
    start_web_server();

    // Start MCP server if --mcp flag was passed
    if MCP_MODE.load(std::sync::atomic::Ordering::Relaxed) {
        let app_handle = app.handle().clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime for MCP");
            rt.block_on(async {
                if let Err(e) = mcp::start_mcp_server(app_handle).await {
                    eprintln!("MCP server error: {}", e);
                }
            });
        });
    }

    Ok(())
}

// iOS setup without menus
#[cfg(target_os = "ios")]
fn setup_app(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Store AppHandle for web server to use
    {
        let mut handle = APP_HANDLE.lock();
        *handle = Some(app.handle().clone());
    }

    // Start web server for remote access
    start_web_server();

    Ok(())
}

// Desktop version with full PTY support
#[cfg(not(target_os = "ios"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Check for --mcp flag to enable MCP server mode
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--mcp") {
        MCP_MODE.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            setup_app(app)
        })
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            spawn_json_process,
            write_to_process,
            kill_json_process,
            load_sessions,
            save_session,
            delete_session,
            update_session_claude_id,
            update_session_orders,
            save_terminal_buffer,
            load_terminal_buffer,
            delete_terminal_buffer,
            save_window_state,
            load_window_state,
            save_app_settings,
            load_app_settings,
            get_web_server_port,
            mcp_callback
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// iOS version without PTY commands (PTY not supported on iOS)
#[cfg(target_os = "ios")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            setup_app(app)
        })
        .invoke_handler(tauri::generate_handler![
            // PTY commands not available on iOS:
            // spawn_pty, write_pty, resize_pty, kill_pty
            load_sessions,
            save_session,
            delete_session,
            update_session_claude_id,
            update_session_orders,
            save_terminal_buffer,
            load_terminal_buffer,
            delete_terminal_buffer,
            save_window_state,
            load_window_state,
            save_app_settings,
            load_app_settings,
            get_web_server_port
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
