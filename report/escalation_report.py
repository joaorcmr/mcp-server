#!/usr/bin/env python3
"""Escalation report — split a sample of conversations into two universes and use
an OpenAI judge to grade the bot's escalate / don't-escalate decision.

Universe 1 (escalated to a human, via the n1 or n2 flow): what % was escalated
CORRECTLY (with examples) vs UNNECESSARILY (with examples).
Universe 2 (not escalated): what actually happened (resolved & satisfied, outside
business hours, abandoned, …) and what % SHOULD have escalated but didn't vs what %
correctly did not.

Pipeline: fetch conversations -> classify escalated/not (+ n1/n2 tier) -> LLM-judge
each -> render a PDF (cover, Universe 1, Universe 2, methodology).

Reuses the SAME .env as the MCP server (BOTPRESS_TOKEN / BOTPRESS_BOT_ID /
BOTPRESS_WORKSPACE_ID, OPENAI_API_KEY). Requires: reportlab, matplotlib, openai.

    python report/escalation_report.py --days 7
    python report/escalation_report.py --days 7 --sample-size 25
    python report/escalation_report.py --days 7 --sample-size 20 --no-llm
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import matplotlib

matplotlib.use("Agg")  # headless
import matplotlib.pyplot as plt  # noqa: E402

from reportlab.lib import colors  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle  # noqa: E402
from reportlab.lib.units import cm  # noqa: E402
from reportlab.platypus import (  # noqa: E402
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scoring  # noqa: E402
from botpress_api import BotpressClient, BotpressError  # noqa: E402

# Colours reused from the quality report for visual consistency.
C_GOOD = colors.HexColor("#2e7d32")
C_BAD = colors.HexColor("#c62828")
C_WARN = colors.HexColor("#f9a825")
C_HEAD = colors.HexColor("#263238")
C_GRID = colors.HexColor("#cfd8dc")


# --- workflow id -> name (n1/n2 tiering) ------------------------------------
def load_workflow_names() -> dict[str, str]:
    """Map opaque workflow ids (``wf-…``) to readable names from bot/bot.json.

    Message ``origin`` tags carry only the opaque id, but the n1/n2 tier lives in
    the workflow *name* ("Vitta Workflow N1"). Loaded at runtime so it tracks the
    deployed bot. Returns {} if the export is missing.
    """
    path = Path(__file__).resolve().parent.parent / "bot" / "bot.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    names: dict[str, str] = {}
    for flow in data.get("flows", []) or []:
        if isinstance(flow, dict):
            fid = flow.get("id") or flow.get("code")
            name = flow.get("name") or flow.get("title")
            if fid and name:
                names[fid] = name.strip()
    return names


def escalation_tier(messages: list[dict[str, Any]], wf_names: dict[str, str]) -> str:
    """Best-effort n1 / n2 tier from the workflow names the conversation traversed.

    The Vitta N1/N2 flows rarely emit customer-facing messages, so this is a hint,
    not a guarantee; returns "unknown" when no tier-specific workflow is seen.
    """
    seen_names = [
        wf_names.get(w, w).lower()
        for w in (scoring._origin_workflow(m) for m in messages)
        if w
    ]
    has_n1 = any("n1" in n for n in seen_names)
    has_n2 = any("n2" in n for n in seen_names)
    if has_n2 and not has_n1:
        return "n2"
    if has_n1 and not has_n2:
        return "n1"
    if has_n1 and has_n2:
        return "n1+n2"
    return "unknown"


def is_escalated(conv: dict[str, Any], hitl: Optional[dict[str, Any]]) -> bool:
    """True if the conversation actually handed off to a human.

    Authoritative signal is the ``hitl#downstream`` tag (``was_handed_off``), which
    persists after the handoff closes, so it catches both ongoing and completed
    escalations; an active ``hitl#hitl`` state corroborates an in-progress one.
    Merely *entering* a HITL-related workflow is NOT counted — that over-reports.
    """
    return scoring.was_handed_off(conv) or bool(hitl and hitl.get("hitlActive"))


# --- case model -------------------------------------------------------------
@dataclass
class EscalationCase:
    conversation_id: str
    phone: Optional[str]
    escalated: bool
    tier: str
    end_state: str
    hitl_status: str
    message_count: int
    transcript: str  # short excerpt for examples
    verdict: Optional[dict[str, Any]] = None  # the LLM judge dict (or None)

    # -- escalated-universe reads --
    @property
    def justified(self) -> Optional[bool]:
        return None if not self.verdict else self.verdict.get("escalation_justified")

    # -- not-escalated-universe reads --
    @property
    def should_have_escalated(self) -> Optional[bool]:
        return None if not self.verdict else self.verdict.get("should_have_escalated")

    @property
    def outcome_category(self) -> Optional[str]:
        return None if not self.verdict else self.verdict.get("outcome_category")

    @property
    def confidence_rank(self) -> int:
        order = {"high": 0, "medium": 1, "low": 2}
        return order.get((self.verdict or {}).get("confidence", ""), 3)


# --- CLI --------------------------------------------------------------------
def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Escalation-correctness PDF report.")
    p.add_argument("--days", type=int, default=7, help="Window size in days (default: 7).")
    p.add_argument("--start", help="Window start (ISO 8601). Overrides --days.")
    p.add_argument("--end", help="Window end (ISO 8601). Defaults to now.")
    p.add_argument(
        "--sample-size",
        type=int,
        default=400,
        help="Number of customer-facing bot conversations to analyze (default: 400).",
    )
    p.add_argument(
        "--llm-model",
        default=None,
        help="Judge model (default: gpt-5.5-2026-04-23, or OPENAI_MODEL).",
    )
    p.add_argument("--concurrency", type=int, default=8, help="Parallel workers (default: 8).")
    p.add_argument(
        "--no-llm",
        action="store_true",
        help="Segment only (escalated/not + tier) without calling the LLM judge.",
    )
    p.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parent / "escalation-report.pdf"),
        help="Output PDF path.",
    )
    return p.parse_args(argv)


def resolve_window(args: argparse.Namespace) -> tuple[str, str]:
    end = (
        datetime.fromisoformat(args.end.replace("Z", "+00:00"))
        if args.end
        else datetime.now(timezone.utc)
    )
    start = (
        datetime.fromisoformat(args.start.replace("Z", "+00:00"))
        if args.start
        else end - timedelta(days=args.days)
    )

    def iso(d: datetime) -> str:
        return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    return iso(start), iso(end)


# --- charts -----------------------------------------------------------------
def _fig_to_image(fig, width_cm: float = 12.0) -> Image:
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", dpi=150)
    plt.close(fig)
    buf.seek(0)
    w = width_cm * cm
    h = w * fig.get_figheight() / fig.get_figwidth()
    return Image(buf, width=w, height=h)


def pie(values: list[int], labels: list[str], hexes: list[str], title: str, width_cm=9.0) -> Optional[Image]:
    data = [(v, l, c) for v, l, c in zip(values, labels, hexes) if v > 0]
    if not data:
        return None
    fig, ax = plt.subplots(figsize=(4.5, 3.5))
    ax.pie([d[0] for d in data], labels=[d[1] for d in data], colors=[d[2] for d in data],
           autopct="%1.0f%%", startangle=90)
    ax.set_title(title)
    ax.axis("equal")
    return _fig_to_image(fig, width_cm=width_cm)


def barh(counter: Counter, title: str, color="#1565c0") -> Optional[Image]:
    if not counter:
        return None
    items = counter.most_common()
    names = [n for n, _ in items][::-1]
    vals = [v for _, v in items][::-1]
    fig, ax = plt.subplots(figsize=(8, max(2.2, 0.45 * len(names) + 1)))
    ax.barh(names, vals, color=color)
    ax.set_title(title)
    ax.tick_params(axis="y", labelsize=8)
    for i, v in enumerate(vals):
        ax.text(v, i, f" {v}", va="center", fontsize=8)
    return _fig_to_image(fig)


# --- example selection ------------------------------------------------------
def pick_examples(cases: list[EscalationCase], n: int, diverse_key=None) -> list[EscalationCase]:
    """Highest-confidence first; optionally one-per-category, then dedupe by phone."""
    ordered = sorted(cases, key=lambda c: (c.confidence_rank, -c.message_count))
    picked: list[EscalationCase] = []
    seen_keys: set = set()
    seen_phones: set = set()
    # First pass: enforce diversity on the key (e.g. outcome_category).
    if diverse_key is not None:
        for c in ordered:
            k = diverse_key(c)
            if k in seen_keys:
                continue
            seen_keys.add(k)
            seen_phones.add(c.phone)
            picked.append(c)
            if len(picked) >= n:
                return picked
    # Second pass: fill remaining slots, avoiding duplicate phones when possible.
    for c in ordered:
        if c in picked:
            continue
        if c.phone in seen_phones and len(ordered) > n:
            continue
        seen_phones.add(c.phone)
        picked.append(c)
        if len(picked) >= n:
            break
    return picked[:n]


# --- PDF --------------------------------------------------------------------
def build_pdf(out_path: str, bot_id: str, start: str, end: str, cases: list[EscalationCase],
              skipped_agent_side: int, llm_enabled: bool, model: Optional[str]) -> None:
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle("Small", parent=styles["Normal"], fontSize=8, leading=10))
    styles.add(ParagraphStyle("Mono", parent=styles["Normal"], fontName="Courier", fontSize=7, leading=8.5))
    h1, h2, h3 = styles["Title"], styles["Heading2"], styles["Heading3"]
    body, small, mono = styles["Normal"], styles["Small"], styles["Mono"]
    story: list[Any] = []

    total = len(cases) or 1
    escalated = [c for c in cases if c.escalated]
    not_esc = [c for c in cases if not c.escalated]
    tier_counts = Counter(c.tier for c in escalated)

    def hdr_table(rows: list[list[str]], w=(7.0, 4.0)) -> Table:
        t = Table(rows, colWidths=[w[0] * cm, w[1] * cm])
        t.setStyle(TableStyle([
            ("SPAN", (0, 0), (1, 0)), ("BACKGROUND", (0, 0), (1, 0), C_HEAD),
            ("TEXTCOLOR", (0, 0), (1, 0), colors.white), ("FONTNAME", (0, 0), (1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9), ("GRID", (0, 0), (-1, -1), 0.4, C_GRID),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#eceff1")]),
        ]))
        return t

    # --- 1. Cover / summary ---
    story.append(Paragraph("Escalation Report — escalated vs not escalated", h1))
    story.append(Paragraph(f"Bot <b>{bot_id}</b>", body))
    story.append(Paragraph(f"Window: {start} → {end}", small))
    story.append(Paragraph(
        f"Verdict source: {'OpenAI judge ' + (model or '') if llm_enabled else 'segmentation only (--no-llm)'}", small))
    story.append(Spacer(1, 0.4 * cm))

    summary_rows = [
        ["Sample", ""],
        ["Bot conversations analyzed", f"{len(cases):,}"],
        ["Escalated to human", f"{len(escalated)} ({100*len(escalated)/total:.0f}%)"],
        ["Not escalated", f"{len(not_esc)} ({100*len(not_esc)/total:.0f}%)"],
        ["— tier n1 / n2 / mixed / unknown",
         f"{tier_counts.get('n1',0)} / {tier_counts.get('n2',0)} / {tier_counts.get('n1+n2',0)} / {tier_counts.get('unknown',0)}"],
        ["Agent-side mirror convs skipped", f"{skipped_agent_side:,}"],
    ]
    story.append(hdr_table(summary_rows))
    story.append(Spacer(1, 0.4 * cm))
    p = pie([len(escalated), len(not_esc)], [f"Escalated ({len(escalated)})", f"Not escalated ({len(not_esc)})"],
            ["#1565c0", "#90a4ae"], "Sample split")
    if p:
        story.append(p)

    # --- 2. Universe 1: escalated ---
    story.append(PageBreak())
    story.append(Paragraph("Universe 1 — Escalated to a human (n1 / n2)", h2))
    _universe_escalated(story, escalated, llm_enabled, h3, body, small, mono, hdr_table)

    # --- 3. Universe 2: not escalated ---
    story.append(PageBreak())
    story.append(Paragraph("Universe 2 — Not escalated", h2))
    _universe_not_escalated(story, not_esc, llm_enabled, h3, body, small, mono, hdr_table)

    # --- 4. Methodology ---
    story.append(PageBreak())
    story.append(Paragraph("Methodology", h2))
    method = [
        "<b>Scope:</b> only customer-facing bot conversations are analyzed. A HITL handoff spawns "
        f"an agent-side mirror conversation (Zendesk) which is excluded ({skipped_agent_side} skipped).",
        "<b>Escalated detection:</b> the customer-side conversation carries the "
        "<font face='Courier'>hitl#downstream</font> tag (persists after the handoff closes) or an "
        "active <font face='Courier'>hitl#hitl</font> state. Merely entering a HITL-related workflow "
        "without handing off is not counted.",
        "<b>n1 / n2 tier:</b> best-effort, from the names of the workflows the conversation traversed "
        "(Vitta Workflow N1 = business hours; N2 = box-limit/SLA). The tier flows rarely emit "
        "customer-facing messages, so many escalations are tier <i>unknown</i> — this does not affect "
        "the escalated/not split or the correctness judgement.",
    ]
    if llm_enabled:
        method.append(
            f"<b>LLM judge ({model}):</b> reads each transcript and the deterministic signals. For "
            "escalated convs it returns <font face='Courier'>escalation_justified</font> + category; for "
            "non-escalated convs <font face='Courier'>should_have_escalated</font> + outcome category. "
            "Rubric grounded in CHECKLIST.md and the bot's escalation playbook. LLM verdicts are not "
            "byte-reproducible across runs; failed calls leave a conversation counted but un-judged.")
    for m in method:
        story.append(Paragraph("• " + m, small))
        story.append(Spacer(1, 0.12 * cm))

    SimpleDocTemplate(out_path, pagesize=A4, leftMargin=1.2 * cm, rightMargin=1.2 * cm,
                      topMargin=1.2 * cm, bottomMargin=1.2 * cm,
                      title="Escalation Report").build(story)


def _example_block(story, case: EscalationCase, lead: str, reasoning: str, h3, small, mono):
    story.append(Spacer(1, 0.2 * cm))
    story.append(Paragraph(lead, h3))
    meta = (f"<font face='Courier'>{case.conversation_id}</font> · phone {case.phone or '—'} · "
            f"tier {case.tier} · {case.message_count} msgs · end {case.end_state}")
    story.append(Paragraph(meta, small))
    if reasoning:
        story.append(Paragraph(f"<b>Judge:</b> {reasoning}", small))
    story.append(Spacer(1, 0.1 * cm))
    story.append(Paragraph(case.transcript.replace("\n", "<br/>") or "—", mono))


def _universe_escalated(story, escalated, llm_enabled, h3, body, small, mono, hdr_table):
    if not escalated:
        story.append(Paragraph("No escalated conversations in this sample.", body))
        return
    judged = [c for c in escalated if c.verdict is not None]
    if not llm_enabled or not judged:
        story.append(Paragraph(
            f"{len(escalated)} escalated conversation(s). Run without --no-llm for the "
            "correct-vs-unnecessary breakdown.", body))
        return
    justified = [c for c in judged if c.justified]
    unnecessary = [c for c in judged if c.justified is False]
    nj = len(judged) or 1
    story.append(Paragraph(
        f"<b>{len(judged)} escalations judged.</b> "
        f"<font color='#2e7d32'>Correct (justified): {len(justified)} ({100*len(justified)/nj:.0f}%)</font> · "
        f"<font color='#c62828'>Unnecessary: {len(unnecessary)} ({100*len(unnecessary)/nj:.0f}%)</font>.", body))
    story.append(Spacer(1, 0.3 * cm))
    p = pie([len(justified), len(unnecessary)],
            [f"Correct ({len(justified)})", f"Unnecessary ({len(unnecessary)})"],
            ["#2e7d32", "#c62828"], "Escalation correctness")
    if p:
        story.append(p)
    cat = Counter(c.verdict.get("justification_category") for c in justified)
    b = barh(cat, "Why escalation was justified", color="#2e7d32")
    if b:
        story.append(b)

    story.append(Paragraph("Correctly escalated — examples", h3))
    for c in pick_examples(justified, 2):
        _example_block(story, c, f"✅ Justified — {c.verdict.get('justification_category')}",
                       c.verdict.get("reasoning", ""), h3, small, mono)
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph("Unnecessarily escalated — examples", h3))
    if not unnecessary:
        story.append(Paragraph("None found — every judged escalation was justified.", body))
    for c in pick_examples(unnecessary, 2):
        _example_block(story, c, f"⚠️ Unnecessary — {c.verdict.get('unnecessary_reason')}",
                       c.verdict.get("reasoning", ""), h3, small, mono)


def _universe_not_escalated(story, not_esc, llm_enabled, h3, body, small, mono, hdr_table):
    if not not_esc:
        story.append(Paragraph("No non-escalated conversations in this sample.", body))
        return
    judged = [c for c in not_esc if c.verdict is not None]
    if not llm_enabled or not judged:
        story.append(Paragraph(
            f"{len(not_esc)} non-escalated conversation(s). Run without --no-llm for the "
            "should-have-escalated breakdown.", body))
        return
    missed = [c for c in judged if c.should_have_escalated]
    correct = [c for c in judged if c.should_have_escalated is False]
    nj = len(judged) or 1
    story.append(Paragraph(
        f"<b>{len(judged)} non-escalations judged.</b> "
        f"<font color='#c62828'>Should have escalated (missed): {len(missed)} ({100*len(missed)/nj:.0f}%)</font> · "
        f"<font color='#2e7d32'>Correctly not escalated: {len(correct)} ({100*len(correct)/nj:.0f}%)</font>.", body))
    story.append(Spacer(1, 0.3 * cm))
    p = pie([len(correct), len(missed)],
            [f"Correctly not escalated ({len(correct)})", f"Missed escalation ({len(missed)})"],
            ["#2e7d32", "#c62828"], "Non-escalation correctness")
    if p:
        story.append(p)
    outcomes = Counter(c.outcome_category for c in judged)
    b = barh(outcomes, "What happened (outcome category)", color="#1565c0")
    if b:
        story.append(b)

    story.append(Paragraph("Five examples of non-escalation", h3))
    for c in pick_examples(judged, 5, diverse_key=lambda x: x.outcome_category):
        flag = "⚠️ should have escalated" if c.should_have_escalated else "✅ correctly handled"
        lead = f"{flag} — {c.outcome_category} (sentiment: {c.verdict.get('user_sentiment')})"
        _example_block(story, c, lead, c.verdict.get("reasoning", ""), h3, small, mono)


# --- main -------------------------------------------------------------------
def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    start, end = resolve_window(args)
    try:
        client = BotpressClient()
    except BotpressError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    wf_names = load_workflow_names()
    judge_client = None
    model = None
    if not args.no_llm:
        import escalation_judge
        import llm_judge

        try:
            judge_client = llm_judge.make_client()
        except Exception as exc:  # noqa: BLE001
            print(f"error: {exc}", file=sys.stderr)
            return 2
        model = args.llm_model or escalation_judge.default_model()
        print(f"LLM judge enabled ({model}).", file=sys.stderr)

    print(f"Window: {start} -> {end}", file=sys.stderr)
    print("Fetching conversations…", file=sys.stderr)
    skipped_agent_side = 0
    scan_budget = max(args.sample_size * 5, 250)
    bot_convs: list[dict[str, Any]] = []
    for conv in client.iter_conversations(after_date=start, before_date=end, max_items=scan_budget):
        if not conv.get("id"):
            continue
        if not scoring.is_bot_conversation(conv):
            skipped_agent_side += 1
            continue
        bot_convs.append(conv)
        if len(bot_convs) >= args.sample_size:
            break

    def process(conv: dict[str, Any]) -> EscalationCase:
        cid = conv["id"]
        messages = client.list_all_messages(cid)
        hitl = client.get_hitl_state(cid)
        score = scoring.score_conversation(conv, messages, hitl)
        escalated = is_escalated(conv, hitl)
        tier = escalation_tier(messages, wf_names) if escalated else "—"
        case = EscalationCase(
            conversation_id=cid,
            phone=scoring._phone(conv),
            escalated=escalated,
            tier=tier,
            end_state=score.end_state,
            hitl_status=score.hitl_status,
            message_count=score.message_count,
            transcript="",
        )
        if judge_client is not None:
            import escalation_judge

            case.transcript = escalation_judge._render_transcript(messages, wf_names)
            if escalated:
                case.verdict = escalation_judge.judge_escalated(
                    judge_client, conv, messages, score, tier, model=model, wf_names=wf_names)
            else:
                case.verdict = escalation_judge.judge_not_escalated(
                    judge_client, conv, messages, score, tier, model=model, wf_names=wf_names)
        return case

    from concurrent.futures import ThreadPoolExecutor

    print(f"Processing {len(bot_convs)} conversation(s) with {args.concurrency} workers…", file=sys.stderr)
    cases: list[EscalationCase] = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for case in pool.map(process, bot_convs):
            cases.append(case)
            done += 1
            if done % 25 == 0:
                print(f"  …{done}/{len(bot_convs)} processed", file=sys.stderr)

    esc = sum(1 for c in cases if c.escalated)
    print(f"Done: {len(cases)} analyzed — {esc} escalated / {len(cases)-esc} not; "
          f"skipped {skipped_agent_side} agent-side.", file=sys.stderr)
    print(f"Rendering PDF -> {args.out}", file=sys.stderr)
    build_pdf(args.out, client.bot_id, start, end, cases, skipped_agent_side,
              llm_enabled=bool(judge_client), model=model)
    print(f"Report at {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
