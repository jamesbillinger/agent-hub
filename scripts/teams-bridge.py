#!/usr/bin/env python3
"""
Teams → Agent Hub bridge

Power Automate POSTs a webhook here when a new issue lands in the Teams
support channel. The bridge creates a claude-json session in Agent Hub and
sends the issue with a research/assign prompt.

Dependencies:
    pip install websockets requests

Environment variables:
    AGENT_HUB_PIN      PIN configured in Agent Hub settings (required)
    AGENT_HUB_PORT     Port of the dev app (default: 3857)
    WORKING_DIR        Working dir for new sessions (default: ~/dev/pplsi)
    LISTEN_HOST        Host to bind (default: 127.0.0.1; use 0.0.0.0 to accept
                       external connections if you expose the port directly)
    LISTEN_PORT        Port this server listens on (default: 8765)
    WEBHOOK_SECRET     Optional shared secret — Power Automate sends it as
                       X-Webhook-Secret header; requests without it are 401'd

Power Automate setup:
    Trigger:  "When a new message is added to a channel"
    Action:   "HTTP" — POST to your public URL with body:
              {
                "from":    "@{triggerBody()?['body']?['from']?['displayName']}",
                "message": "@{triggerBody()?['body']?['content']}",
                "link":    "@{triggerBody()?['webUrl']}"
              }
    If using WEBHOOK_SECRET, add header:
              X-Webhook-Secret: <your-secret>

Routing options (both assume you already have a public domain):
    A) Reverse proxy path — add to your nginx/caddy/etc config:
          location /webhook/teams {
              proxy_pass http://127.0.0.1:8765;
          }
       Then Power Automate posts to https://agent.billinger.me/webhook/teams

    B) Direct port — set LISTEN_HOST=0.0.0.0, open the port in your firewall,
       and Power Automate posts to https://agent.billinger.me:8765
"""

import asyncio
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import requests
import websockets

AGENT_HUB_PORT = int(os.getenv("AGENT_HUB_PORT", "3857"))
BASE_URL        = f"http://localhost:{AGENT_HUB_PORT}"
WS_BASE         = f"ws://localhost:{AGENT_HUB_PORT}"
PIN             = os.getenv("AGENT_HUB_PIN", "")
WORKING_DIR     = os.getenv("WORKING_DIR", os.path.expanduser("~/dev/pplsi"))
LISTEN_HOST     = os.getenv("LISTEN_HOST", "127.0.0.1")
LISTEN_PORT     = int(os.getenv("LISTEN_PORT", "8765"))
WEBHOOK_SECRET  = os.getenv("WEBHOOK_SECRET", "")
TOKEN_FILE      = os.path.expanduser("~/.agent-hub-bridge-token")

PROMPT_TEMPLATE = """\
New issue from Teams support channel.

From: {from_name}
{link_line}
---
{message}
---

Please research this issue:
1. Check relevant code, recent deploys, and known bugs for context
2. Determine the right team/person to assign it to
3. Use /jira to create a ticket with a clear summary, steps to reproduce, and your findings
4. Post a brief summary of what you found and why you assigned it that way
"""


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def get_token() -> str:
    if os.path.exists(TOKEN_FILE):
        token = open(TOKEN_FILE).read().strip()
        try:
            r = requests.get(
                f"{BASE_URL}/api/auth/check",
                headers={"Authorization": f"Bearer {token}"},
                timeout=5,
            )
            if r.status_code == 200 and r.json().get("authenticated"):
                return token
        except requests.RequestException:
            pass

    if not PIN:
        raise RuntimeError("AGENT_HUB_PIN env var not set")

    r = requests.post(
        f"{BASE_URL}/api/auth/pin-login",
        json={"pin": PIN, "device_name": "teams-bridge"},
        timeout=5,
    )
    r.raise_for_status()
    token = r.json()["token"]
    with open(TOKEN_FILE, "w") as f:
        f.write(token)
    os.chmod(TOKEN_FILE, 0o600)
    return token


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

def create_session(token: str, name: str) -> str:
    r = requests.post(
        f"{BASE_URL}/api/sessions",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "agent_type": "claude-json",
            "name": name,
            "working_dir": WORKING_DIR,
        },
        timeout=10,
    )
    r.raise_for_status()
    return r.json()["id"]


def start_session(token: str, session_id: str) -> None:
    r = requests.post(
        f"{BASE_URL}/api/sessions/{session_id}/start",
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    r.raise_for_status()


async def _send_over_ws(token: str, session_id: str, text: str) -> None:
    uri = f"{WS_BASE}/api/ws/{session_id}"
    headers = {"Authorization": f"Bearer {token}"}
    async with websockets.connect(uri, additional_headers=headers) as ws:
        await ws.send(text)
        await asyncio.sleep(1)


def send_message(token: str, session_id: str, text: str) -> None:
    asyncio.run(_send_over_ws(token, session_id, text))


# ---------------------------------------------------------------------------
# Issue handler
# ---------------------------------------------------------------------------

def handle_issue(payload: dict) -> None:
    try:
        token     = get_token()
        from_name = payload.get("from", "Unknown").strip()
        message   = payload.get("message", "").strip()
        link      = payload.get("link", "").strip()

        short = message[:50] + ("…" if len(message) > 50 else "")
        name  = f"Issue: {short}"

        session_id = create_session(token, name)
        start_session(token, session_id)
        time.sleep(2)  # Give the claude process a moment to boot

        prompt = PROMPT_TEMPLATE.format(
            from_name=from_name,
            message=message,
            link_line=f"Link:  {link}" if link else "",
        )
        send_message(token, session_id, prompt)
        print(f"[bridge] Created session {session_id}: {short}")
    except Exception as e:
        print(f"[bridge] ERROR handling issue: {e}")


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class WebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length)

        if WEBHOOK_SECRET:
            provided = self.headers.get("X-Webhook-Secret", "")
            if provided != WEBHOOK_SECRET:
                self.send_response(401)
                self.end_headers()
                return

        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

        try:
            payload = json.loads(body)
        except Exception:
            payload = {"message": body.decode(errors="replace")}

        Thread(target=handle_issue, args=(payload,), daemon=True).start()

    def log_message(self, fmt, *args):
        print(f"[http] {fmt % args}")


# ---------------------------------------------------------------------------
# Startup check + main
# ---------------------------------------------------------------------------

def main():
    print(f"[bridge] Checking Agent Hub on port {AGENT_HUB_PORT}…")
    try:
        token = get_token()
        print(f"[bridge] Authenticated OK (token saved to {TOKEN_FILE})")
    except Exception as e:
        print(f"[bridge] FATAL: {e}")
        raise SystemExit(1)

    server = HTTPServer((LISTEN_HOST, LISTEN_PORT), WebhookHandler)
    print(f"[bridge] Listening on http://{LISTEN_HOST}:{LISTEN_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
