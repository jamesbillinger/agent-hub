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
#[cfg(not(target_os = "ios"))]
use tower_http::services::ServeDir;

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

// Broadcast channel for session status changes (start/stop events)
// All connected WebSocket clients receive these notifications
#[cfg(not(target_os = "ios"))]
static STATUS_BROADCASTER: Lazy<broadcast::Sender<String>> =
    Lazy::new(|| broadcast::channel::<String>(64).0);

// Global AppHandle for web server to use
static APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

// History menu submenu for dynamic updates
#[cfg(not(target_os = "ios"))]
static HISTORY_MENU: Lazy<Mutex<Option<Submenu<tauri::Wry>>>> = Lazy::new(|| Mutex::new(None));

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

// Mobile WebSocket: Channel for sending messages to mobile clients
// Each mobile client gets a sender that the server can use to push messages
#[cfg(not(target_os = "ios"))]
type MobileSender = tokio::sync::mpsc::UnboundedSender<String>;
#[cfg(not(target_os = "ios"))]
static MOBILE_CLIENTS: Lazy<Mutex<HashMap<String, MobileClient>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[cfg(not(target_os = "ios"))]
struct MobileClient {
    sender: MobileSender,
    subscribed_sessions: std::collections::HashSet<String>,
}

/// Broadcast a session event to all connected WebSocket clients
#[cfg(not(target_os = "ios"))]
fn broadcast_session_event(event_type: &str, data: serde_json::Value) {
    let msg = serde_json::json!({
        "type": event_type,
        "data": data
    }).to_string();
    let _ = STATUS_BROADCASTER.send(msg);
}

/// Broadcast a session status change (started/stopped)
#[cfg(not(target_os = "ios"))]
fn broadcast_session_status(session_id: &str, running: bool) {
    broadcast_session_event("session_status", serde_json::json!({
        "session_id": session_id,
        "running": running
    }));

    // Broadcast to ALL mobile clients so the session list status updates too
    let msg = serde_json::json!({
        "type": "session_status",
        "sessionId": session_id,
        "status": {
            "running": running
        }
    }).to_string();
    broadcast_to_mobile_clients(&msg);
}

/// Broadcast processing state change (thinking started/stopped)
#[cfg(not(target_os = "ios"))]
fn broadcast_processing_status(session_id: &str, processing: bool) {
    broadcast_session_event("processing_status", serde_json::json!({
        "session_id": session_id,
        "processing": processing
    }));

    // Broadcast to ALL mobile clients so the session list status updates too
    let msg = serde_json::json!({
        "type": "session_status",
        "sessionId": session_id,
        "status": {
            "isProcessing": processing
        }
    }).to_string();
    broadcast_to_mobile_clients(&msg);
}

/// Broadcast that a session was created
#[cfg(not(target_os = "ios"))]
fn broadcast_session_created(session: &SessionData) {
    broadcast_session_event("session_created", serde_json::json!(session));

    // Also broadcast to all mobile clients
    let msg = serde_json::json!({
        "type": "session_created",
        "session": session
    }).to_string();
    broadcast_to_mobile_clients(&msg);
}

/// Broadcast that a session was deleted
#[cfg(not(target_os = "ios"))]
fn broadcast_session_deleted(session_id: &str) {
    broadcast_session_event("session_deleted", serde_json::json!({
        "session_id": session_id
    }));

    // Also broadcast to all mobile clients
    let msg = serde_json::json!({
        "type": "session_deleted",
        "sessionId": session_id
    }).to_string();
    broadcast_to_mobile_clients(&msg);
}

/// Broadcast that a session was updated
#[cfg(not(target_os = "ios"))]
fn broadcast_session_updated(session: &SessionData) {
    broadcast_session_event("session_updated", serde_json::json!(session));

    // Also broadcast to all mobile clients
    let msg = serde_json::json!({
        "type": "session_updated",
        "session": session
    }).to_string();
    broadcast_to_mobile_clients(&msg);
}

/// Send a message to all mobile clients
#[cfg(not(target_os = "ios"))]
fn broadcast_to_mobile_clients(msg: &str) {
    let clients = MOBILE_CLIENTS.lock();
    for client in clients.values() {
        let _ = client.sender.send(msg.to_string());
    }
}

/// Send a message to mobile clients subscribed to a specific session
#[cfg(not(target_os = "ios"))]
fn broadcast_to_session_subscribers(session_id: &str, msg: &str) {
    let clients = MOBILE_CLIENTS.lock();
    for client in clients.values() {
        if client.subscribed_sessions.contains(session_id) {
            let _ = client.sender.send(msg.to_string());
        }
    }
}

/// Broadcast session list to all mobile clients
#[cfg(not(target_os = "ios"))]
fn broadcast_session_list_to_mobile() {
    let sessions = load_sessions().unwrap_or_default();
    let json_running: std::collections::HashSet<String> = {
        let broadcasters = JSON_BROADCASTERS.lock();
        broadcasters.keys().cloned().collect()
    };
    let pty_running: std::collections::HashSet<String> = {
        let pty_sessions = PTY_SESSIONS.lock();
        pty_sessions.keys().cloned().collect()
    };

    let sessions_with_status: Vec<serde_json::Value> = sessions.iter().map(|s| {
        let running = json_running.contains(&s.id) || pty_running.contains(&s.id);
        serde_json::json!({
            "id": s.id,
            "name": s.name,
            "created_at": s.created_at,
            "agent_type": s.agent_type,
            "working_dir": s.working_dir,
            "folder_id": s.folder_id,
            "running": running,
        })
    }).collect();

    let folders_data: Vec<serde_json::Value> = load_folders().unwrap_or_default().into_iter().map(|f| {
        serde_json::json!({
            "id": f.id,
            "name": f.name,
            "sort_order": f.sort_order,
            "collapsed": f.collapsed,
        })
    }).collect();

    let settings = load_app_settings().unwrap_or_default();
    let msg = serde_json::json!({
        "type": "session_list",
        "sessions": sessions_with_status,
        "folders": folders_data,
        "settings": {
            "show_active_sessions_group": settings.show_active_sessions_group
        }
    }).to_string();

    broadcast_to_mobile_clients(&msg);
}

