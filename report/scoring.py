"""Turn CHECKLIST.md into numbers.

Given a conversation, its messages and its HITL state, compute a deterministic
quality verdict (GOOD / SOFT_FAIL / HARD_FAIL) plus the individual checklist
signals that drove it. The heuristics map directly onto the three axes and the
triage rubric in CHECKLIST.md; every threshold/keyword is a module-level
constant so it is easy to tune for a different bot.

These are approximations of human review, grounded in the observable signals the
checklist calls out (origin tags, end-state workflows, HITL state, message
direction sequences, fallback text). They are intentionally conservative: when a
signal is absent we pass the check rather than guess.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

# --- Tunable constants (workflow names confirmed in bot/bot.json) -----------
WF_MAIN = "wf-main"
WF_CONVERSATION_END = "wf-conversation-end"
WF_TIMEOUT = "wf-timeout"
WF_ERROR = "wf-error"

# Text fingerprints (substring match, case-insensitive).
FALLBACK_DATA_NOT_FOUND = "não encontramos os seus dados"
GENERIC_HELP = "como podemos te ajudar"

# A trailing run of this many incoming messages with no bot reply = "the bot
# stopped responding" (classic stuck fingerprint, CHECKLIST Axis 3).
TRAILING_INCOMING_THRESHOLD = 2

# Conversation tag set by the HITL plugin when a handoff was properly closed.
HITL_END_REASON_TAG = "hitl#hitlEndReason"

ORIGIN_RE = re.compile(r"workflow://([^/]+)/node/([^/]+)")

# Verdict labels.
GOOD = "GOOD"
SOFT_FAIL = "SOFT_FAIL"
HARD_FAIL = "HARD_FAIL"

# Axis labels (for aggregation / charts).
AXIS_TOOLS = "Axis 1 — Tools/flows"
AXIS_INTENT = "Axis 2 — Intent"
AXIS_RESOLUTION = "Axis 3 — Resolution"


@dataclass
class CheckResult:
    name: str
    axis: str
    passed: bool
    detail: str = ""


@dataclass
class ConversationScore:
    conversation_id: str
    phone: Optional[str]
    verdict: str
    message_count: int
    end_state: str  # conversation-end | timeout | error | open
    hitl_status: str  # none | active-stuck | closed
    created_at: Optional[str]
    updated_at: Optional[str]
    checks: list[CheckResult] = field(default_factory=list)
    # Whether this conversation escalated to a human (hitl#downstream tag).
    handed_off: bool = False
    # Optional LLM-judge overlay (populated only with --llm-judge). The
    # deterministic verdict above is always computed; these augment it.
    llm_verdict: Optional[str] = None
    llm_reasoning: Optional[str] = None
    llm_user_satisfied: Optional[bool] = None
    llm_problem_resolved: Optional[bool] = None
    llm_confidence: Optional[str] = None

    @property
    def failed_checks(self) -> list[str]:
        return [c.name for c in self.checks if not c.passed]

    @property
    def effective_verdict(self) -> str:
        """LLM verdict when present, else the deterministic one."""
        return self.llm_verdict or self.verdict

    @property
    def resolved(self) -> bool:
        """Was the user's problem actually solved?

        Prefers the LLM judge's explicit ``problem_resolved`` read when present;
        otherwise falls back to the deterministic proxy (a clean GOOD verdict).
        """
        if self.llm_problem_resolved is not None:
            return self.llm_problem_resolved
        return self.verdict == GOOD


# Integration name of the human-agent side of a HITL handoff. The bot never
# drives these conversations, so they must not be scored as bot performance.
AGENT_INTEGRATIONS = {"zendesk"}
# Tag present on the downstream (agent-side) mirror conversation of a handoff.
HITL_UPSTREAM_TAG = "hitl#upstream"
# Tag present on the upstream (customer-side) conversation once it handed off.
HITL_DOWNSTREAM_TAG = "hitl#downstream"


def is_bot_conversation(conv: dict[str, Any]) -> bool:
    """True for customer-facing conversations the bot actually drives.

    A HITL handoff spawns a second, mirror conversation on the human-agent side
    (e.g. Zendesk) whose messages are human/agent replies with no workflow
    ``origin`` tag. Scoring those as bot conversations is meaningless (they look
    like total failures), so we exclude them: anything on an agent integration
    or carrying the downstream ``hitl#upstream`` marker is the agent side.
    """
    tags = conv.get("tags") or {}
    if conv.get("integration") in AGENT_INTEGRATIONS:
        return False
    if HITL_UPSTREAM_TAG in tags:
        return False
    return True


def was_handed_off(conv: dict[str, Any]) -> bool:
    """True if this (customer-side) conversation escalated to a human agent."""
    return HITL_DOWNSTREAM_TAG in (conv.get("tags") or {})


# --- helpers ----------------------------------------------------------------
def _text(msg: dict[str, Any]) -> str:
    payload = msg.get("payload") or {}
    text = payload.get("text") if isinstance(payload, dict) else None
    return text if isinstance(text, str) else ""


def _origin_workflow(msg: dict[str, Any]) -> Optional[str]:
    origin = (msg.get("tags") or {}).get("origin")
    if not isinstance(origin, str):
        return None
    m = ORIGIN_RE.match(origin)
    return m.group(1) if m else None


def _origin(msg: dict[str, Any]) -> Optional[str]:
    """Full origin string (workflow://wf/node/nd/card/cd), or None."""
    origin = (msg.get("tags") or {}).get("origin")
    return origin if isinstance(origin, str) else None


def _phone(conv: dict[str, Any]) -> Optional[str]:
    tags = conv.get("tags") or {}
    return tags.get("whatsapp:userPhone") or tags.get("whatsapp:phoneNumberId")


def _sorted_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # API returns newest-first; analyze chronologically.
    return sorted(messages, key=lambda m: m.get("createdAt") or "")


# --- the scorer -------------------------------------------------------------
def score_conversation(
    conv: dict[str, Any],
    messages: list[dict[str, Any]],
    hitl_payload: Optional[dict[str, Any]],
) -> ConversationScore:
    msgs = _sorted_messages(messages)
    outgoing = [m for m in msgs if m.get("direction") == "outgoing"]
    incoming = [m for m in msgs if m.get("direction") == "incoming"]
    conv_tags = conv.get("tags") or {}

    # --- derived signals ----------------------------------------------------
    origin_workflows = [w for w in (_origin_workflow(m) for m in outgoing) if w]
    last_origin = _origin_workflow(outgoing[-1]) if outgoing else None

    if last_origin and WF_CONVERSATION_END in last_origin:
        end_state = "conversation-end"
    elif last_origin and WF_TIMEOUT in last_origin:
        end_state = "timeout"
    elif last_origin and WF_ERROR in last_origin:
        end_state = "error"
    else:
        end_state = "open"

    hitl_active = bool((hitl_payload or {}).get("hitlActive"))
    hitl_closed = HITL_END_REASON_TAG in conv_tags
    stuck_hitl = hitl_active and not hitl_closed
    if stuck_hitl:
        hitl_status = "active-stuck"
    elif hitl_closed or hitl_active:
        hitl_status = "closed"
    else:
        hitl_status = "none"

    # Trailing run of incoming-only messages (bot stopped replying).
    trailing_incoming = 0
    for m in reversed(msgs):
        if m.get("direction") == "incoming":
            trailing_incoming += 1
        else:
            break

    full_text = "\n".join(_text(m) for m in msgs).lower()
    has_fallback = FALLBACK_DATA_NOT_FOUND in full_text
    error_flow = any(WF_ERROR in w for w in origin_workflows)

    # First bot response after the first user message.
    first_response_wf = origin_workflows[0] if origin_workflows else None
    first_response_text = _text(outgoing[0]).lower() if outgoing else ""
    routed_to_main = bool(first_response_wf and WF_MAIN in first_response_wf)
    dropped_to_generic = (not routed_to_main) and (GENERIC_HELP in first_response_text)

    # Redundant repetition = the same card emitting the same text back-to-back in
    # the outgoing stream (e.g. asking "digite seu CPF" twice = a re-prompt loop).
    # Keyed on full origin (incl. card) + text so that a single node legitimately
    # emitting several different cards (welcome + choice, text + image) is NOT a loop.
    sigs = [(o, _text(m)) for m in outgoing if (o := _origin(m)) is not None]
    looped = any(a == b for a, b in zip(sigs, sigs[1:]))

    # Dangling final question: ends on a bot choice the user never answered.
    last_msg = msgs[-1] if msgs else None
    dangling_question = bool(
        last_msg
        and last_msg.get("direction") == "outgoing"
        and last_msg.get("type") == "choice"
    )

    # --- checklist checks ---------------------------------------------------
    checks: list[CheckResult] = []

    # Axis 1
    checks.append(
        CheckResult(
            "origin_tags_present",
            AXIS_TOOLS,
            passed=(not outgoing) or bool(origin_workflows),
            detail="bot messages carry workflow origin tags",
        )
    )
    checks.append(
        CheckResult(
            "no_error_flow",
            AXIS_TOOLS,
            passed=not error_flow,
            detail="no origin pointing at wf-error",
        )
    )
    checks.append(
        CheckResult(
            "no_redundant_loop",
            AXIS_TOOLS,
            passed=not looped,
            detail="same node not repeated back-to-back",
        )
    )
    checks.append(
        CheckResult(
            "data_lookup_succeeded",
            AXIS_TOOLS,
            passed=not has_fallback,
            detail='no "Não encontramos os seus dados" fallback',
        )
    )

    # Axis 2
    checks.append(
        CheckResult(
            "intent_routed_to_main",
            AXIS_INTENT,
            passed=routed_to_main or (first_response_wf is not None and not dropped_to_generic),
            detail="first response lands in wf-main (not generic help)",
        )
    )
    checks.append(
        CheckResult(
            "no_generic_drop",
            AXIS_INTENT,
            passed=not dropped_to_generic,
            detail='did not drop to generic "Como podemos te ajudar?"',
        )
    )

    # Axis 3
    checks.append(
        CheckResult(
            "reached_clean_end",
            AXIS_RESOLUTION,
            passed=end_state == "conversation-end",
            detail="ended in wf-conversation-end",
        )
    )
    checks.append(
        CheckResult(
            "not_abandoned_timeout",
            AXIS_RESOLUTION,
            passed=end_state != "timeout",
            detail="did not end in wf-timeout (user abandon)",
        )
    )
    checks.append(
        CheckResult(
            "not_stuck_hitl",
            AXIS_RESOLUTION,
            passed=not stuck_hitl,
            detail="not parked in HITL without an end reason",
        )
    )
    checks.append(
        CheckResult(
            "responsive",
            AXIS_RESOLUTION,
            passed=trailing_incoming < TRAILING_INCOMING_THRESHOLD,
            detail="no trailing run of unanswered incoming messages",
        )
    )
    checks.append(
        CheckResult(
            "no_dangling_question",
            AXIS_RESOLUTION,
            passed=not dangling_question,
            detail="does not end on an unanswered bot question",
        )
    )

    # --- verdict (CHECKLIST.md triage rubric) -------------------------------
    trailing_stuck = trailing_incoming >= TRAILING_INCOMING_THRESHOLD
    hard = (
        stuck_hitl
        or error_flow
        or has_fallback  # failed data-lookup
        or dropped_to_generic  # wrong-intent routing
        or trailing_stuck  # bot stopped responding
    )
    if hard:
        verdict = HARD_FAIL
    elif end_state == "conversation-end" and not looped and not dangling_question:
        verdict = GOOD
    else:
        # Handled but abandoned (timeout), HITL closed, or simply no explicit
        # resolution signal -> soft fail.
        verdict = SOFT_FAIL

    return ConversationScore(
        conversation_id=conv.get("id", "?"),
        phone=_phone(conv),
        verdict=verdict,
        message_count=len(msgs),
        end_state=end_state,
        hitl_status=hitl_status,
        created_at=conv.get("createdAt"),
        updated_at=conv.get("updatedAt"),
        checks=checks,
    )
