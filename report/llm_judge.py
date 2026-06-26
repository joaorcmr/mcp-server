"""LLM judge — classify a conversation against CHECKLIST.md by reading it.

The deterministic scorer (scoring.py) keys on observable signals (origin tags,
end-state workflow, HITL state). It cannot tell whether the *user* was actually
helped — a flow can reach ``wf-conversation-end`` after a frustrated user gives
up. This module asks an LLM to read the transcript and the deterministic signals
and return a verdict + written rationale, using the same three axes as the
checklist as its rubric.

Uses the official OpenAI Python SDK (``openai``) with Structured Outputs so the
verdict is schema-validated. Model defaults to ``gpt-4o`` (override with
``--llm-model`` or ``OPENAI_MODEL``).
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

from openai import OpenAI

import botpress_api
import scoring

DEFAULT_MODEL = "gpt-4o"

# Condensed rubric — the three axes + triage from CHECKLIST.md. Kept as the
# system prompt so it's identical across every conversation call.
SYSTEM_PROMPT = """\
You are a meticulous QA reviewer for the "Omni Saúde" WhatsApp support bot
(Portuguese). You judge whether a single conversation was a good bot interaction,
using this rubric (from the team's CHECKLIST.md):

AXIS 1 — Tools/flows: the right workflow handled the request; data-lookup tools
returned real data (NOT the fallback "Não encontramos os seus dados"); no
error/fallback flow fired; no redundant loops (e.g. asking for the CPF twice).

AXIS 2 — Intent: the user's opening intent was routed to the matching flow, not
dropped to a generic "Como podemos te ajudar?" nor a wrong branch.

AXIS 3 — Resolution (the decisive axis): was the user's actual problem solved and
did they leave satisfied? A flow reaching its end node is NOT proof of resolution
— a frustrated user who gives up ("deixa pra lá") can still be walked into a
closing message. Watch for: abandonment/timeout, being parked in human handoff
(HITL) with no agent reply, the bot repeating itself, answers that are on-topic
but wrong, and the user's tone (gratitude vs frustration vs silence).

VERDICTS:
- GOOD: intent routed correctly, tools resolved real data, the user's problem was
  genuinely solved and they were served (explicit thanks or a clean close).
- SOFT_FAIL: handled reasonably but not clearly resolved — user abandoned/timed
  out, a slow-but-proper handoff, or no clear sign the problem was solved.
- HARD_FAIL: stuck/abandoned HITL, failed data lookup, error/wrong-intent
  routing, the bot stopped responding, or a clearly unhelped/frustrated user.

You are given deterministic signals (origin trace, end state, HITL status) as
hints, but base your verdict on actually reading the conversation. Judge the BOT's
performance only; messages from a human Zendesk agent are not the bot.
Respond ONLY via the structured schema."""

VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {
            "type": "string",
            "enum": [scoring.GOOD, scoring.SOFT_FAIL, scoring.HARD_FAIL],
        },
        "user_satisfied": {
            "type": "boolean",
            "description": "Did the user appear satisfied / get what they needed?",
        },
        "problem_resolved": {
            "type": "boolean",
            "description": "Was the user's actual underlying problem solved?",
        },
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "reasoning": {
            "type": "string",
            "description": "2-4 sentences citing concrete evidence from the transcript.",
        },
    },
    "required": ["verdict", "user_satisfied", "problem_resolved", "confidence", "reasoning"],
    "additionalProperties": False,
}

# Cap how much of a long transcript we send (keeps token cost bounded).
MAX_TRANSCRIPT_MESSAGES = 80


def make_client() -> OpenAI:
    """Construct an OpenAI client, reading OPENAI_API_KEY from env or .env."""
    env = botpress_api.load_env()
    key = os.environ.get("OPENAI_API_KEY") or env.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError(
            "OPENAI_API_KEY not set. Add it to the repo-root .env (see .env.example) "
            "to use --llm-judge."
        )
    base_url = os.environ.get("OPENAI_BASE_URL") or env.get("OPENAI_BASE_URL") or None
    return OpenAI(api_key=key, base_url=base_url)


def default_model() -> str:
    """Default model, overridable via OPENAI_MODEL in env/.env."""
    env = botpress_api.load_env()
    return os.environ.get("OPENAI_MODEL") or env.get("OPENAI_MODEL") or DEFAULT_MODEL


def _render_transcript(messages: list[dict[str, Any]]) -> str:
    msgs = scoring._sorted_messages(messages)
    if len(msgs) > MAX_TRANSCRIPT_MESSAGES:
        # Keep the head and tail — the opening intent and the resolution both matter.
        head = msgs[: MAX_TRANSCRIPT_MESSAGES // 2]
        tail = msgs[-MAX_TRANSCRIPT_MESSAGES // 2 :]
        msgs = head + [{"_elided": len(msgs) - MAX_TRANSCRIPT_MESSAGES}] + tail
    lines: list[str] = []
    for m in msgs:
        if "_elided" in m:
            lines.append(f"... [{m['_elided']} messages elided] ...")
            continue
        direction = m.get("direction", "?")
        who = "BOT" if direction == "outgoing" else "USER"
        mtype = m.get("type", "text")
        text = (scoring._text(m) or "").strip()
        wf = scoring._origin_workflow(m)
        tag = f" «{wf}»" if wf else ""
        type_tag = f" [{mtype}]" if mtype and mtype != "text" else ""
        lines.append(f"{who}{type_tag}{tag}: {text}")
    return "\n".join(lines)


def _signals(score: scoring.ConversationScore, handed_off: bool) -> str:
    return (
        f"Deterministic signals — end_state={score.end_state}, "
        f"hitl_status={score.hitl_status}, handed_off_to_human={handed_off}, "
        f"message_count={score.message_count}, "
        f"deterministic_verdict={score.verdict}, "
        f"failed_checks={', '.join(score.failed_checks) or 'none'}."
    )


def judge_conversation(
    client: OpenAI,
    conv: dict[str, Any],
    messages: list[dict[str, Any]],
    score: scoring.ConversationScore,
    handed_off: bool,
    model: str = DEFAULT_MODEL,
) -> Optional[dict[str, Any]]:
    """Return the parsed verdict dict, or None if the call/parse failed."""
    user_content = (
        _signals(score, handed_off)
        + "\n\nTRANSCRIPT (chronological; «wf» = the bot workflow that produced "
        "the message):\n"
        + _render_transcript(messages)
    )
    try:
        resp = client.chat.completions.create(
            model=model,
            max_tokens=1500,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "conversation_verdict",
                    "strict": True,
                    "schema": VERDICT_SCHEMA,
                },
            },
        )
        msg = resp.choices[0].message
        if getattr(msg, "refusal", None):
            return None
        return json.loads(msg.content)
    except Exception as exc:  # network, parse, schema — fall back to deterministic
        print(f"  ! llm judge failed for {conv.get('id')}: {exc}", flush=True)
        return None


def attach_verdict(score: scoring.ConversationScore, verdict: dict[str, Any]) -> None:
    """Copy a parsed verdict dict onto the score object in place."""
    score.llm_verdict = verdict.get("verdict")
    score.llm_reasoning = verdict.get("reasoning")
    score.llm_user_satisfied = verdict.get("user_satisfied")
    score.llm_problem_resolved = verdict.get("problem_resolved")
    score.llm_confidence = verdict.get("confidence")