/// Get session history for mobile clients (returns JSON messages parsed from buffer)
#[cfg(not(target_os = "ios"))]
fn get_session_history(session_id: &str) -> Option<Vec<serde_json::Value>> {
    // Load the raw buffer
    let buffer = load_terminal_buffer(session_id.to_string()).ok()??;

    // Try to parse as JSON array first (desktop format)
    if let Ok(messages) = serde_json::from_str::<Vec<serde_json::Value>>(&buffer) {
        if messages.is_empty() {
            return None;
        }
        return Some(messages);
    }

    // Fall back to NDJSON format (one JSON object per line)
    let mut messages = Vec::new();
    for line in buffer.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            messages.push(json);
        }
    }

    if messages.is_empty() {
        None
    } else {
        Some(messages)
    }
}

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
    #[serde(default = "default_true")]
    show_active_sessions_group: bool,
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
            show_active_sessions_group: true,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FolderData {
    id: String,
    name: String,
    sort_order: i32,
    collapsed: bool,
}

/// Claude JSON message content item (text, tool_use, tool_result, image)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClaudeContentItem {
    #[serde(rename = "type")]
    content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<serde_json::Value>,
}

/// Claude JSON message usage stats
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ClaudeUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_creation_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_read_input_tokens: Option<u64>,
}

/// Claude JSON message inner message structure
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClaudeMessageInner {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    message_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<Vec<ClaudeContentItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<ClaudeUsage>,
}

/// Claude JSON message - the outer envelope
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClaudeJsonMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<ClaudeMessageInner>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_api_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_output_tokens: Option<u64>,
    // Init message fields
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    claude_code_version: Option<String>,
    #[serde(rename = "permissionMode", skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
    // Result message fields
    #[serde(skip_serializing_if = "Option::is_none")]
    num_turns: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<ClaudeUsage>,
}

/// Parse a raw JSON line from Claude, handling escape codes
fn parse_claude_json(line: &str) -> Option<ClaudeJsonMessage> {
    // Strip iTerm2 shell integration escape codes that may prefix the JSON
    // These look like: ]1337;RemoteHost=...]1337;CurrentDir=...{"type":...}
    let json_str = if let Some(json_start) = line.find('{') {
        &line[json_start..]
    } else {
        line
    };

    serde_json::from_str(json_str).ok()
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
    // Set busy timeout so concurrent connections wait instead of failing with "database is locked"
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
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

    // Migration: Add running_pid column to track process PIDs across restarts
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN running_pid INTEGER", []);

    // Migration: Add folder_id column for folder/group support
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN folder_id TEXT", []);

    // Create folders table for session organization
    conn.execute(
        "CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            collapsed INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )?;

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

    // Create recently_closed table for undo close functionality
    conn.execute(
        "CREATE TABLE IF NOT EXISTS recently_closed (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            agent_type TEXT NOT NULL,
            command TEXT NOT NULL,
            working_dir TEXT NOT NULL,
            claude_session_id TEXT,
            closed_at TEXT NOT NULL
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

/// Save/clear the running PID for a session
#[cfg(not(target_os = "ios"))]
fn save_session_pid(session_id: &str, pid: Option<u32>) {
    if let Ok(conn) = init_db() {
        let _ = conn.execute(
            "UPDATE sessions SET running_pid = ?1 WHERE id = ?2",
            params![pid.map(|p| p as i64), session_id],
        );
    }
}

/// Check if a process is still running
#[cfg(not(target_os = "ios"))]
fn is_process_running(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// On app startup, check for sessions with running PIDs and clean them up
/// Since we can't reattach to orphaned processes (no stdin/stdout handles),
/// we kill them and clear the PIDs so the user can restart cleanly
#[cfg(not(target_os = "ios"))]
fn cleanup_orphaned_processes() {
    if let Ok(conn) = init_db() {
        let mut stmt = match conn.prepare("SELECT id, running_pid FROM sessions WHERE running_pid IS NOT NULL") {
            Ok(s) => s,
            Err(_) => return,
        };

        let rows = match stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }) {
            Ok(r) => r,
            Err(_) => return,
        };

        for row in rows.flatten() {
            let (session_id, pid) = row;
            let pid = pid as u32;

            if is_process_running(pid) {
                // Kill the orphaned process - we can't reattach to it anyway
                println!("Killing orphaned process for session {}: PID {}", session_id, pid);
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
                // Give it a moment then force kill if needed
                std::thread::sleep(std::time::Duration::from_millis(100));
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            } else {
                println!("Clearing stale PID {} for session {}", pid, session_id);
            }

            // Clear the PID in either case
            save_session_pid(&session_id, None);
        }
    }
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
        .prepare("SELECT id, name, agent_type, command, working_dir, created_at, claude_session_id, sort_order, folder_id FROM sessions ORDER BY sort_order ASC, created_at DESC")
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
                folder_id: row.get(8)?,
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

    // Check if this is an update or create
    let is_new: bool = conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE id = ?1",
        params![session.id],
        |row| row.get::<_, i32>(0)
    ).unwrap_or(0) == 0;

    conn.execute(
        "INSERT OR REPLACE INTO sessions (id, name, agent_type, command, working_dir, created_at, claude_session_id, sort_order, folder_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            session.id,
            session.name,
            session.agent_type,
            session.command,
            session.working_dir,
            session.created_at,
            session.claude_session_id,
            session.sort_order,
            session.folder_id,
        ],
    )
    .map_err(|e| e.to_string())?;

    // Broadcast session change to WebSocket clients
    #[cfg(not(target_os = "ios"))]
    {
        if is_new {
            broadcast_session_created(&session);
        } else {
            broadcast_session_updated(&session);
        }
    }

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

    // Broadcast session deletion to WebSocket clients
    #[cfg(not(target_os = "ios"))]
    broadcast_session_deleted(&session_id);

    Ok(())
}

// --- Folder commands ---

