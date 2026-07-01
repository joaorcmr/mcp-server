"""LLM judge for *escalation correctness* — read a conversation and decide whether
the bot's escalate / don't-escalate decision was right.

Two distinct judgements, one per universe:

  * ``judge_escalated``      — the bot handed off to a human. Was that justified?
  * ``judge_not_escalated``  — the bot never escalated. Should it have?

Both use the official OpenAI SDK with Structured Outputs (``strict: true``) so the
verdict is schema-validated. The default model is the latest flagship
``gpt-5.5-2026-04-23``; the GPT-5 family takes ``max_completion_tokens`` (not
``max_tokens``) and rejects a custom ``temperature``, so the call is built for that
contract with a one-shot fallback to the legacy parameter for older models.

This module is standalone: it does NOT modify ``llm_judge.py`` (only borrows its
``make_client``). Rubric is grounded in CHECKLIST.md and bot/agentes..md.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

import botpress_api
import scoring

DEFAULT_MODEL = "gpt-5.5-2026-04-23"

# Generous budget: reasoning models spend completion tokens on hidden reasoning
# before the JSON, so this must cover reasoning + the structured answer.
MAX_COMPLETION_TOKENS = 4000
MAX_TRANSCRIPT_MESSAGES = 80


def default_model() -> str:
    """Default judge model, overridable via OPENAI_MODEL in env/.env."""
    env = botpress_api.load_env()
    return os.environ.get("OPENAI_MODEL") or env.get("OPENAI_MODEL") or DEFAULT_MODEL


# --- shared rubric context --------------------------------------------------
_ESCALATION_TRIGGERS = """\
The "Omni Saúde / Vitta" WhatsApp bot (Portuguese) is a triage assistant that must
hand off to a human (HITL, via the n1 business-hours flow or the n2 box-limit/SLA
flow) ONLY for genuine escalations. Per the team's playbook (agentes..md), a human
handoff is warranted when:
  - the user directly asks to talk to an attendant/pharmacist/supervisor;
  - a purchase "inconsistência"/"bloqueio" needs an agent to investigate;
  - a medical prescription must be validated by a human (divergence/illegible);
  - the user is clearly frustrated/stressed and self-service is failing;
  - a documented protocol (bloqueio, reembolso dispute, etc.) mandates it.
Outside business hours the bot should NOT open a live handoff — it should send the
"Protocolo SEM Atendente" message (hours: Mon–Fri 9h–19h) and close.
A handoff is UNNECESSARY when the bot could have resolved it self-service: a simple
FAQ, info already in the knowledge base, or a premature escalation before trying."""

_ESCALATED_SYSTEM = f"""\
You are a meticulous QA reviewer. {_ESCALATION_TRIGGERS}

You are reviewing a conversation in which the bot ESCALATED to a human. Decide
whether that escalation was JUSTIFIED. Judge only the bot's decision; messages from
a human agent are not the bot. Base your verdict on actually reading the transcript;
the deterministic signals are only hints. Respond ONLY via the structured schema."""

_NOT_ESCALATED_SYSTEM = f"""\
You are a meticulous QA reviewer. {_ESCALATION_TRIGGERS}

