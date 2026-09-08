#!/usr/bin/env python3
"""
Recovery script to re-link agent-hub sessions to their Claude session files.
Matches by: project directory, timestamp proximity, and first user message.

Usage:
  python3 recover-sessions.py          # Dry run (show matches)
  python3 recover-sessions.py --apply  # Apply matches to database
"""

import json
import os
import sys
import glob
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.expanduser("~/Library/Application Support/agent-hub/sessions.db")
CLAUDE_DIRS = [
    os.path.expanduser("~/.claude"),
    os.path.expanduser("~/.claude-work"),
]

# Map working_dir to Claude project directory name
def working_dir_to_project(working_dir):
    """Convert ~/dev/pplsi to -Users-jamesbillinger-dev-pplsi"""
    expanded = os.path.expanduser(working_dir)
    return expanded.replace("/", "-")

def parse_timestamp(ts):
    """Parse ISO timestamp string to datetime"""
    try:
        # Handle both Z and +00:00 suffix
        ts = ts.replace("Z", "+00:00")
        return datetime.fromisoformat(ts)
    except:
        return None

def get_claude_sessions():
    """Extract first message info from all Claude session .jsonl files"""
    sessions = []
    for config_dir in CLAUDE_DIRS:
        projects_dir = os.path.join(config_dir, "projects")
        if not os.path.exists(projects_dir):
            continue
        for project_dir in glob.glob(os.path.join(projects_dir, "*")):
            project_name = os.path.basename(project_dir)
            for jsonl_file in glob.glob(os.path.join(project_dir, "*.jsonl")):
                session_id = os.path.basename(jsonl_file).replace(".jsonl", "")
                try:
                    with open(jsonl_file, "r") as f:
                        first_line = f.readline().strip()
                        if first_line:
                            data = json.loads(first_line)
                            sessions.append({
                                "claude_session_id": session_id,
                                "config_dir": config_dir,
                                "project": project_name,
                                "timestamp": data.get("timestamp", ""),
                                "first_content": (data.get("content") or "")[:200],
                                "file_size": os.path.getsize(jsonl_file),
                            })
                except Exception:
                    pass
    return sessions

def get_agent_hub_sessions():
    """Get agent-hub sessions that are missing their Claude session ID"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.execute("""
        SELECT id, name, agent_type, working_dir, created_at, claude_session_id
        FROM sessions
        WHERE agent_type IN ('claude-json', 'claude')
        AND (claude_session_id IS NULL OR claude_session_id = '')
        ORDER BY created_at DESC
    """)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def get_already_linked():
    """Get Claude session IDs that are already linked to an agent-hub session"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.execute("""
        SELECT claude_session_id FROM sessions
        WHERE claude_session_id IS NOT NULL AND claude_session_id != ''
    """)
    linked = {row[0] for row in cursor.fetchall()}
    conn.close()
    return linked

def match_sessions(hub_sessions, claude_sessions, already_linked):
    """Match agent-hub sessions to Claude sessions by project and timestamp"""
    matches = []
    used_claude_ids = set(already_linked)

    for hub in hub_sessions:
        hub_project = working_dir_to_project(hub["working_dir"] or "~/dev/pplsi")
        hub_time = parse_timestamp(hub["created_at"])
        if not hub_time:
            continue

        # Find Claude sessions in the same project, within a reasonable time window
        candidates = []
        for cs in claude_sessions:
            if cs["claude_session_id"] in used_claude_ids:
                continue
            if cs["project"] != hub_project:
                continue
            cs_time = parse_timestamp(cs["timestamp"])
            if not cs_time:
                continue
            # Allow up to 5 minutes between agent-hub creation and first Claude message
            delta = abs((cs_time - hub_time).total_seconds())
            if delta < 600:  # 10 minutes
                candidates.append((delta, cs))

        if candidates:
            # Pick the closest match by timestamp
            candidates.sort(key=lambda x: x[0])
            best_delta, best_match = candidates[0]
            matches.append({
                "hub_id": hub["id"],
                "hub_name": hub["name"],
                "hub_created": hub["created_at"],
                "claude_session_id": best_match["claude_session_id"],
                "claude_timestamp": best_match["timestamp"],
                "config_dir": best_match["config_dir"],
                "delta_seconds": round(best_delta, 1),
                "first_content": best_match["first_content"][:80],
                "file_size": best_match["file_size"],
            })
            used_claude_ids.add(best_match["claude_session_id"])

    return matches

def apply_matches(matches):
    """Write matched Claude session IDs back to the agent-hub database"""
    conn = sqlite3.connect(DB_PATH)
    for m in matches:
        conn.execute(
            "UPDATE sessions SET claude_session_id = ? WHERE id = ?",
            (m["claude_session_id"], m["hub_id"]),
        )
    conn.commit()
    conn.close()

def main():
    dry_run = "--apply" not in sys.argv

    print("Loading Claude session files...")
    claude_sessions = get_claude_sessions()
    print(f"  Found {len(claude_sessions)} Claude session files")

    print("Loading agent-hub sessions missing Claude IDs...")
    hub_sessions = get_agent_hub_sessions()
    print(f"  Found {len(hub_sessions)} sessions without Claude session IDs")

    already_linked = get_already_linked()
    print(f"  {len(already_linked)} sessions already linked")

    print("\nMatching sessions by project directory and timestamp...")
    matches = match_sessions(hub_sessions, claude_sessions, already_linked)
    print(f"  Found {len(matches)} matches\n")

    if not matches:
        print("No matches found.")
        return

    print(f"{'Hub Session':<35} {'Claude ID':<40} {'Delta':>6}  {'Size':>8}  First Message")
    print("-" * 140)
    for m in matches:
        size_kb = m["file_size"] // 1024
        print(f"{m['hub_name']:<35} {m['claude_session_id']:<40} {m['delta_seconds']:>5.1f}s  {size_kb:>6}KB  {m['first_content'][:40]}")

    unmatched = len(hub_sessions) - len(matches)
    if unmatched > 0:
        print(f"\n  {unmatched} sessions could not be matched (may have been from a different project dir or too old)")

    if dry_run:
        print(f"\nDry run complete. Run with --apply to update the database.")
    else:
        print(f"\nApplying {len(matches)} matches to database...")
        apply_matches(matches)
        print("Done! Restart agent-hub to see the restored sessions.")

if __name__ == "__main__":
    main()
