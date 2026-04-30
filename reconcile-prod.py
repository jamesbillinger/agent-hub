#!/usr/bin/env python3
"""
One-shot reconciliation: link stranded Agent Hub sessions to their on-disk
JSONLs by scoring (cwd, created_at, name <-> first user message) over all
configured Claude home directories. Backs up the prod DB first, then writes
inside a single transaction. Prints a report.

Run with: python3 reconcile-prod.py
After it finishes:
  1. Quit Agent Hub.
  2. Reopen it.
  3. Settings -> Search Index -> Rebuild Index.
"""

import datetime as dt
import glob
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path.home() / 'Library/Application Support/agent-hub/sessions.db'
CFG_PATH = Path.home() / 'Library/Application Support/agent-hub/config.json'
DEFAULT_HOMES = ['~/.claude']

MIN_MATCH_SCORE = 50           # below this, treat as unrelated
DELETE_UNMATCHED_STRANDED = True  # remove session rows we couldn't link


def expand(p: str) -> str:
    return os.path.expanduser(p)


def parse_iso_to_ms(s):
    if not s:
        return None
    try:
        return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)
    except Exception:
        return None


def get_search_homes():
    if CFG_PATH.exists():
        try:
            cfg = json.loads(CFG_PATH.read_text())
            homes = cfg.get('claude_search_dirs')
            if homes:
                return homes
        except Exception:
            pass
    return DEFAULT_HOMES


def inspect_jsonl(path: str, home: str):
    """Return cwd, first_ts (ms), first user message preview."""
    cwd = None
    first_ts = None
    first_msg = None
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f):
                if i > 200:
                    break
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if cwd is None and o.get('cwd'):
                    cwd = o['cwd']
                if first_ts is None and o.get('timestamp'):
                    first_ts = parse_iso_to_ms(o['timestamp'])
                if first_msg is None and o.get('type') == 'user' and 'uuid' in o:
                    msg = o.get('message', {}) or {}
                    c = msg.get('content', '')
                    if isinstance(c, str):
                        first_msg = c.strip()
                    elif isinstance(c, list):
                        for blk in c:
                            if isinstance(blk, dict) and blk.get('type') == 'text':
                                first_msg = (blk.get('text') or '').strip()
                                if first_msg:
                                    break
                if cwd and first_ts and first_msg:
                    break
    except Exception as e:
        print(f"  [warn] could not inspect {path}: {e}", file=sys.stderr)
    return cwd, first_ts, (first_msg[:200] if first_msg else None)


def score_pair(session, jsonl):
    """Return (score, reasons[])."""
    s = 0
    reasons = []
    sw = expand(session['working_dir'] or '')
    jcwd = jsonl.get('cwd')
    if jcwd:
        jcwd_e = expand(jcwd)
        if jcwd_e == sw and sw:
            s += 120
            reasons.append('cwd matches')
        elif sw and (jcwd_e.startswith(sw) or sw.startswith(jcwd_e)):
            s += 60
            reasons.append('cwd prefix matches')

    s_ts = parse_iso_to_ms(session.get('created_at'))
    j_ts = jsonl.get('first_ts')
    if s_ts and j_ts:
        diff = abs(s_ts - j_ts)
        if diff < 60 * 60 * 1000:
            s += 40
            reasons.append('within 1 hour')
        elif diff < 24 * 60 * 60 * 1000:
            s += 20
            reasons.append('within 1 day')
        elif diff < 30 * 24 * 60 * 60 * 1000:
            s += 5

    name = (session.get('name') or '').lower()
    msg = (jsonl.get('first_msg') or '').lower()
    if len(name) > 3 and name in msg:
        s += 25
        reasons.append('name appears in first message')
    prefix = (jsonl.get('first_msg') or '')[:30].strip().lower()
    if len(prefix) > 4 and prefix in name:
        s += 25
        reasons.append('first message appears in name')

    return s, reasons