You are reviewing a conversation in which the bot did NOT escalate to a human.
Decide (a) whether it SHOULD have escalated (a missed handoff the user needed), and
(b) what actually happened to the conversation (outcome_category). Judge only the
bot; base your verdict on reading the transcript. Respond ONLY via the structured
schema."""

_ESCALATED_SCHEMA = {
    "type": "object",
    "properties": {
        "escalation_justified": {
            "type": "boolean",
            "description": "True if handing off to a human was the right call.",
        },
        "justification_category": {
            "type": "string",
            "enum": [
                "direct_request",
                "data_inconsistency",
                "prescription_validation",
                "user_frustration",
                "complex_case",
                "other",
            ],
            "description": "Why the escalation was warranted (most fitting reason).",
        },
        "unnecessary_reason": {
            "type": ["string", "null"],
            "enum": ["bot_could_resolve", "simple_faq", "premature_escalation", "other", None],
            "description": "If NOT justified, why it was unnecessary; else null.",
        },
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "reasoning": {
            "type": "string",
            "description": "2-4 sentences citing concrete evidence from the transcript.",
        },
    },
    "required": [
        "escalation_justified",
        "justification_category",
        "unnecessary_reason",
        "confidence",
        "reasoning",
    ],
    "additionalProperties": False,
}

_NOT_ESCALATED_SCHEMA = {
    "type": "object",
    "properties": {
        "should_have_escalated": {
            "type": "boolean",
            "description": "True if the user needed a human and the bot wrongly did not escalate.",
        },
        "outcome_category": {
            "type": "string",
            "enum": [
                "resolved_satisfied",
                "outside_business_hours",
                "bot_deflected_no_resolution",
                "user_abandoned",
                "info_provided_no_human_needed",
                "other",
            ],
            "description": "What actually happened to the conversation.",
        },
        "user_sentiment": {
            "type": "string",
            "enum": ["positive", "neutral", "negative", "unknown"],
        },
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "reasoning": {
            "type": "string",
            "description": "2-4 sentences citing concrete evidence from the transcript.",
        },
    },
    "required": [
        "should_have_escalated",
        "outcome_category",
        "user_sentiment",
        "confidence",
        "reasoning",
    ],
    "additionalProperties": False,
}


def _render_transcript(
    messages: list[dict[str, Any]], wf_names: Optional[dict[str, str]] = None
) -> str:
    """Chronological transcript; «workflow» tags use readable names when known."""
    wf_names = wf_names or {}
    msgs = scoring._sorted_messages(messages)
    if len(msgs) > MAX_TRANSCRIPT_MESSAGES:
        head = msgs[: MAX_TRANSCRIPT_MESSAGES // 2]
        tail = msgs[-MAX_TRANSCRIPT_MESSAGES // 2 :]
        msgs = head + [{"_elided": len(msgs) - MAX_TRANSCRIPT_MESSAGES}] + tail
    lines: list[str] = []
    for m in msgs:
        if "_elided" in m:
            lines.append(f"... [{m['_elided']} messages elided] ...")
            continue
        who = "BOT" if m.get("direction") == "outgoing" else "USER"
        mtype = m.get("type", "text")
        text = (scoring._text(m) or "").strip()
        wf = scoring._origin_workflow(m)
        tag = f" «{wf_names.get(wf, wf)}»" if wf else ""
        type_tag = f" [{mtype}]" if mtype and mtype != "text" else ""
        lines.append(f"{who}{type_tag}{tag}: {text}")
    return "\n".join(lines)


def _signals(score: "scoring.ConversationScore", tier: str) -> str:
    return (
        f"Deterministic signals — escalated_tier={tier}, end_state={score.end_state}, "
        f"hitl_status={score.hitl_status}, message_count={score.message_count}, "
        f"failed_checks={', '.join(score.failed_checks) or 'none'}."
    )


def _call(
    client: Any,
    system: str,
    user_content: str,
    schema: dict[str, Any],
    schema_name: str,
    model: str,
    conv_id: str,
) -> Optional[dict[str, Any]]:
    """One structured-output call. Tries the GPT-5 param contract, falls back to
    the legacy ``max_tokens`` for older models. Returns the parsed dict or None."""
    response_format = {
        "type": "json_schema",
        "json_schema": {"name": schema_name, "strict": True, "schema": schema},
    }
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]
    for token_param in ("max_completion_tokens", "max_tokens"):
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=messages,
                response_format=response_format,
                **{token_param: MAX_COMPLETION_TOKENS},
            )
            msg = resp.choices[0].message
            if getattr(msg, "refusal", None):
                return None
            return json.loads(msg.content)
        except TypeError:
            continue  # SDK rejected the kwarg name; try the other one
        except Exception as exc:  # noqa: BLE001
            text = str(exc).lower()
            # A 400 about the token param means: retry with the other name.
            if token_param == "max_completion_tokens" and (
                "max_tokens" in text or "max_completion_tokens" in text
            ):
                continue
            print(f"  ! escalation judge failed for {conv_id}: {exc}", flush=True)
            return None
    return None


def judge_escalated(
    client: Any,
    conv: dict[str, Any],
    messages: list[dict[str, Any]],
    score: "scoring.ConversationScore",
    tier: str,
    model: str = DEFAULT_MODEL,
    wf_names: Optional[dict[str, str]] = None,
) -> Optional[dict[str, Any]]:
    user_content = (
        _signals(score, tier)
        + "\n\nTRANSCRIPT (chronological; «wf» = the bot workflow that produced "
        "the message):\n"
        + _render_transcript(messages, wf_names)
    )
    return _call(
        client,
        _ESCALATED_SYSTEM,
        user_content,
        _ESCALATED_SCHEMA,
        "escalation_verdict",
        model,
        conv.get("id", "?"),
    )


def judge_not_escalated(
    client: Any,
    conv: dict[str, Any],
    messages: list[dict[str, Any]],
    score: "scoring.ConversationScore",
    tier: str,
    model: str = DEFAULT_MODEL,
    wf_names: Optional[dict[str, str]] = None,
) -> Optional[dict[str, Any]]:
    user_content = (
        _signals(score, tier)
        + "\n\nTRANSCRIPT (chronological; «wf» = the bot workflow that produced "
        "the message):\n"
        + _render_transcript(messages, wf_names)
    )
    return _call(
        client,
        _NOT_ESCALATED_SYSTEM,
        user_content,
        _NOT_ESCALATED_SCHEMA,
        "non_escalation_verdict",
        model,
        conv.get("id", "?"),
    )
