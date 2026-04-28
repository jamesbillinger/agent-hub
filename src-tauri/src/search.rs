// Search index for Agent Hub.
//
// Architecture: this module is a *wrapper* over Claude CLI's on-disk JSONL
// files (~/.claude/projects/...). We never duplicate message content —
// `message_index` rows store (file_path, file_offset, search_text), so a
// search hit can seek directly into the JSONL line for full rendering.
//
// `session_files` maps each JSONL file to one Agent Hub session. Resumes
// produce additional rows for the same session_id (many-to-one).
//
// Schema is version-pinned (`search_meta.schema_version`); a version bump
// drops + recreates the index tables and triggers a fresh backfill.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::Emitter;

/// Emit a Tauri event to any listeners (desktop UI). Mobile WS clients
/// don't get these events directly — the mobile Settings page is rare
/// enough that the simple "click Rebuild → wait" UX is acceptable for it.
fn emit_progress(payload: serde_json::Value) {
    if let Some(app) = crate::APP_HANDLE.lock().as_ref() {
        let _ = app.emit("search-progress", payload);
    }
}

const SCHEMA_VERSION: &str = "1";
const BATCH_SIZE: usize = 500;
const PARENT_WALK_LINES: usize = 200;
const PARENT_WALK_PASSES: u32 = 6;

// =====================================================================
//  Schema
// =====================================================================

/// Drop legacy or version-mismatched tables, then create the current
/// schema. Idempotent and safe to call on every startup.
pub fn run_search_migrations(conn: &Connection) {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS search_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )
    .expect("Failed to create search_meta");

    let stored: String = conn
        .query_row(
            "SELECT value FROM search_meta WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();

    if stored != SCHEMA_VERSION {
        // Either an older shape (e.g. earlier `messages`/`messages_fts`/
        // `jsonl_ingest` tables) or a future-format mismatch we can't
        // interpret. Drop everything we own and rebuild.
        conn.execute_batch(
            "DROP TABLE IF EXISTS message_index_fts;
             DROP TABLE IF EXISTS message_index;
             DROP TABLE IF EXISTS session_files;
             DROP TABLE IF EXISTS messages_fts;
             DROP TABLE IF EXISTS messages;
             DROP TABLE IF EXISTS jsonl_ingest;",
        )
        .ok();
    }

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS session_files (
            claude_session_id TEXT PRIMARY KEY,
            session_id        TEXT NOT NULL,
            file_path         TEXT NOT NULL,
            last_offset       INTEGER NOT NULL DEFAULT 0,
            last_mtime        INTEGER NOT NULL DEFAULT 0,
            last_size         INTEGER NOT NULL DEFAULT 0,
            last_uuid         TEXT,
            first_seen_at     INTEGER NOT NULL,
            completed_at      INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);

        CREATE TABLE IF NOT EXISTS message_index (
            id                INTEGER PRIMARY KEY,
            session_id        TEXT NOT NULL,
            claude_session_id TEXT NOT NULL,
            uuid              TEXT NOT NULL,
            file_path         TEXT NOT NULL,
            file_offset       INTEGER NOT NULL,
            role              TEXT NOT NULL,
            ts                INTEGER NOT NULL,
            search_text       TEXT NOT NULL DEFAULT '',
            UNIQUE(session_id, uuid)
        );
        CREATE INDEX IF NOT EXISTS idx_mi_session_ts ON message_index(session_id, ts);
        CREATE INDEX IF NOT EXISTS idx_mi_claude ON message_index(claude_session_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS message_index_fts USING fts5(
            search_text,
            content='message_index',
            content_rowid='id',
            tokenize='porter unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS mi_ai AFTER INSERT ON message_index
            WHEN new.search_text != ''
            BEGIN
                INSERT INTO message_index_fts(rowid, search_text)
                    VALUES (new.id, new.search_text);
            END;
        CREATE TRIGGER IF NOT EXISTS mi_ad AFTER DELETE ON message_index
            WHEN old.search_text != ''
            BEGIN
                INSERT INTO message_index_fts(message_index_fts, rowid, search_text)
                    VALUES('delete', old.id, old.search_text);
            END;
        CREATE TRIGGER IF NOT EXISTS mi_au AFTER UPDATE ON message_index BEGIN
            INSERT INTO message_index_fts(message_index_fts, rowid, search_text)
                SELECT 'delete', old.id, old.search_text WHERE old.search_text != '';
            INSERT INTO message_index_fts(rowid, search_text)
                SELECT new.id, new.search_text WHERE new.search_text != '';
        END;
        "#,
    )
    .expect("Failed to create search schema");

    // Forward-compatible column adds — silently no-ops once the column exists.
    let _ = conn.execute("ALTER TABLE session_files ADD COLUMN claude_home TEXT", []);

    conn.execute(
        "INSERT OR REPLACE INTO search_meta (key, value) VALUES ('schema_version', ?1)",
        [SCHEMA_VERSION],
    )
    .expect("Failed to write schema version");
}

// =====================================================================
//  Pure parser: JSONL line → IndexRow
// =====================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexRow {
    pub session_id: String,
    pub claude_session_id: String,
    pub uuid: String,
    pub file_path: String,
    pub file_offset: i64,
    pub role: String,
    pub ts: i64,
    pub search_text: String,
}