#[tauri::command]
fn load_folders() -> Result<Vec<FolderData>, String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, sort_order, collapsed FROM folders ORDER BY sort_order ASC")
        .map_err(|e| e.to_string())?;

    let folders = stmt
        .query_map([], |row| {
            Ok(FolderData {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_order: row.get(2)?,
                collapsed: row.get::<_, i32>(3)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(folders)
}

#[tauri::command]
fn save_folder(folder: FolderData) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO folders (id, name, sort_order, collapsed) VALUES (?1, ?2, ?3, ?4)",
        params![folder.id, folder.name, folder.sort_order, folder.collapsed as i32],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_folder(folder_id: String) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    // Move sessions in this folder to unfiled
    conn.execute(
        "UPDATE sessions SET folder_id = NULL WHERE folder_id = ?1",
        params![folder_id],
    )
    .map_err(|e| e.to_string())?;
    // Delete the folder
    conn.execute("DELETE FROM folders WHERE id = ?1", params![folder_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_folder_orders(folder_orders: Vec<(String, i32)>) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    for (folder_id, sort_order) in folder_orders {
        conn.execute(
            "UPDATE folders SET sort_order = ?1 WHERE id = ?2",
            params![sort_order, folder_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn update_session_folder(session_id: String, folder_id: Option<String>) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions SET folder_id = ?1 WHERE id = ?2",
        params![folder_id, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_folder_collapsed(folder_id: String, collapsed: bool) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE folders SET collapsed = ?1 WHERE id = ?2",
        params![collapsed as i32, folder_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct RecentlyClosedData {
    id: String,
    name: String,
    agent_type: String,
    command: String,
    working_dir: String,
    claude_session_id: Option<String>,
    closed_at: String,
}

#[tauri::command]
fn save_recently_closed(session: RecentlyClosedData) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;

    // Insert the newly closed session
    conn.execute(
        "INSERT OR REPLACE INTO recently_closed (id, name, agent_type, command, working_dir, claude_session_id, closed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            session.id,
            session.name,
            session.agent_type,
            session.command,
            session.working_dir,
            session.claude_session_id,
            session.closed_at,
        ],
    ).map_err(|e| e.to_string())?;

    // Keep only the 10 most recent entries
    conn.execute(
        "DELETE FROM recently_closed WHERE id NOT IN (
            SELECT id FROM recently_closed ORDER BY closed_at DESC LIMIT 10
        )",
        [],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_recently_closed() -> Result<Vec<RecentlyClosedData>, String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, agent_type, command, working_dir, claude_session_id, closed_at FROM recently_closed ORDER BY closed_at DESC")
        .map_err(|e| e.to_string())?;

    let sessions: Vec<RecentlyClosedData> = stmt
        .query_map([], |row| {
            Ok(RecentlyClosedData {
                id: row.get(0)?,
                name: row.get(1)?,
                agent_type: row.get(2)?,
                command: row.get(3)?,
                working_dir: row.get(4)?,
                claude_session_id: row.get(5)?,
                closed_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(sessions)
}

#[tauri::command]
fn delete_recently_closed(session_id: String) -> Result<(), String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM recently_closed WHERE id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Update the History menu with recently closed sessions
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn update_history_menu(sessions: Vec<RecentlyClosedData>) -> Result<(), String> {
    let app_handle = APP_HANDLE.lock();
    let app = app_handle.as_ref().ok_or("App handle not available")?;

    let history_menu_guard = HISTORY_MENU.lock();
    let history_menu = history_menu_guard.as_ref().ok_or("History menu not available")?;

    // Remove all existing items
    if let Ok(items) = history_menu.items() {
        for item in items {
            let _ = history_menu.remove(&item);
        }
    }

    if sessions.is_empty() {
        // Add placeholder when no sessions
        let no_recent = MenuItem::with_id(app, "no_recent", "No Recently Closed", false, None::<&str>)
            .map_err(|e| e.to_string())?;
        history_menu.append(&no_recent).map_err(|e| e.to_string())?;
    } else {
        // Add each session as a menu item
        for (index, session) in sessions.iter().enumerate() {
            let id = format!("recent_{}", index);
            let label = &session.name;
            // Add keyboard shortcut for first item (Cmd+Shift+T)
            let accel = if index == 0 { Some("CmdOrCtrl+Shift+T") } else { None };
            let item = MenuItem::with_id(app, &id, label, true, accel)
                .map_err(|e| e.to_string())?;
            history_menu.append(&item).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

// Stub for iOS - no menu support
#[cfg(target_os = "ios")]
#[tauri::command]
fn update_history_menu(_sessions: Vec<RecentlyClosedData>) -> Result<(), String> {
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

/// Get the user's home directory
#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not find home directory".to_string())
}

/// List Claude sessions for a given working directory
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn list_claude_sessions(working_dir: Option<String>) -> Result<Vec<ClaudeSessionInfo>, String> {
    use std::io::{BufRead, BufReader};

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let claude_projects = home.join(".claude").join("projects");

    if !claude_projects.exists() {
        return Ok(vec![]);
    }

    // Resolve working directory
    let work_dir = working_dir
        .map(|s| std::path::PathBuf::from(shellexpand::tilde(&s).to_string()))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default());

    // Convert to Claude's folder naming convention
    let project_folder_name = work_dir.to_string_lossy()
        .replace('/', "-")
        .trim_start_matches('-')
        .to_string();

    let project_folder = claude_projects.join(format!("-{}", project_folder_name));
    if !project_folder.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&project_folder) {
        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() || path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }

            let session_id = match path.file_stem() {
                Some(s) => s.to_string_lossy().to_string(),
                None => continue,
            };

            // Skip if not a UUID
            if session_id.len() != 36 || session_id.chars().filter(|c| *c == '-').count() != 4 {
                continue;
            }

            // Get modification time
            let modified = entry.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            // Read first user message for preview
            let mut first_message = String::new();
            if let Ok(file) = std::fs::File::open(&path) {
                let reader = BufReader::new(file);
                for line in reader.lines().take(50) {
                    if let Ok(line) = line {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                            if json.get("type").and_then(|t| t.as_str()) == Some("user") {
                                if let Some(msg) = json.get("message")
                                    .and_then(|m| m.get("content"))
                                    .and_then(|c| c.as_str())
                                {
                                    first_message = msg.chars().take(100).collect();
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            sessions.push(ClaudeSessionInfo {
                session_id,
                modified,
                first_message,
                project: work_dir.to_string_lossy().to_string(),
            });
        }
    }

    // Sort by modified time descending (newest first)
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));

    Ok(sessions)
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn list_claude_sessions(_working_dir: Option<String>) -> Result<Vec<ClaudeSessionInfo>, String> {
    Ok(vec![])
}

/// Load the full message history from a Claude session file
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn load_claude_session_history(session_id: String, project: String) -> Result<Vec<serde_json::Value>, String> {
    use std::io::{BufRead, BufReader};

    let home = dirs::home_dir().ok_or_else(|| "Could not find home directory".to_string())?;
    let claude_projects = home.join(".claude").join("projects");

    // Build project folder name the same way Claude does
    let project_folder_name = project
        .replace('/', "-")
        .trim_start_matches('-')
        .to_string();

    let session_file = claude_projects
        .join(format!("-{}", project_folder_name))
        .join(format!("{}.jsonl", session_id));

    if !session_file.exists() {
        return Err(format!("Session file not found: {:?}", session_file));
    }

    let file = std::fs::File::open(&session_file)
        .map_err(|e| format!("Could not open session file: {}", e))?;
    let reader = BufReader::new(file);

    let mut messages = Vec::new();
    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                // Only include user and assistant messages
                if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                    if msg_type == "user" || msg_type == "assistant" {
                        messages.push(json);
                    }
                }
            }
        }
    }

    Ok(messages)
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn load_claude_session_history(_session_id: String, _project: String) -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}

#[derive(serde::Serialize)]
struct ClaudeSessionInfo {
    session_id: String,
    modified: u64,
    first_message: String,
    project: String,
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

    // Notify WebSocket clients that session started
    broadcast_session_status(&session_id, true);

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
        // Notify WebSocket clients that session stopped
        broadcast_session_status(&session_id_clone, false);
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

            // Save the PID to database for crash recovery
            save_session_pid(&session_id_clone, Some(child_id));

            // Notify that process started
            let _ = app_clone.emit("json-process-started", serde_json::json!({
                "session_id": session_id_clone
            }));

            // Notify WebSocket clients that session started
            broadcast_session_status(&session_id_clone, true);

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
                    // Parse JSON and emit structured message (new event)
                    // This offloads JSON parsing from the frontend
                    if let Some(parsed) = parse_claude_json(&line) {
                        // Detect processing state changes
                        match parsed.msg_type.as_str() {
                            "assistant" => {
                                broadcast_processing_status(&session_id_stdout, true);
                            }
                            "result" => {
                                broadcast_processing_status(&session_id_stdout, false);
                            }
                            _ => {}
                        }

                        // Emit pre-parsed message to Tauri frontend
                        let _ = app_stdout.emit("json-process-message", serde_json::json!({
                            "session_id": session_id_stdout,
                            "message": parsed
                        }));

                        // Broadcast to mobile WebSocket subscribers (pre-parsed)
                        let msg = serde_json::json!({
                            "type": "chat_message",
                            "sessionId": session_id_stdout,
                            "message": parsed
                        }).to_string();
                        broadcast_to_session_subscribers(&session_id_stdout, &msg);

                        // Broadcast to legacy WebSocket clients (raw string for backward compat)
                        let data = line.clone() + "\n";
                        let _ = broadcast_stdout.send(data);
                    } else {
                        // Failed to parse - emit raw line for debugging
                        eprintln!("Failed to parse Claude JSON: {}", &line);
                        let data = line + "\n";
                        let _ = app_stdout.emit("json-process-output", serde_json::json!({
                            "session_id": session_id_stdout,
                            "data": &data
                        }));
                        let _ = broadcast_stdout.send(data);
                    }
                }
            });

            // Spawn task to handle stderr (usually non-JSON debug output)
            let app_stderr = app_clone.clone();
            let session_id_stderr = session_id_clone.clone();
            let broadcast_stderr = broadcast_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    // Try to parse as JSON first (some errors come as JSON)
                    if let Some(parsed) = parse_claude_json(&line) {
                        let _ = app_stderr.emit("json-process-message", serde_json::json!({
                            "session_id": session_id_stderr,
                            "message": parsed
                        }));
                        let msg = serde_json::json!({
                            "type": "chat_message",
                            "sessionId": session_id_stderr,
                            "message": parsed
                        }).to_string();
                        broadcast_to_session_subscribers(&session_id_stderr, &msg);
                        let data = line.clone() + "\n";
                        let _ = broadcast_stderr.send(data);
                    } else {
                        // Non-JSON stderr - emit as raw output
                        let data = line + "\n";
                        let _ = app_stderr.emit("json-process-output", serde_json::json!({
                            "session_id": session_id_stderr,
                            "data": &data
                        }));
                        let _ = broadcast_stderr.send(data);
                    }
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
            // Clear the PID from database
            save_session_pid(&session_id_clone, None);
            // Notify WebSocket clients that session stopped
            broadcast_session_status(&session_id_clone, false);
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
        process.stdin.try_send(data.clone())
            .map_err(|e| format!("Failed to send to stdin: {}", e))?;

        // Broadcast user message to WebSocket clients (mobile app)
        // so they can see messages typed on desktop
        drop(processes); // Release lock before acquiring another
        if let Some(tx) = {
            let broadcasters = JSON_BROADCASTERS.lock();
            broadcasters.get(&session_id).cloned()
        } {
            let _ = tx.send(data);
        }

        Ok(())
    } else {
        Err("Process not found".to_string())
    }
}

/// Interrupt a JSON process by sending SIGINT
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn interrupt_json_process(session_id: String) -> Result<(), String> {
    let processes = JSON_PROCESSES.lock();
    if let Some(process) = processes.get(&session_id) {
        if process.child_id > 0 {
            // Send SIGINT to the process
            unsafe {
                libc::kill(process.child_id as i32, libc::SIGINT);
            }
        }
    }
    Ok(())
}

/// Kill a JSON process
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn kill_json_process(session_id: String) -> Result<(), String> {
    let mut processes = JSON_PROCESSES.lock();
    if let Some(process) = processes.remove(&session_id) {
        // Kill the process using its PID
        unsafe {
            libc::kill(process.child_id as i32, libc::SIGTERM);
        }
        // Give it a moment to terminate gracefully, then force kill
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            unsafe {
                libc::kill(process.child_id as i32, libc::SIGKILL);
            }
        });
    }
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

/// Get local IP addresses for remote access URL display
#[tauri::command]
fn get_local_ips() -> Vec<String> {
    use std::net::IpAddr;

    let mut ips = Vec::new();

    // Get the local IP address (primary network interface)
    if let Ok(ip) = local_ip_address::local_ip() {
        ips.push(ip.to_string());
    }

    // Also try to get all local IPs for multi-interface systems
    if let Ok(network_interfaces) = local_ip_address::list_afinet_netifas() {
        for (_, ip) in network_interfaces {
            // Skip loopback addresses
            if ip.is_loopback() {
                continue;
            }

            // Skip IPv6 link-local addresses (fe80::) - not useful for remote access
            if let IpAddr::V6(v6) = ip {
                // Check for link-local (starts with fe80)
                let segments = v6.segments();
                if segments[0] == 0xfe80 {
                    continue;
                }
            }

            let ip_str = ip.to_string();
            // Skip already-added addresses
            if !ips.contains(&ip_str) {
                ips.push(ip_str);
            }
        }
    }

    ips
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

/// Read an image file and return as base64
#[tauri::command]
fn read_image_file(path: String) -> Result<String, String> {
    use base64::Engine;

    // Expand ~ to home directory
    let expanded_path = shellexpand::tilde(&path);
    let file_path = std::path::Path::new(expanded_path.as_ref());

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    // Read file contents
    let contents = std::fs::read(file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Determine media type from extension
    let media_type = match file_path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };

    // Encode as base64 data URL
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&contents);
    Ok(format!("data:{};base64,{}", media_type, base64_data))
}

/// Read a text file and return its contents
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let expanded_path = shellexpand::tilde(&path);
    let file_path = std::path::Path::new(expanded_path.as_ref());

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    std::fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

/// Find the most recently modified plan file in ~/.claude/plans/
#[tauri::command]
fn find_latest_plan_file() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let plans_dir = home.join(".claude").join("plans");

    if !plans_dir.exists() {
        return Err("Plans directory does not exist".to_string());
    }

    let mut latest: Option<(std::path::PathBuf, std::time::SystemTime)> = None;

    if let Ok(entries) = std::fs::read_dir(&plans_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "md") {
                if let Ok(metadata) = path.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        if latest.as_ref().map_or(true, |(_, t)| modified > *t) {
                            latest = Some((path, modified));
                        }
                    }
                }
            }
        }
    }

    latest
        .map(|(path, _)| path.to_string_lossy().to_string())
        .ok_or("No plan files found".to_string())
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

    let settings = MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?;

    let app_menu = Submenu::with_items(
        app,
        APP_NAME,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&about_text), None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
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

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_session,
            &close_session,
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
    let browse_claude_sessions = MenuItem::with_id(app, "browse_claude_sessions", "Browse Claude Sessions...", true, Some("CmdOrCtrl+Shift+R"))?;
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
            &browse_claude_sessions,
            &PredefinedMenuItem::separator(app)?,
            &next_session,
            &prev_session,
        ],
    )?;

    // History menu - starts with "No Recently Closed" placeholder
    let no_recent = MenuItem::with_id(app, "no_recent", "No Recently Closed", false, None::<&str>)?;

    let history_menu = Submenu::with_items(
        app,
        "History",
        true,
        &[
            &no_recent,
        ],
    )?;

    // Store history menu for dynamic updates
    *HISTORY_MENU.lock() = Some(history_menu.clone());

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
            &history_menu,
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


