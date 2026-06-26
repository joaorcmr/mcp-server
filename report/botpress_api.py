"""Minimal Botpress REST client over the Python standard library.

No third-party HTTP dependency: uses urllib so the report can run anywhere the
MCP server already runs. Reads the SAME credentials as the MCP server from the
repo-root ``.env`` (``BOTPRESS_TOKEN``, ``BOTPRESS_BOT_ID``,
``BOTPRESS_WORKSPACE_ID``, optional ``BOTPRESS_API_BASE_URL``).

Endpoints used (verified against @botpress/client):
  - GET /v1/admin/bots/{botId}/analytics        -> getBotAnalytics
  - GET /v1/chat/conversations                  -> listConversations
  - GET /v1/chat/messages                        -> listMessages
  - GET /v1/chat/states/{type}/{id}/{name}       -> getState (name "hitl#hitl")

Auth headers mirror the SDK: ``Authorization: Bearer <PAT>``, ``x-bot-id`` and
``x-workspace-id``.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterator, Optional

DEFAULT_API_BASE_URL = "https://api.botpress.cloud"
# Name of the HITL pause state, namespaced by the `hitl` plugin. The `#` must be
# URL-encoded to `%23` in the REST path. Mirrors HITL_STATE_NAME in
# src/botpress/management-client.ts.
HITL_STATE_NAME = "hitl#hitl"


def _repo_root() -> Path:
    """Repo root = parent of this report/ folder."""
    return Path(__file__).resolve().parent.parent


def load_env(env_path: Optional[Path] = None) -> dict[str, str]:
    """Read a ``KEY=VALUE`` .env file into a dict (no python-dotenv dependency).

    Real OS environment variables take precedence over the file, so the report
    can also be driven purely from the environment in CI.
    """
    env: dict[str, str] = {}
    path = env_path or (_repo_root() / ".env")
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                env[key] = value
    # OS env overrides file values.
    for key in (
        "BOTPRESS_TOKEN",
        "BOTPRESS_BOT_ID",
        "BOTPRESS_WORKSPACE_ID",
        "BOTPRESS_API_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
        "OPENAI_BASE_URL",
    ):
        if os.environ.get(key):
            env[key] = os.environ[key].strip()
    return env


class BotpressError(RuntimeError):
    """Raised when the Botpress API returns a non-2xx response."""


class BotpressClient:
    """Thin read-only client for the handful of endpoints the report needs."""

    def __init__(self, env: Optional[dict[str, str]] = None):
        env = env or load_env()
        missing = [
            k
            for k in ("BOTPRESS_TOKEN", "BOTPRESS_BOT_ID", "BOTPRESS_WORKSPACE_ID")
            if not env.get(k)
        ]
        if missing:
            raise BotpressError(
                "Missing required env var(s): "
                + ", ".join(missing)
                + ". Set them in the repo-root .env (see .env.example)."
            )
        self.token = env["BOTPRESS_TOKEN"]
        self.bot_id = env["BOTPRESS_BOT_ID"]
        self.workspace_id = env["BOTPRESS_WORKSPACE_ID"]
        self.base_url = (env.get("BOTPRESS_API_BASE_URL") or DEFAULT_API_BASE_URL).rstrip("/")

    # -- low-level ---------------------------------------------------------
    def _get(self, path: str, query: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        url = self.base_url + path
        if query:
            params = {k: v for k, v in query.items() if v is not None}
            if params:
                url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, method="GET")
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("x-bot-id", self.bot_id)
        req.add_header("x-workspace-id", self.workspace_id)
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:  # 4xx/5xx
            body = exc.read().decode("utf-8", "replace")
            raise BotpressError(f"GET {path} -> HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:
            raise BotpressError(f"GET {path} failed: {exc.reason}") from exc

    # -- analytics ---------------------------------------------------------
    def get_analytics(self, start_date: str, end_date: str) -> list[dict[str, Any]]:
        """GET /v1/admin/bots/{botId}/analytics — daily metric buckets."""
        path = f"/v1/admin/bots/{urllib.parse.quote(self.bot_id, safe='')}/analytics"
        res = self._get(path, {"startDate": start_date, "endDate": end_date})
        return res.get("records", [])

    # -- conversations -----------------------------------------------------
    def iter_conversations(
        self,
        after_date: Optional[str] = None,
        before_date: Optional[str] = None,
        page_size: int = 100,
        max_items: Optional[int] = None,
    ) -> Iterator[dict[str, Any]]:
        """Yield conversations (newest first) within the window, auto-paginating."""
        next_token: Optional[str] = None
        yielded = 0
        while True:
            res = self._get(
                "/v1/chat/conversations",
                {
                    "afterDate": after_date,
                    "beforeDate": before_date,
                    "pageSize": page_size,
                    "sortField": "createdAt",
                    "sortDirection": "desc",
                    "nextToken": next_token,
                },
            )
            for conv in res.get("conversations", []):
                yield conv
                yielded += 1
                if max_items is not None and yielded >= max_items:
                    return
            next_token = (res.get("meta") or {}).get("nextToken")
            if not next_token:
                return

    # -- messages ----------------------------------------------------------
    def list_all_messages(self, conversation_id: str, page_size: int = 100) -> list[dict[str, Any]]:
        """All messages for a conversation (newest first), auto-paginated."""
        messages: list[dict[str, Any]] = []
        next_token: Optional[str] = None
        while True:
            res = self._get(
                "/v1/chat/messages",
                {
                    "conversationId": conversation_id,
                    "pageSize": page_size,
                    "nextToken": next_token,
                },
            )
            messages.extend(res.get("messages", []))
            next_token = (res.get("meta") or {}).get("nextToken")
            if not next_token:
                break
        return messages

    # -- state -------------------------------------------------------------
    def get_hitl_state(self, conversation_id: str) -> Optional[dict[str, Any]]:
        """Return the hitl#hitl state payload (e.g. {"hitlActive": true}) or None.

        A 404 means the conversation never entered HITL, which we treat as "no
        HITL" rather than an error.
        """
        path = (
            "/v1/chat/states/conversation/"
            + urllib.parse.quote(conversation_id, safe="")
            + "/"
            + urllib.parse.quote(HITL_STATE_NAME, safe="")
        )
        try:
            res = self._get(path)
        except BotpressError as exc:
            if "HTTP 404" in str(exc):
                return None
            raise
        return (res.get("state") or {}).get("payload")
