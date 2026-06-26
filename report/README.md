# Quality of Bot — PDF report

Generates a PDF that combines the **quantitative** Botpress Analytics KPIs (the
same data as the dashboard) with a **qualitative** conversation-resolution score
derived deterministically from [`../CHECKLIST.md`](../CHECKLIST.md). The goal is
to judge bot quality by *numbers from the checklist* instead of subjective taste.

## What it contains

1. **Summary** — headline KPIs (messages, sessions, new/returning users, LLM
   cost) next to the quality score (% GOOD / SOFT FAIL / HARD FAIL, resolution
   rate) and a verdict pie.
2. **Analytics charts** — messages, sessions/users and LLM cost per day.
3. **Quality breakdown** — which checklist signals fail most often.
4. **Per-conversation table** — every scored conversation, worst first, with its
   verdict, end state, HITL status and top failed checks.
5. **Methodology** — how each verdict maps back to the CHECKLIST.md axes.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r report/requirements.txt
```

It reads the **same `.env`** as the MCP server (repo root): `BOTPRESS_TOKEN`,
`BOTPRESS_BOT_ID`, `BOTPRESS_WORKSPACE_ID` (and optional `BOTPRESS_API_BASE_URL`).
No extra config needed.

## Run

```bash
# Last 7 days (matches the dashboard default)
python report/generate_report.py --days 7

# Explicit window
python report/generate_report.py --start 2026-06-18T00:00:00Z --end 2026-06-25T00:00:00Z

# Larger window, cap message-fetch cost, custom output
python report/generate_report.py --days 30 --max-conversations 500 --out quality.pdf
```

Output defaults to `report/bot-quality-report.pdf`.

| Flag | Default | Meaning |
|------|---------|---------|
| `--days N` | 7 | Window size; ignored if `--start` is given |
| `--start` / `--end` | — / now | Explicit ISO 8601 window |
| `--max-conversations N` | 200 | Cap on conversations scored (each one fetches its messages + HITL state) |
| `--out PATH` | `report/bot-quality-report.pdf` | Output file |

## Files

- `botpress_api.py` — stdlib (urllib) REST client: analytics, conversations,
  messages, HITL state.
- `scoring.py` — CHECKLIST.md → verdict. **Tune the constants at the top**
  (`WF_MAIN`, `WF_CONVERSATION_END`, `WF_TIMEOUT`, `WF_ERROR`, the fallback/
  generic-help text, `TRAILING_INCOMING_THRESHOLD`) if the bot's workflow names
  or copy change.
- `generate_report.py` — CLI, fetch pipeline and PDF rendering.

## Scope: which conversations are scored

A HITL handoff spawns a **second, mirror conversation on the human-agent side**
(Zendesk integration, `channel: hitl`). Its messages are the agent's replies and
carry no workflow `origin` tag, so scoring them as the bot would mark every
handoff as a total failure. The report therefore scores **only customer-facing
bot conversations** (`scoring.is_bot_conversation`) and reports the agent-side
ones separately as *handoffs to human* / *agent-side convs skipped*.

## Caveats

The scoring is a **deterministic approximation** of human review: it keys on the
observable signals the checklist calls out (origin tags, end-state workflows,
HITL state, message direction, fallback text). It does not use an LLM judge. A
conversation that resolved without ever hitting `wf-conversation-end` is counted
as a SOFT FAIL (no explicit resolution signal) — adjust the constants/logic in
`scoring.py` if your flows signal completion differently.