/// Parse a single JSONL line and produce zero or one `IndexRow`s.
/// Skipped: synthetic records (queue-operation, last-prompt, permission-mode,
/// file-history-snapshot), records missing a uuid, malformed JSON.
pub fn parse_jsonl_line(
    session_id: &str,
    claude_session_id: &str,
    file_path: &str,
    file_offset: i64,
    line: &str,
) -> Option<IndexRow> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(trimmed).ok()?;

    let role = match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
        "user" | "assistant" | "attachment" | "system" => v
            .get("type")
            .and_then(|x| x.as_str())
            .unwrap()
            .to_string(),
        _ => return None,
    };
    let uuid = v.get("uuid").and_then(|x| x.as_str()).filter(|s| !s.is_empty())?;
    let ts = v
        .get("timestamp")
        .and_then(|x| x.as_str())
        .and_then(parse_iso_to_millis)
        .unwrap_or(0);
    let search_text = extract_search_text(&role, &v);

    Some(IndexRow {
        session_id: session_id.to_string(),
        claude_session_id: claude_session_id.to_string(),
        uuid: uuid.to_string(),
        file_path: file_path.to_string(),
        file_offset,
        role,
        ts,
        search_text,
    })
}

fn extract_search_text(role: &str, v: &Value) -> String {
    match role {
        "user" => match v.pointer("/message/content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str())? == "text" {
                        b.get("text").and_then(|t| t.as_str()).map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        },
        "assistant" => match v.pointer("/message/content") {
            Some(Value::Array(arr)) => {
                let mut parts = Vec::new();
                for block in arr {
                    let bt = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    match bt {
                        "text" => {
                            if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                                parts.push(t.to_string());
                            }
                        }
                        "thinking" => {
                            if let Some(t) = block.get("thinking").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    parts.push(t.to_string());
                                }
                            }
                        }
                        "tool_use" => {
                            let name = block.get("name").and_then(|x| x.as_str()).unwrap_or("");
                            let input_str = block
                                .get("input")
                                .map(|i| serde_json::to_string(i).unwrap_or_default())
                                .unwrap_or_default();
                            let combined = format!("{} {}", name, input_str);
                            let combined = combined.trim();
                            if !combined.is_empty() {
                                parts.push(combined.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                parts.join("\n")
            }
            _ => String::new(),
        },
        "attachment" => v
            .pointer("/attachment/type")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_default(),
        "system" => v
            .get("content")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn parse_iso_to_millis(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

// =====================================================================
//  Backfill / linker / live ingest
// =====================================================================

#[derive(Debug, Default, Clone, Serialize)]
pub struct BackfillStats {
    pub files_scanned: u32,
    pub files_ingested: u32,
    pub files_skipped_unlinked: u32,
    pub files_skipped_uptodate: u32,
    pub rows_inserted: u64,
    pub errors: u32,
}

/// Resolve a single user-supplied Claude home (e.g. "~/.claude-work") to
/// its `<home>/projects` dir, with tilde expansion.
fn projects_dir_from_home(home: &str) -> Option<PathBuf> {
    let expanded = shellexpand::tilde(home).to_string();
    let p = PathBuf::from(expanded).join("projects");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// Each entry pairs a Claude home (the user-supplied value, e.g. "~/.claude")
/// with its resolved projects directory. We pass both around so the
/// `claude_home` column on session_files records provenance.
fn search_homes_from_settings() -> Vec<(String, PathBuf)> {
    let settings = crate::load_app_settings().unwrap_or_default();
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for home in &settings.claude_search_dirs {
        let trimmed = home.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(projects) = projects_dir_from_home(trimmed) {
            if seen.insert(projects.clone()) {
                out.push((trimmed.to_string(), projects));
            }
        }
    }
    if out.is_empty() {
        // Fallback if user blanked the list — always at least scan the default.
        if let Some(p) = dirs::home_dir().map(|h| h.join(".claude").join("projects")) {
            if p.is_dir() {
                out.push(("~/.claude".to_string(), p));
            }
        }
    }
    out
}

fn scan_all_jsonl_files() -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for (home, projects_root) in search_homes_from_settings() {
        let Ok(entries) = std::fs::read_dir(&projects_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let Ok(sub) = std::fs::read_dir(&p) else {
                continue;
            };
            for f in sub.flatten() {
                let fp = f.path();
                if fp.extension().map_or(false, |e| e == "jsonl") {
                    out.push((home.clone(), fp));
                }
            }
        }
    }
    out
}

fn lookup_session_by_claude_id(conn: &Connection, claude_session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM sessions WHERE claude_session_id = ?1",
        [claude_session_id],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// Read up to N parentUuids from the head of the file. No DB lock held.
fn collect_candidate_parent_uuids(path: &Path) -> Vec<String> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines().take(PARENT_WALK_LINES) {
        let Ok(line) = line else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(p) = v.get("parentUuid").and_then(|x| x.as_str()) {
            if !p.is_empty() {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// Find which existing session a parent uuid belongs to, via message_index.
fn lookup_session_by_parent_uuids(conn: &Connection, parents: &[String]) -> Option<String> {
    if parents.is_empty() {
        return None;
    }
    let placeholders = std::iter::repeat("?")
        .take(parents.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT session_id FROM message_index WHERE uuid IN ({}) LIMIT 1",
        placeholders
    );
    let mut stmt = conn.prepare(&sql).ok()?;
    let params_iter = parents.iter().map(|s| s as &dyn rusqlite::ToSql);
    stmt.query_row(rusqlite::params_from_iter(params_iter), |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

/// First-time backfill: skips immediately if `session_files` already has rows.
pub fn backfill_if_needed() -> BackfillStats {
    let already = {
        let conn = crate::DB_CONNECTION.lock();
        conn.query_row("SELECT COUNT(*) FROM session_files", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap_or(0)
            > 0
    };
    if already {
        return BackfillStats::default();
    }
    run_backfill()
}

/// Manual rebuild — wipes index + bookkeeping, then re-runs backfill.
pub fn rebuild_index() -> BackfillStats {
    {
        let conn = crate::DB_CONNECTION.lock();
        let _ = conn.execute("DELETE FROM message_index", []);
        let _ = conn.execute("DELETE FROM session_files", []);
    }
    run_backfill()
}

fn run_backfill() -> BackfillStats {
    let start = std::time::Instant::now();
    let mut stats = BackfillStats::default();
    let all_files = scan_all_jsonl_files();
    stats.files_scanned = all_files.len() as u32;
    let total = all_files.len();

    emit_progress(serde_json::json!({
        "phase": "start",
        "total": total,
    }));

    let mut unlinked: Vec<(String, PathBuf)> = Vec::new();
    for (i, (home, path)) in all_files.into_iter().enumerate() {
        let claude_session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let session_id = {
            let conn = crate::DB_CONNECTION.lock();
            lookup_session_by_claude_id(&conn, &claude_session_id)
        };
        match session_id {
            Some(sid) => ingest_one(&path, &sid, &claude_session_id, &home, &mut stats),
            None => unlinked.push((home, path)),
        }
        // Throttle: emit on every 5th file or whenever it's the first/last,
        // so a 1000-file rebuild doesn't fire 1000 events.
        if i == 0 || i == total - 1 || (i + 1) % 5 == 0 {
            emit_progress(serde_json::json!({
                "phase": "scanning",
                "scanned": i + 1,
                "total": total,
                "ingested": stats.files_ingested,
                "rows": stats.rows_inserted,
            }));
        }
    }

    // parentUuid chain walk for resumes.
    for _ in 0..PARENT_WALK_PASSES {
        if unlinked.is_empty() {
            break;
        }
        let pending = std::mem::take(&mut unlinked);
        let mut made_progress = false;
        for (home, path) in pending {
            let claude_session_id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let parents = collect_candidate_parent_uuids(&path);
            let session_id = {
                let conn = crate::DB_CONNECTION.lock();
                lookup_session_by_parent_uuids(&conn, &parents)
            };
            match session_id {
                Some(sid) => {
                    ingest_one(&path, &sid, &claude_session_id, &home, &mut stats);
                    made_progress = true;
                }
                None => unlinked.push((home, path)),
            }
        }
        if !made_progress {
            break;
        }
    }

    stats.files_skipped_unlinked = unlinked.len() as u32;
    eprintln!(
        "[search] backfill done in {:.1}s: scanned={} ingested={} rows={} unlinked={} uptodate={} errors={}",
        start.elapsed().as_secs_f64(),
        stats.files_scanned,
        stats.files_ingested,
        stats.rows_inserted,
        stats.files_skipped_unlinked,
        stats.files_skipped_uptodate,
        stats.errors,
    );
    emit_progress(serde_json::json!({
        "phase": "done",
        "scanned": stats.files_scanned,
        "ingested": stats.files_ingested,
        "rows": stats.rows_inserted,
        "unlinked": stats.files_skipped_unlinked,
        "elapsed_ms": start.elapsed().as_millis() as u64,
    }));
    stats
}

/// Re-stat every JSONL we've previously seen and re-ingest those whose
/// mtime/size has changed. Cheap when nothing has changed.
pub fn incremental_rescan() -> BackfillStats {
    let known: Vec<(String, String, String, i64, i64, Option<String>)> = {
        let conn = crate::DB_CONNECTION.lock();
        let mut stmt = match conn.prepare(
            "SELECT claude_session_id, session_id, file_path, last_mtime, last_size, claude_home FROM session_files",
        ) {
            Ok(s) => s,
            Err(_) => return BackfillStats::default(),
        };
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    };

    let mut stats = BackfillStats::default();
    for (claude_session_id, session_id, file_path, last_mtime, last_size, claude_home) in known {
        let path = PathBuf::from(&file_path);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue; // file vanished — leave bookkeeping alone
        };
        let size = meta.len() as i64;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0);
        if size == last_size && mtime == last_mtime {
            continue;
        }
        let home = claude_home.unwrap_or_else(|| "~/.claude".to_string());
        ingest_one(&path, &session_id, &claude_session_id, &home, &mut stats);
    }
    if stats.files_ingested > 0 || stats.rows_inserted > 0 {
        eprintln!(
            "[search] rescan: ingested={} rows={} errors={}",
            stats.files_ingested, stats.rows_inserted, stats.errors
        );
    }
    stats
}

/// End-of-turn hook: re-scan all JSONL files associated with `session_id`
/// and ingest any new bytes. Idempotent. Called from save_session_messages_to_db.
pub fn ingest_session_files(session_id: &str) {
    let files: Vec<(String, String, Option<String>)> = {
        let conn = crate::DB_CONNECTION.lock();
        let mut stmt = match conn.prepare(
            "SELECT claude_session_id, file_path, claude_home FROM session_files WHERE session_id = ?1",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        stmt.query_map([session_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    };

    // Find any JSONL the CLI created since last visit (e.g. --resume creates
    // a new file). For that we need to know which Claude home the session
    // writes into — derived from session.env_vars.CLAUDE_CONFIG_DIR or the
    // global app setting.
    if let Some((cwd, latest_claude_id, env_home)) = lookup_session_meta(session_id) {
        for home in candidate_homes_for_session(env_home.as_deref()) {
            if let Some(p) = jsonl_path_for(&home, &cwd, &latest_claude_id) {
                if p.exists() && !files.iter().any(|(cid, _, _)| cid == &latest_claude_id) {
                    let mut stats = BackfillStats::default();
                    ingest_one(&p, session_id, &latest_claude_id, &home, &mut stats);
                    break;
                }
            }
        }
    }

    let mut stats = BackfillStats::default();
    for (claude_session_id, file_path, claude_home) in files {
        let home = claude_home.unwrap_or_else(|| "~/.claude".to_string());
        ingest_one(&PathBuf::from(file_path), session_id, &claude_session_id, &home, &mut stats);
    }
}

/// Return cwd, claude_session_id, and CLAUDE_CONFIG_DIR override (parsed
/// from sessions.env_vars JSON, if present and not the "default" sentinel).
fn lookup_session_meta(session_id: &str) -> Option<(String, String, Option<String>)> {
    let conn = crate::DB_CONNECTION.lock();
    conn.query_row(
        "SELECT working_dir, claude_session_id, env_vars FROM sessions WHERE id = ?1",
        [session_id],
        |r| {
            let wd: String = r.get(0)?;
            let csid: Option<String> = r.get(1)?;
            let env_json: Option<String> = r.get(2)?;
            Ok((wd, csid, env_json))
        },
    )
    .ok()
    .and_then(|(wd, csid, env_json)| {
        let env_home = env_json
            .as_deref()
            .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
            .and_then(|v| {
                v.get("CLAUDE_CONFIG_DIR")
                    .and_then(|x| x.as_str())
                    .map(String::from)
            })
            .filter(|s| !s.is_empty() && s != "default");
        csid.map(|c| (wd, c, env_home))
    })
}

/// If the session has a CLAUDE_CONFIG_DIR override, try that home first
/// (most likely correct). Otherwise iterate the configured search dirs.
fn candidate_homes_for_session(env_home: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(h) = env_home {
        out.push(h.to_string());
    }
    for (h, _) in search_homes_from_settings() {
        if !out.iter().any(|x| x == &h) {
            out.push(h);
        }
    }
    out
}

fn jsonl_path_for(home: &str, working_dir: &str, claude_session_id: &str) -> Option<PathBuf> {
    let projects = projects_dir_from_home(home)?;
    let folder = working_dir
        .replace('/', "-")
        .trim_start_matches('-')
        .to_string();
    Some(
        projects
            .join(format!("-{}", folder))
            .join(format!("{}.jsonl", claude_session_id)),
    )
}

fn ingest_one(
    path: &Path,
    session_id: &str,
    claude_session_id: &str,
    claude_home: &str,
    stats: &mut BackfillStats,
) {
    match ingest_file(path, session_id, claude_session_id, claude_home) {
        Ok(IngestOutcome::UpToDate) => stats.files_skipped_uptodate += 1,
        Ok(IngestOutcome::Ingested(n)) => {
            stats.files_ingested += 1;
            stats.rows_inserted += n;
        }
        Err(e) => {
            eprintln!("[search] ingest error {:?}: {}", path, e);
            stats.errors += 1;
        }
    }
}

enum IngestOutcome {
    UpToDate,
    Ingested(u64),
}

fn ingest_file(
    path: &Path,
    session_id: &str,
    claude_session_id: &str,
    claude_home: &str,
) -> std::io::Result<IngestOutcome> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len() as i64;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0);
    let path_str = path.to_string_lossy().to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();

    let (start_offset, first_seen_at, prior_completed) = {
        let conn = crate::DB_CONNECTION.lock();
        let prev: Option<(i64, i64, i64, i64, Option<i64>)> = conn
            .query_row(
                "SELECT last_offset, last_size, last_mtime, first_seen_at, completed_at
                 FROM session_files WHERE claude_session_id = ?1",
                [claude_session_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .ok();
        match prev {
            Some((last_offset, last_size, last_mtime, first_seen, completed)) => {
                if completed.is_some() && last_size == size && last_mtime == mtime {
                    return Ok(IngestOutcome::UpToDate);
                }
                let resume = if size < last_offset { 0 } else { last_offset };
                (resume, first_seen, completed.is_some())
            }
            None => (0, now_ms, false),
        }
    };
    let _ = prior_completed;

    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start_offset as u64))?;
    let mut reader = BufReader::new(file);

    let mut offset = start_offset;
    let mut rows_inserted_total = 0u64;
    let mut pending: Vec<IndexRow> = Vec::with_capacity(BATCH_SIZE);
    let mut last_uuid: Option<String> = None;
    let mut buf = String::new();

    loop {
        buf.clear();
        let line_offset = offset;
        let n = reader.read_line(&mut buf)?;
        if n == 0 {
            break;
        }
        if !buf.ends_with('\n') {
            // Partial write in progress — don't advance past it.
            break;
        }
        if let Some(row) = parse_jsonl_line(session_id, claude_session_id, &path_str, line_offset, &buf) {
            last_uuid = Some(row.uuid.clone());
            pending.push(row);
        }
        offset += n as i64;

        if pending.len() >= BATCH_SIZE {
            rows_inserted_total += flush_batch(
                &pending,
                &path_str,
                claude_session_id,
                session_id,
                claude_home,
                offset,
                &last_uuid,
                mtime,
                size,
                first_seen_at,
                None,
            );
            pending.clear();
        }
    }

    rows_inserted_total += flush_batch(
        &pending,
        &path_str,
        claude_session_id,
        session_id,
        claude_home,
        offset,
        &last_uuid,
        mtime,
        size,
        first_seen_at,
        Some(now_ms),
    );

    Ok(IngestOutcome::Ingested(rows_inserted_total))
}

fn flush_batch(
    rows: &[IndexRow],
    path: &str,
    claude_session_id: &str,
    session_id: &str,
    claude_home: &str,
    offset: i64,
    last_uuid: &Option<String>,
    mtime: i64,
    size: i64,
    first_seen_at: i64,
    completed_at: Option<i64>,
) -> u64 {
    let mut conn = crate::DB_CONNECTION.lock();
    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[search] tx: {}", e);
            return 0;
        }
    };
    let mut n = 0u64;
    {
        let mut insert = match tx.prepare_cached(
            "INSERT OR IGNORE INTO message_index
             (session_id, claude_session_id, uuid, file_path, file_offset, role, ts, search_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[search] prepare insert: {}", e);
                return 0;
            }
        };
        for row in rows {
            match insert.execute(params![
                row.session_id,
                row.claude_session_id,
                row.uuid,
                row.file_path,
                row.file_offset,
                row.role,
                row.ts,
                row.search_text,
            ]) {
                Ok(changed) => n += changed as u64,
                Err(e) => eprintln!("[search] insert: {}", e),
            }
        }
    }
    {
        let mut upsert = match tx.prepare_cached(
            "INSERT INTO session_files
             (claude_session_id, session_id, file_path, last_offset, last_mtime, last_size, last_uuid, first_seen_at, completed_at, claude_home)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(claude_session_id) DO UPDATE SET
                session_id    = excluded.session_id,
                file_path     = excluded.file_path,
                last_offset   = excluded.last_offset,
                last_mtime    = excluded.last_mtime,
                last_size     = excluded.last_size,
                last_uuid     = excluded.last_uuid,
                completed_at  = excluded.completed_at,
                claude_home   = excluded.claude_home",
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[search] prepare upsert: {}", e);
                return n;
            }
        };
        let _ = upsert.execute(params![
            claude_session_id,
            session_id,
            path,
            offset,
            mtime,
            size,
            last_uuid,
            first_seen_at,
            completed_at,
            claude_home,
        ]);
    }
    if let Err(e) = tx.commit() {
        eprintln!("[search] commit: {}", e);
    }
    n
}

// =====================================================================
//  Orphan import
// =====================================================================

#[derive(Debug, Clone, Serialize)]
pub struct OrphanJsonl {
    pub file_path: String,
    pub claude_session_id: String,
    pub claude_home: String,
    pub cwd: Option<String>,
    pub first_message_preview: Option<String>,
    pub message_count: u32,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct ImportStats {
    pub considered: u32,
    pub imported: u32,
    pub skipped: u32,
    pub folder_id: Option<String>,
    pub backfill: BackfillStats,
}

/// JSONL files we know about that aren't linked to a session yet.
pub fn list_orphan_jsonls() -> Vec<OrphanJsonl> {
    let known: std::collections::HashSet<String> = {
        let conn = crate::DB_CONNECTION.lock();
        let mut stmt = match conn.prepare("SELECT file_path FROM session_files") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    };

    let mut out = Vec::new();
    for (home, path) in scan_all_jsonl_files() {
        let path_str = path.to_string_lossy().to_string();
        if known.contains(&path_str) {
            continue;
        }
        if let Some(info) = inspect_jsonl_for_orphan(&path, &home) {
            out.push(info);
        }
    }
    // Most-recent-first for the UI.
    out.sort_by(|a, b| b.last_ts.cmp(&a.last_ts));
    out
}

fn inspect_jsonl_for_orphan(path: &Path, home: &str) -> Option<OrphanJsonl> {
    let claude_session_id = path.file_stem()?.to_str()?.to_string();
    let file_path = path.to_string_lossy().to_string();
    let f = File::open(path).ok()?;
    let reader = BufReader::new(f);

    let mut cwd: Option<String> = None;
    let mut first_user_text: Option<String> = None;
    let mut count: u32 = 0;
    let mut first_ts: Option<i64> = None;
    let mut last_ts: Option<i64> = None;

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if cwd.is_none() {
            cwd = v.get("cwd").and_then(|x| x.as_str()).map(String::from);
        }
        if let Some(ts) = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .and_then(parse_iso_to_millis)
        {
            if first_ts.is_none() {
                first_ts = Some(ts);
            }
            last_ts = Some(ts);
        }

        if v.get("type").and_then(|t| t.as_str()) == Some("user")
            && v.get("uuid").is_some()
        {
            count += 1;
            if first_user_text.is_none() {
                first_user_text = extract_first_user_text(&v);
            }
        }
    }

    Some(OrphanJsonl {
        file_path,
        claude_session_id,
        claude_home: home.to_string(),
        cwd,
        first_message_preview: first_user_text,
        message_count: count,
        first_ts,
        last_ts,
    })
}

/// Pull the first paragraph of a user message — used as the imported
/// session's name. Trimmed to ~60 chars.
fn extract_first_user_text(v: &Value) -> Option<String> {
    let text = match v.pointer("/message/content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .find_map(|b| {
                if b.get("type").and_then(|t| t.as_str())? == "text" {
                    b.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None
                }
            })
            .unwrap_or_default(),
        _ => return None,
    };
    let first_line = text.lines().next().unwrap_or(&text).trim().to_string();
    if first_line.is_empty() {
        return None;
    }
    let truncated: String = first_line.chars().take(60).collect();
    Some(if truncated.len() < first_line.len() {
        format!("{}…", truncated)
    } else {
        truncated
    })
}

/// Import every orphan JSONL as a new claude-json session in a folder
/// named "IMPORTED" (created if missing, collapsed by default), then
/// re-run backfill so the newly-linked files get indexed.
pub fn import_orphans() -> ImportStats {
    let mut stats = ImportStats::default();
    let orphans = list_orphan_jsonls();
    stats.considered = orphans.len() as u32;
    if orphans.is_empty() {
        return stats;
    }

    let folder_id = ensure_imported_folder();
    stats.folder_id = Some(folder_id.clone());
    let now_iso = chrono::Utc::now().to_rfc3339();
    let cmd = "claude --print --verbose --input-format stream-json --output-format stream-json --dangerously-skip-permissions";

    {
        let conn = crate::DB_CONNECTION.lock();
        for orphan in &orphans {
            // Don't re-import if a session already exists with this claude_id.
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM sessions WHERE claude_session_id = ?1 LIMIT 1",
                    [&orphan.claude_session_id],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if exists {
                stats.skipped += 1;
                continue;
            }

            let session_id = uuid::Uuid::new_v4().to_string();
            let name = orphan
                .first_message_preview
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| match orphan.first_ts {
                    Some(ts) => format!(
                        "Imported {}",
                        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts)
                            .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                            .unwrap_or_else(|| "session".into())
                    ),
                    None => "Imported session".into(),
                });
            let working_dir = orphan
                .cwd
                .clone()
                .unwrap_or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "/".into()));
            let created_at = orphan
                .first_ts
                .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| now_iso.clone());

            // Imported sessions from a non-default Claude home need
            // CLAUDE_CONFIG_DIR set so resume goes to the right place.
            let env_vars: Option<String> = if orphan.claude_home != "~/.claude" {
                Some(format!(
                    r#"{{"CLAUDE_CONFIG_DIR":"{}"}}"#,
                    orphan.claude_home.replace('"', "\\\"")
                ))
            } else {
                None
            };
            let res = conn.execute(
                "INSERT INTO sessions
                  (id, name, agent_type, command, working_dir, created_at,
                   claude_session_id, sort_order, folder_id, env_vars)
                 VALUES (?1, ?2, 'claude-json', ?3, ?4, ?5, ?6, 99999, ?7, ?8)",
                params![
                    session_id,
                    name,
                    cmd,
                    working_dir,
                    created_at,
                    orphan.claude_session_id,
                    folder_id,
                    env_vars
                ],
            );
            if res.is_ok() {
                stats.imported += 1;
            } else {
                stats.skipped += 1;
            }
        }
    }

    // Now that sessions exist, re-run backfill — direct claude_session_id
    // match in pass 1 will link every file we just inserted.
    stats.backfill = run_backfill();
    stats
}

fn ensure_imported_folder() -> String {
    let conn = crate::DB_CONNECTION.lock();
    if let Ok(id) = conn.query_row(
        "SELECT id FROM folders WHERE name = 'IMPORTED' LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    ) {
        return id;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = conn.execute(
        "INSERT INTO folders (id, name, sort_order, collapsed) VALUES (?1, 'IMPORTED', 99999, 1)",
        params![id],
    );
    id
}

// =====================================================================
//  Cleanup + stats
// =====================================================================

/// Cascade-delete index data when an Agent Hub session is removed.
pub fn delete_search_data_for_session(conn: &Connection, session_id: &str) {
    if let Err(e) = conn.execute(
        "DELETE FROM message_index WHERE session_id = ?1",
        [session_id],
    ) {
        eprintln!("[search] delete message_index: {}", e);
    }
    if let Err(e) = conn.execute(
        "DELETE FROM session_files WHERE session_id = ?1",
        [session_id],
    ) {
        eprintln!("[search] delete session_files: {}", e);
    }
}

#[derive(Debug, Serialize)]
pub struct SearchStats {
    pub schema_version: String,
    pub indexed_files: i64,
    pub indexed_messages: i64,
    pub last_completed_ms: Option<i64>,
    /// JSONL files on disk that aren't linked to any session yet.
    /// Surfaced so the UI can offer an "Import" action.
    pub unlinked_files: i64,
}

pub fn get_stats() -> SearchStats {
    let (indexed_files, indexed_messages, last_completed_ms) = {
        let conn = crate::DB_CONNECTION.lock();
        let f: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_files", [], |r| r.get(0))
            .unwrap_or(0);
        let m: i64 = conn
            .query_row("SELECT COUNT(*) FROM message_index", [], |r| r.get(0))
            .unwrap_or(0);
        let l: Option<i64> = conn
            .query_row(
                "SELECT MAX(completed_at) FROM session_files WHERE completed_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        (f, m, l)
    };
    // Counting orphans does no DB work — just a directory scan + set diff.
    let unlinked_files = list_orphan_jsonls().len() as i64;
    SearchStats {
        schema_version: SCHEMA_VERSION.to_string(),
        indexed_files,
        indexed_messages,
        last_completed_ms,
        unlinked_files,
    }
}

// =====================================================================
//  Search query
// =====================================================================

#[derive(Debug, Default, Deserialize)]
pub struct SearchFilters {
    pub session_id: Option<String>,
    pub role: Option<String>,
    pub from_ts: Option<i64>,
    pub to_ts: Option<i64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub message_id: i64,
    pub session_id: String,
    pub session_name: Option<String>,
    pub claude_session_id: String,
    pub uuid: String,
    pub file_path: String,
    pub file_offset: i64,
    pub role: String,
    pub ts: i64,
    pub snippet: String,
    pub rank: f64,
}

/// Sanitize an FTS5 query: split on whitespace, wrap each token in double
/// quotes (treating any embedded quotes as literal), join with AND.
fn sanitize_fts_query(raw: &str) -> String {
    raw.split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

pub fn search_messages(query: &str, filters: SearchFilters) -> Result<Vec<SearchHit>, String> {
    let q = sanitize_fts_query(query);
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = filters.limit.unwrap_or(50).min(500) as i64;
    let offset = filters.offset.unwrap_or(0) as i64;

    let conn = crate::DB_CONNECTION.lock();
    let mut stmt = conn
        .prepare(
            "SELECT mi.id, mi.session_id, s.name, mi.claude_session_id, mi.uuid,
                    mi.file_path, mi.file_offset, mi.role, mi.ts,
                    snippet(message_index_fts, 0, '<mark>', '</mark>', '…', 16) AS snip,
                    bm25(message_index_fts) AS rank
             FROM message_index_fts
             JOIN message_index mi ON mi.id = message_index_fts.rowid
             LEFT JOIN sessions s   ON s.id = mi.session_id
             WHERE message_index_fts MATCH ?1
               AND (?2 IS NULL OR mi.session_id = ?2)
               AND (?3 IS NULL OR mi.role = ?3)
               AND (?4 IS NULL OR mi.ts >= ?4)
               AND (?5 IS NULL OR mi.ts <= ?5)
             ORDER BY rank
             LIMIT ?6 OFFSET ?7",
        )
        .map_err(|e| e.to_string())?;

    let hits: Vec<SearchHit> = stmt
        .query_map(
            params![
                q,
                filters.session_id,
                filters.role,
                filters.from_ts,
                filters.to_ts,
                limit,
                offset,
            ],
            |r| {
                Ok(SearchHit {
                    message_id: r.get(0)?,
                    session_id: r.get(1)?,
                    session_name: r.get(2)?,
                    claude_session_id: r.get(3)?,
                    uuid: r.get(4)?,
                    file_path: r.get(5)?,
                    file_offset: r.get(6)?,
                    role: r.get(7)?,
                    ts: r.get(8)?,
                    snippet: r.get(9)?,
                    rank: r.get(10)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(hits)
}

// =====================================================================
//  Tests
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn line(json: &str) -> Option<IndexRow> {
        parse_jsonl_line("hub-sess-1", "claude-sess-1", "/path/to.jsonl", 0, json)
    }

    #[test]
    fn skips_synthetic_records() {
        assert!(line(r#"{"type":"queue-operation","content":"hi"}"#).is_none());
        assert!(line(r#"{"type":"last-prompt","lastPrompt":"hi"}"#).is_none());
        assert!(line(r#"{"type":"permission-mode","permissionMode":"x"}"#).is_none());
        assert!(line(r#"{"type":"file-history-snapshot","messageId":"x"}"#).is_none());
    }

    #[test]
    fn skips_invalid_or_missing_uuid() {
        assert!(line(r#"not json"#).is_none());
        assert!(line(r#"{"type":"user","message":{"content":"hi"}}"#).is_none()); // no uuid
        assert!(line("").is_none());
    }

    #[test]
    fn user_string_content() {
        let r = line(
            r#"{"type":"user","uuid":"u1","timestamp":"2026-04-20T10:00:00.000Z",
                "message":{"role":"user","content":"hello there"}}"#,
        )
        .unwrap();
        assert_eq!(r.role, "user");
        assert_eq!(r.search_text, "hello there");
        assert_eq!(r.uuid, "u1");
        assert_eq!(r.ts, 1776679200000);
    }

    #[test]
    fn user_tool_result_skipped_in_search_text() {
        let r = line(
            r#"{"type":"user","uuid":"u2","timestamp":"2026-04-20T10:00:00Z",
                "message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"big blob"}]}}"#,
        )
        .unwrap();
        assert_eq!(r.role, "user");
        assert_eq!(r.search_text, ""); // tool_result body excluded
    }

    #[test]
    fn assistant_text_block() {
        let r = line(
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-04-20T10:00:00Z",
                "message":{"content":[{"type":"text","text":"sure thing"}]}}"#,
        )
        .unwrap();
        assert_eq!(r.search_text, "sure thing");
    }

    #[test]
    fn assistant_mixed_blocks_join() {
        let r = line(
            r#"{"type":"assistant","uuid":"a2","timestamp":"2026-04-20T10:00:00Z",
                "message":{"content":[
                    {"type":"thinking","thinking":"pondering..."},
                    {"type":"text","text":"the answer is 42"},
                    {"type":"tool_use","name":"Grep","input":{"pattern":"foo"}}
                ]}}"#,
        )
        .unwrap();
        assert!(r.search_text.contains("pondering"));
        assert!(r.search_text.contains("the answer is 42"));
        assert!(r.search_text.contains("Grep"));
        assert!(r.search_text.contains("foo"));
    }

    #[test]
    fn assistant_empty_thinking_skipped() {
        let r = line(
            r#"{"type":"assistant","uuid":"a3","timestamp":"2026-04-20T10:00:00Z",
                "message":{"content":[
                    {"type":"thinking","thinking":""},
                    {"type":"text","text":"actual answer"}
                ]}}"#,
        )
        .unwrap();
        assert_eq!(r.search_text, "actual answer");
    }

    #[test]
    fn attachment_metadata_only() {
        let r = line(
            r#"{"type":"attachment","uuid":"att1","timestamp":"2026-04-20T10:00:00Z",
                "attachment":{"type":"skill_listing","content":"... massive ..."}}"#,
        )
        .unwrap();
        assert_eq!(r.role, "attachment");
        assert_eq!(r.search_text, "skill_listing");
    }

    #[test]
    fn system_indexes_content() {
        let r = line(
            r#"{"type":"system","uuid":"s1","timestamp":"2026-04-20T10:00:00Z",
                "subtype":"away_summary","content":"summary text"}"#,
        )
        .unwrap();
        assert_eq!(r.role, "system");
        assert_eq!(r.search_text, "summary text");
    }

    #[test]
    fn missing_timestamp_yields_zero() {
        let r = line(r#"{"type":"user","uuid":"u9","message":{"content":"x"}}"#).unwrap();
        assert_eq!(r.ts, 0);
    }

    #[test]
    fn file_path_and_offset_passthrough() {
        let r = parse_jsonl_line(
            "S",
            "C",
            "/some/path.jsonl",
            12345,
            r#"{"type":"user","uuid":"u","timestamp":"2026-04-20T10:00:00Z","message":{"content":"x"}}"#,
        )
        .unwrap();
        assert_eq!(r.file_path, "/some/path.jsonl");
        assert_eq!(r.file_offset, 12345);
    }

    #[test]
    fn fts_query_sanitizer_basics() {
        assert_eq!(sanitize_fts_query("foo"), r#""foo""#);
        assert_eq!(sanitize_fts_query("foo bar"), r#""foo" AND "bar""#);
        assert_eq!(sanitize_fts_query(""), "");
        assert_eq!(sanitize_fts_query("   "), "");
        // FTS5 special chars become literal via double-quote wrap
        assert_eq!(sanitize_fts_query("foo*"), r#""foo*""#);
        // Embedded double quotes get doubled
        assert_eq!(sanitize_fts_query(r#"a"b"#), r#""a""b""#);
    }
}