def main():
    if not DB_PATH.exists():
        print(f"prod DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    homes = get_search_homes()
    print(f"Claude home dirs: {homes}")

    # 1) Backup
    stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = DB_PATH.with_suffix(DB_PATH.suffix + f'.bak-{stamp}')
    shutil.copy(DB_PATH, backup)
    # WAL/SHM (best effort — may not exist)
    for ext in ('-wal', '-shm'):
        side = Path(str(DB_PATH) + ext)
        if side.exists():
            shutil.copy(side, str(backup) + ext)
    print(f"Backed up DB to: {backup}")

    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row

    # 2) Stranded sessions
    stranded = [
        dict(r) for r in con.execute("""
            SELECT id, name, working_dir, created_at, claude_session_id, agent_type, env_vars
            FROM sessions
            WHERE agent_type IN ('claude-json','claude')
              AND (claude_session_id IS NULL
                   OR claude_session_id = ''
                   OR claude_session_id NOT IN (SELECT claude_session_id FROM session_files))
        """)
    ]
    print(f"Stranded sessions: {len(stranded)}")

    # 3) Orphan JSONLs
    linked = {r[0] for r in con.execute("SELECT claude_session_id FROM session_files")}
    orphans = []
    for home in homes:
        for path in glob.glob(os.path.join(expand(home), 'projects', '*', '*.jsonl')):
            stem = os.path.splitext(os.path.basename(path))[0]
            if stem in linked:
                continue
            cwd, first_ts, first_msg = inspect_jsonl(path, home)
            orphans.append({
                'claude_home': home,
                'claude_session_id': stem,
                'path': path,
                'cwd': cwd,
                'first_ts': first_ts,
                'first_msg': first_msg,
            })
    print(f"Orphan JSONLs: {len(orphans)}")

    # 4) Score & greedy assign
    candidates = []
    for s in stranded:
        for j in orphans:
            sc, rs = score_pair(s, j)
            if sc >= MIN_MATCH_SCORE:
                candidates.append((sc, rs, s, j))
    candidates.sort(key=lambda c: -c[0])

    used_s, used_j = set(), set()
    matches = []
    for sc, rs, s, j in candidates:
        if s['id'] in used_s or j['claude_session_id'] in used_j:
            continue
        matches.append((sc, rs, s, j))
        used_s.add(s['id'])
        used_j.add(j['claude_session_id'])

    unmatched_sessions = [s for s in stranded if s['id'] not in used_s]
    unmatched_jsonls = [j for j in orphans if j['claude_session_id'] not in used_j]

    # 5) Apply (single transaction)
    print()
    print(f"=== Proposed actions ===")
    print(f"  link        : {len(matches)} stranded sessions -> JSONLs")
    print(f"  delete      : {len(unmatched_sessions)} stranded sessions with no JSONL")
    print(f"  leave alone : {len(unmatched_jsonls)} unlinked JSONLs (will show up in Settings as Unlinked, you can Import them later)")
    print()
    print("Examples (top 10 matches):")
    for sc, rs, s, j in matches[:10]:
        msg_preview = (j.get('first_msg') or '')[:70].replace('\n', ' ')
        print(f"  [{sc}] {s['name'][:40]:40s} <- {j['claude_session_id'][:8]}  ({', '.join(rs)})")
        print(f"       cwd={(j.get('cwd') or '?')[:60]}   msg={msg_preview!r}")

    # Apply
    cur = con.cursor()
    try:
        for sc, rs, s, j in matches:
            cur.execute(
                "UPDATE sessions SET claude_session_id = ? WHERE id = ?",
                (j['claude_session_id'], s['id'])
            )
            if j['claude_home'] != '~/.claude':
                # Only set CLAUDE_CONFIG_DIR if the session has no env_vars yet
                # (avoids stomping on user customizations).
                existing = s.get('env_vars') or ''
                if not existing or existing.strip() in ('', '{}'):
                    env_json = json.dumps({'CLAUDE_CONFIG_DIR': j['claude_home']})
                    cur.execute(
                        "UPDATE sessions SET env_vars = ? WHERE id = ?",
                        (env_json, s['id'])
                    )
        if DELETE_UNMATCHED_STRANDED:
            for s in unmatched_sessions:
                cur.execute("DELETE FROM sessions WHERE id = ?", (s['id'],))
                # Also clean up any search index data (orphan rows from older
                # backfills, if any).
                cur.execute("DELETE FROM session_files WHERE session_id = ?", (s['id'],))
                cur.execute("DELETE FROM message_index WHERE session_id = ?", (s['id'],))
        con.commit()
    except Exception as e:
        con.rollback()
        print(f"FAILED, rolled back: {e}", file=sys.stderr)
        sys.exit(2)
    finally:
        con.close()

    print()
    print(f"=== Done ===")
    print(f"  Linked  : {len(matches)}")
    if DELETE_UNMATCHED_STRANDED:
        print(f"  Deleted : {len(unmatched_sessions)}")
    print(f"  DB backup: {backup}")
    print()
    print("Next steps:")
    print("  1) Quit Agent Hub.app and relaunch it.")
    print("  2) Settings -> Search Index -> Rebuild Index.")
    print("     (Backfill will pick up the newly-linked JSONLs in pass 1.)")


if __name__ == '__main__':
    main()
