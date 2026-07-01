# Reports

Two PDF reports share the same `.env`, REST client (`botpress_api.py`) and
`scoring.py` helpers:

- **`generate_report.py`** — overall bot quality (GOOD / SOFT_FAIL / HARD_FAIL),
  documented below.
- **`escalation_report.py`** — escalation correctness (escalated vs not), below.

---

## Escalation report (`escalation_report.py`)

Splits a sample of conversations into **two universes** and uses an OpenAI judge
to grade the bot's escalate / don't-escalate decision:

1. **Escalated to a human** (n1 = business hours, n2 = box-limit/SLA) — what %
   was escalated **correctly** (with 2 examples) vs **unnecessarily** (2 examples).
2. **Not escalated** — what actually happened (resolved & satisfied, outside
   business hours, abandoned, …, with 5 diverse examples) and what %
   **should have escalated but didn't** vs what % **correctly did not**.

```bash
python report/escalation_report.py --days 7                  # full sample (cap 400)
python report/escalation_report.py --days 7 --sample-size 25 # small real run
python report/escalation_report.py --days 7 --sample-size 20 --no-llm  # free segmentation test
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--days N` | 7 | Window size; ignored if `--start` is given |
| `--start` / `--end` | — / now | Explicit ISO 8601 window |
| `--sample-size N` | 400 | Cap on customer-facing bot conversations analyzed |
| `--llm-model NAME` | `gpt-5.5-2026-04-23` | Judge model (or set `OPENAI_MODEL`) |
| `--no-llm` | off | Segment escalated/not + tier only, no judge (free) |
| `--out PATH` | `report/escalation-report.pdf` | Output file |

- **Escalation detection** keys on the authoritative `hitl#downstream` tag (plus an
  active `hitl#hitl` state); agent-side Zendesk mirror conversations are excluded
  (`scoring.is_bot_conversation`). The **n1/n2 tier** is best-effort from the names
  of workflows the conversation traversed (`bot/bot.json`), so many escalations are
  tier *unknown* — this does not affect the escalated/not split or the verdict.
- **Judge** (`escalation_judge.py`) reads each transcript with OpenAI Structured
  Outputs; one call per conversation. Needs `OPENAI_API_KEY`. Uses the GPT-5
  `max_completion_tokens` contract with a fallback to legacy `max_tokens`.

---

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
| `--llm-judge` | off | Add an OpenAI LLM judge that reads each transcript (see below) |
| `--llm-model NAME` | `gpt-4o` | Override the judge model (or set `OPENAI_MODEL`) |

## Optional: LLM judge (`--llm-judge`)

The deterministic scorer keys on signals — it counts a conversation GOOD when the
flow reaches `wf-conversation-end`. But a flow reaching its end node is **not**
proof the user was helped: a frustrated user who gives up can still be walked into
the closing message. The LLM judge **reads the transcript** (plus the
deterministic signals) and decides whether the user's actual problem was solved
and whether they left satisfied, using `CHECKLIST.md` as its rubric.

```bash
# Needs OPENAI_API_KEY in the repo-root .env
python report/generate_report.py --days 7 --llm-judge
python report/generate_report.py --days 7 --llm-judge --llm-model gpt-4o-mini
```

- **Opt-in and non-destructive.** Deterministic scoring always runs; the LLM
  verdict overlays it. When `--llm-judge` is on, the headline verdicts and the
  per-conversation table use the LLM's call, the `det` column shows the
  deterministic letter (G/S/H) so divergences are visible, and the summary page
  reports the **LLM↔heuristic agreement** rate. If a call fails, that
  conversation falls back to the deterministic verdict.
- **Cost & reproducibility.** One API call per scored conversation — roughly a
  dollar or two per ~60 conversations on `gpt-4o`, less on `gpt-4o-mini`. Unlike
  the heuristic, LLM verdicts are not byte-reproducible across runs.
- **Config.** `OPENAI_API_KEY` (required), optional `OPENAI_MODEL` and
  `OPENAI_BASE_URL` (for an OpenAI-compatible endpoint), all read from the
  repo-root `.env`. Install the SDK with the same `pip install -r
  report/requirements.txt`.

## Files

- `botpress_api.py` — stdlib (urllib) REST client: analytics, conversations,
  messages, HITL state.
- `scoring.py` — CHECKLIST.md → deterministic verdict. **Tune the constants at
  the top** (`WF_MAIN`, `WF_CONVERSATION_END`, `WF_TIMEOUT`, `WF_ERROR`, the
  fallback/generic-help text, `TRAILING_INCOMING_THRESHOLD`) if the bot's
  workflow names or copy change.
- `llm_judge.py` — optional OpenAI judge (rubric prompt + structured-output
  verdict). Only imported when `--llm-judge` is used.
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