// GET / - Serve mobile web client
async fn web_index() -> impl IntoResponse {
    // Find the React app's index.html
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    // Try multiple locations for the mobile-web-dist directory
    let possible_paths = [
        exe_dir.as_ref().map(|d| d.join("mobile-web-dist/index.html")),
        exe_dir.as_ref().map(|d| d.join("../Resources/mobile-web-dist/index.html")),
        Some(std::path::PathBuf::from("mobile-web-dist/index.html")),
    ];

    for path_opt in possible_paths.iter().flatten() {
        if path_opt.exists() {
            if let Ok(contents) = std::fs::read_to_string(path_opt) {
                return axum::response::Html(contents);
            }
        }
    }

    // Error - mobile-web-dist not found
    axum::response::Html(format!(
        r#"<!DOCTYPE html>
<html><head><title>{}</title></head>
<body style="background:#1a1a1a;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
<h1>Mobile Web Not Found</h1>
<p>The mobile-web-dist directory was not found. Please rebuild the application.</p>
</div></body></html>"#,
        APP_NAME
    ))
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
            // Check both PTY (shell) and JSON (chat) broadcasters for running status
            let pty_running_ids: std::collections::HashSet<String> = {
                let broadcasters = PTY_BROADCASTERS.lock();
                broadcasters.keys().cloned().collect()
            };
            let json_running_ids: std::collections::HashSet<String> = {
                let broadcasters = JSON_BROADCASTERS.lock();
                broadcasters.keys().cloned().collect()
            };

            // Add running status to each session
            let sessions_with_status: Vec<serde_json::Value> = sessions.into_iter().map(|s| {
                let is_running = pty_running_ids.contains(&s.id) || json_running_ids.contains(&s.id);
                serde_json::json!({
                    "id": s.id,
                    "name": s.name,
                    "agent_type": s.agent_type,
                    "command": s.command,
                    "working_dir": s.working_dir,
                    "created_at": s.created_at,
                    "claude_session_id": s.claude_session_id,
                    "sort_order": s.sort_order,
                    "folder_id": s.folder_id,
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
                    "folder_id": s.folder_id,
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
        "claude-json" => "claude --print --verbose --input-format stream-json --output-format stream-json --dangerously-skip-permissions".to_string(),
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

    let folder_id = body.get("folder_id").and_then(|v| v.as_str()).map(|s| s.to_string());

    let session = SessionData {
        id: session_id.clone(),
        name: session_name,
        agent_type: agent_type.to_string(),
        command,
        working_dir: working_dir.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        claude_session_id,
        sort_order: min_sort_order - 1,
        folder_id,
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
        "folder_id": session.folder_id,
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

// POST /api/sessions/{id}/interrupt - Interrupt a running session
#[cfg(not(target_os = "ios"))]
async fn api_interrupt_session(
    headers: axum::http::HeaderMap,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    if let Some(err) = check_auth(&headers) {
        return err.into_response();
    }

    // Check if it's a JSON session
    let is_json = {
        let json_broadcasters = JSON_BROADCASTERS.lock();
        json_broadcasters.contains_key(&session_id)
    };

    if is_json {
        // Send SIGINT to JSON process
        let processes = JSON_PROCESSES.lock();
        if let Some(process) = processes.get(&session_id) {
            if process.child_id > 0 {
                unsafe {
                    libc::kill(process.child_id as i32, libc::SIGINT);
                }
                return Json(serde_json::json!({ "status": "interrupted" })).into_response();
            }
        }
        return (StatusCode::NOT_FOUND, "Process not found").into_response();
    }

    // Check if it's a PTY session
    let is_pty = {
        let pty_broadcasters = PTY_BROADCASTERS.lock();
        pty_broadcasters.contains_key(&session_id)
    };

    if is_pty {
        // Send Ctrl+C to PTY
        let sessions = PTY_SESSIONS.lock();
        if let Some(session) = sessions.get(&session_id) {
            let mut session = session.lock();
            // Send ETX (Ctrl+C)
            let _ = session.writer.write_all(&[0x03]);
            let _ = session.writer.flush();
            return Json(serde_json::json!({ "status": "interrupted" })).into_response();
        }
        return (StatusCode::NOT_FOUND, "PTY session not found").into_response();
    }

    (StatusCode::NOT_FOUND, "Session not running").into_response()
}

// iOS version
#[cfg(target_os = "ios")]
async fn api_interrupt_session(
    headers: axum::http::HeaderMap,
    Path(_session_id): Path<String>,
) -> impl IntoResponse {
    if let Some(err) = check_auth(&headers) {
        return err.into_response();
    }
    (StatusCode::NOT_IMPLEMENTED, Json(serde_json::json!({
        "error": "not_supported",
        "message": "Cannot interrupt sessions on iOS."
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
    use tokio::time::{interval, Duration};

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

        // Subscribe to status updates for all sessions
        let mut status_rx = STATUS_BROADCASTER.subscribe();

        // Spawn task to forward JSON output and status updates to WebSocket with keepalive pings
        let send_task = tokio::spawn(async move {
            let mut ping_interval = interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    result = rx.recv() => {
                        match result {
                            Ok(data) => {
                                if sender.send(Message::Text(data)).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => {
                                break;
                            }
                        }
                    }
                    // Forward session status changes to client
                    result = status_rx.recv() => {
                        if let Ok(status_msg) = result {
                            if sender.send(Message::Text(status_msg)).await.is_err() {
                                break;
                            }
                        }
                    }
                    _ = ping_interval.tick() => {
                        // Send WebSocket ping to keep connection alive
                        if sender.send(Message::Ping(vec![])).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // Handle incoming messages from WebSocket (user input for JSON process)
        let recv_task = tokio::spawn(async move {
            while let Some(Ok(msg)) = receiver.next().await {
                match msg {
                    Message::Text(text) => {
                        // For JSON sessions, forward text directly to stdin
                        let _ = write_to_process(session_id_clone.clone(), text.clone());

                        // Also broadcast the user message so other clients (mobile web) can see it
                        if let Some(tx) = {
                            let broadcasters = JSON_BROADCASTERS.lock();
                            broadcasters.get(&session_id_clone).cloned()
                        } {
                            let _ = tx.send(text.clone());
                        }

                        // Emit Tauri event so desktop frontend can see user messages from mobile
                        // Use same event name as process output so frontend handles it consistently
                        if let Some(app) = APP_HANDLE.lock().as_ref() {
                            let _ = app.emit("json-process-output", serde_json::json!({
                                "session_id": session_id_clone.clone(),
                                "data": text,
                            }));
                        }
                    }
                    Message::Pong(_) => {
                        // Pong received, connection is alive
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

        // Subscribe to status updates for all sessions
        let mut status_rx = STATUS_BROADCASTER.subscribe();

        // Spawn task to forward PTY output and status updates to WebSocket with keepalive pings
        let send_task = tokio::spawn(async move {
            let mut ping_interval = interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    result = rx.recv() => {
                        match result {
                            Ok(data) => {
                                if sender.send(Message::Binary(data)).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    // Forward session status/events to client
                    result = status_rx.recv() => {
                        if let Ok(status_msg) = result {
                            if sender.send(Message::Text(status_msg)).await.is_err() {
                                break;
                            }
                        }
                    }
                    _ = ping_interval.tick() => {
                        // Send WebSocket ping to keep connection alive
                        if sender.send(Message::Ping(vec![])).await.is_err() {
                            break;
                        }
                    }
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
                    Message::Pong(_) => {
                        // Pong received, connection is alive
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

// Status-only WebSocket for receiving session events (start/stop, create/update/delete)
// This allows mobile clients to receive updates without being connected to a specific session
#[cfg(not(target_os = "ios"))]
async fn ws_status_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_ws_status)
}

#[cfg(not(target_os = "ios"))]
async fn handle_ws_status(socket: WebSocket) {
    use tokio::time::{interval, Duration};

    let (mut sender, mut receiver) = socket.split();
    let mut status_rx = STATUS_BROADCASTER.subscribe();

    // Spawn task to forward status updates to WebSocket with keepalive pings
    let send_task = tokio::spawn(async move {
        let mut ping_interval = interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                result = status_rx.recv() => {
                    if let Ok(status_msg) = result {
                        if sender.send(Message::Text(status_msg)).await.is_err() {
                            break;
                        }
                    }
                }
                _ = ping_interval.tick() => {
                    if sender.send(Message::Ping(vec![])).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Handle incoming messages (mainly pongs, but could be used for commands later)
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {} // Ignore other messages
        }
    }

    send_task.abort();
}

// iOS stub for status WebSocket
#[cfg(target_os = "ios")]
async fn ws_status_handler(_ws: WebSocketUpgrade) -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "Status WebSocket not supported on iOS")
}

// Mobile WebSocket handler - multiplexed connection with auth and subscriptions
#[cfg(not(target_os = "ios"))]
async fn ws_mobile_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_ws_mobile)
}

#[cfg(not(target_os = "ios"))]
async fn handle_ws_mobile(socket: WebSocket) {
    use tokio::time::{interval, Duration};

    let (mut sender, mut receiver) = socket.split();
    let client_id = generate_token();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // We'll authenticate on first message, so track auth state
    let mut authenticated = false;

    // Register client (not yet authenticated)
    {
        let mut clients = MOBILE_CLIENTS.lock();
        clients.insert(client_id.clone(), MobileClient {
            sender: tx.clone(),
            subscribed_sessions: std::collections::HashSet::new(),
        });
    }

    let client_id_for_cleanup = client_id.clone();

    // Spawn task to forward messages from channel to WebSocket
    let send_task = tokio::spawn(async move {
        let mut ping_interval = interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(text) => {
                            if sender.send(Message::Text(text)).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = ping_interval.tick() => {
                    if sender.send(Message::Ping(vec![])).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Handle incoming messages
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Parse JSON message
                let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
                    let _ = tx.send(serde_json::json!({
                        "type": "error",
                        "message": "Invalid JSON"
                    }).to_string());
                    continue;
                };

                let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

                match msg_type {
                    "auth" => {
                        // Authenticate with token
                        let token = json.get("token").and_then(|v| v.as_str()).unwrap_or("");

                        // Check if no devices paired (allow access for setup)
                        let no_devices = {
                            let devices = PAIRED_DEVICES.lock();
                            devices.is_empty()
                        };

                        if no_devices || is_valid_token(token) {
                            authenticated = true;
                            let _ = tx.send(serde_json::json!({
                                "type": "auth_success"
                            }).to_string());

                            // Send initial session list
                            let sessions = load_sessions().unwrap_or_default();
                            let json_running: std::collections::HashSet<String> = {
                                let broadcasters = JSON_BROADCASTERS.lock();
                                broadcasters.keys().cloned().collect()
                            };
                            let pty_running: std::collections::HashSet<String> = {
                                let pty_sessions = PTY_SESSIONS.lock();
                                pty_sessions.keys().cloned().collect()
                            };

                            let sessions_with_status: Vec<serde_json::Value> = sessions.iter().map(|s| {
                                let running = json_running.contains(&s.id) || pty_running.contains(&s.id);
                                serde_json::json!({
                                    "id": s.id,
                                    "name": s.name,
                                    "created_at": s.created_at,
                                    "agent_type": s.agent_type,
                                    "working_dir": s.working_dir,
                                    "folder_id": s.folder_id,
                                    "running": running,
                                })
                            }).collect();

                            let folders_data: Vec<serde_json::Value> = load_folders().unwrap_or_default().into_iter().map(|f| {
                                serde_json::json!({
                                    "id": f.id,
                                    "name": f.name,
                                    "sort_order": f.sort_order,
                                    "collapsed": f.collapsed,
                                })
                            }).collect();

                            let settings = load_app_settings().unwrap_or_default();
                            let _ = tx.send(serde_json::json!({
                                "type": "session_list",
                                "sessions": sessions_with_status,
                                "folders": folders_data,
                                "settings": {
                                    "show_active_sessions_group": settings.show_active_sessions_group
                                }
                            }).to_string());
                        } else {
                            let _ = tx.send(serde_json::json!({
                                "type": "auth_error",
                                "message": "Invalid token"
                            }).to_string());
                        }
                    }

                    "subscribe" => {
                        if !authenticated {
                            let _ = tx.send(serde_json::json!({
                                "type": "error",
                                "message": "Not authenticated"
                            }).to_string());
                            continue;
                        }

                        let session_id = json.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
                        if session_id.is_empty() {
                            let _ = tx.send(serde_json::json!({
                                "type": "error",
                                "message": "sessionId required"
                            }).to_string());
                            continue;
                        }

                        // Add subscription
                        {
                            let mut clients = MOBILE_CLIENTS.lock();
                            if let Some(client) = clients.get_mut(&client_id) {
                                client.subscribed_sessions.insert(session_id.to_string());
                            }
                        }

                        // Send chat history for this session
                        if let Some(history) = get_session_history(session_id) {
                            let _ = tx.send(serde_json::json!({
                                "type": "chat_history",
                                "sessionId": session_id,
                                "messages": history
                            }).to_string());
                        }

                        // Send current session status
                        let is_running = {
                            let json_broadcasters = JSON_BROADCASTERS.lock();
                            json_broadcasters.contains_key(session_id)
                        };
                        let _ = tx.send(serde_json::json!({
                            "type": "session_status",
                            "sessionId": session_id,
                            "status": {
                                "running": is_running,
                                "isProcessing": false  // We'd need to track this properly
                            }
                        }).to_string());
                    }

                    "unsubscribe" => {
                        let session_id = json.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
                        {
                            let mut clients = MOBILE_CLIENTS.lock();
                            if let Some(client) = clients.get_mut(&client_id) {
                                client.subscribed_sessions.remove(session_id);
                            }
                        }
                    }

                    "send_message" => {
                        if !authenticated {
                            let _ = tx.send(serde_json::json!({
                                "type": "error",
                                "message": "Not authenticated"
                            }).to_string());
                            continue;
                        }

                        let session_id = json.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
                        let content = json.get("content");

                        if session_id.is_empty() || content.is_none() {
                            let _ = tx.send(serde_json::json!({
                                "type": "error",
                                "message": "sessionId and content required"
                            }).to_string());
                            continue;
                        }

                        // Convert content to string for the process
                        // If content is already a string (pre-formatted JSON from mobile), use it directly
                        // Otherwise serialize it as JSON
                        let content_str = match content.unwrap() {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        };

                        // Write to the session's process
                        let _ = write_to_process(session_id.to_string(), content_str.clone());

                        // Broadcast to other clients watching this session
                        if let Some(broadcaster) = {
                            let broadcasters = JSON_BROADCASTERS.lock();
                            broadcasters.get(session_id).cloned()
                        } {
                            let _ = broadcaster.send(content_str.clone());
                        }

                        // Emit Tauri event so desktop sees mobile messages
                        if let Some(app) = APP_HANDLE.lock().as_ref() {
                            let _ = app.emit("json-process-output", serde_json::json!({
                                "session_id": session_id,
                                "data": content_str,
                            }));
                        }
                    }

                    "interrupt" => {
                        if !authenticated {
                            continue;
                        }

                        let session_id = json.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
                        if !session_id.is_empty() {
                            let _ = interrupt_json_process(session_id.to_string());
                        }
                    }

                    _ => {
                        let _ = tx.send(serde_json::json!({
                            "type": "error",
                            "message": format!("Unknown message type: {}", msg_type)
                        }).to_string());
                    }
                }
            }
            Ok(Message::Pong(_)) => {
                // Connection alive
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    // Cleanup
    send_task.abort();
    {
        let mut clients = MOBILE_CLIENTS.lock();
        clients.remove(&client_id_for_cleanup);
    }
}

// iOS stub for mobile WebSocket
#[cfg(target_os = "ios")]
async fn ws_mobile_handler(_ws: WebSocketUpgrade) -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "Mobile WebSocket not supported on iOS")
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
            // Find mobile-web-dist directory for serving static assets
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()));

            let mobile_web_dir = [
                exe_dir.as_ref().map(|d| d.join("mobile-web-dist")),
                exe_dir.as_ref().map(|d| d.join("../Resources/mobile-web-dist")),
                Some(std::path::PathBuf::from("mobile-web-dist")),
            ]
            .into_iter()
            .flatten()
            .find(|p| p.exists())
            .unwrap_or_else(|| std::path::PathBuf::from("mobile-web-dist"));

            let app = Router::new()
                .route("/", get(web_index))
                // Serve static assets from mobile-web-dist
                .nest_service("/assets", ServeDir::new(mobile_web_dir.join("assets")))
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
                .route("/api/sessions/:session_id/interrupt", axum::routing::post(api_interrupt_session))
                .route("/api/ws/:session_id", get(ws_handler))
                .route("/api/ws/status", get(ws_status_handler))
                .route("/api/ws/mobile", get(ws_mobile_handler))
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
            // Find mobile-web-dist directory for serving static assets
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()));

            let mobile_web_dir = [
                exe_dir.as_ref().map(|d| d.join("mobile-web-dist")),
                exe_dir.as_ref().map(|d| d.join("../Resources/mobile-web-dist")),
                Some(std::path::PathBuf::from("mobile-web-dist")),
            ]
            .into_iter()
            .flatten()
            .find(|p| p.exists())
            .unwrap_or_else(|| std::path::PathBuf::from("mobile-web-dist"));

            let app = Router::new()
                .route("/", get(web_index))
                // Serve static assets from mobile-web-dist
                .nest_service("/assets", tower_http::services::ServeDir::new(mobile_web_dir.join("assets")))
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
                .route("/api/sessions/:session_id/interrupt", axum::routing::post(api_interrupt_session))
                .route("/api/ws/:session_id", get(ws_handler))
                .route("/api/ws/status", get(ws_status_handler))
                .route("/api/ws/mobile", get(ws_mobile_handler))
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
            "browse_claude_sessions" => {
                let _ = app.emit("menu-event", "browse_claude_sessions");
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
            _ => {
                // Handle recently closed items (recent_0, recent_1, etc.)
                if id.starts_with("recent_") {
                    let _ = app.emit("menu-event", id);
                }
            }
        }
    });

    // Store AppHandle for web server to use
    {
        let mut handle = APP_HANDLE.lock();
        *handle = Some(app.handle().clone());
    }

    // Start web server for remote access
    start_web_server();

    // Clean up orphaned processes from previous app instance
    // We can't reattach to them (no stdin/stdout handles), so kill them
    std::thread::spawn(|| {
        cleanup_orphaned_processes();
    });

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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            interrupt_json_process,
            kill_json_process,
            load_sessions,
            save_session,
            delete_session,
            update_session_claude_id,
            get_home_dir,
            list_claude_sessions,
            load_claude_session_history,
            update_session_orders,
            save_recently_closed,
            get_recently_closed,
            delete_recently_closed,
            update_history_menu,
            save_terminal_buffer,
            load_terminal_buffer,
            delete_terminal_buffer,
            save_window_state,
            load_window_state,
            save_app_settings,
            load_app_settings,
            read_image_file,
            read_text_file,
            find_latest_plan_file,
            get_web_server_port,
            get_local_ips,
            mcp_callback,
            load_folders,
            save_folder,
            delete_folder,
            update_folder_orders,
            update_session_folder,
            toggle_folder_collapsed
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill all JSON processes on app exit
                let processes = JSON_PROCESSES.lock();
                for (session_id, process) in processes.iter() {
                    println!("Cleaning up process for session {}", session_id);
                    unsafe {
                        libc::kill(process.child_id as i32, libc::SIGTERM);
                    }
                }
                // Give processes a moment to terminate, then force kill
                std::thread::sleep(std::time::Duration::from_millis(200));
                for (_session_id, process) in processes.iter() {
                    unsafe {
                        libc::kill(process.child_id as i32, libc::SIGKILL);
                    }
                }
            }
        });
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
            list_claude_sessions,
            load_claude_session_history,
            update_session_orders,
            save_recently_closed,
            get_recently_closed,
            delete_recently_closed,
            update_history_menu,
            save_terminal_buffer,
            load_terminal_buffer,
            delete_terminal_buffer,
            save_window_state,
            load_window_state,
            save_app_settings,
            load_app_settings,
            read_image_file,
            read_text_file,
            find_latest_plan_file,
            get_web_server_port,
            get_local_ips,
            load_folders,
            save_folder,
            delete_folder,
            update_folder_orders,
            update_session_folder,
            toggle_folder_collapsed
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
