#!/usr/bin/env python3
"""Generate the "Quality of Bot" PDF report.

Pipeline: fetch Botpress analytics + conversations -> score each conversation
against CHECKLIST.md (scoring.py) -> render a multi-page PDF combining the
quantitative dashboard KPIs with the qualitative resolution score.

Usage:
    python report/generate_report.py --days 7
    python report/generate_report.py --start 2026-06-18T00:00:00Z --end 2026-06-25T00:00:00Z
    python report/generate_report.py --days 30 --max-conversations 500 --out quality.pdf

Reads the same .env as the MCP server (BOTPRESS_TOKEN / BOTPRESS_BOT_ID /
BOTPRESS_WORKSPACE_ID). Requires: reportlab, matplotlib (see requirements.txt).
"""

from __future__ import annotations

import argparse
import io
import sys
from collections import Counter
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

# Local imports work whether run as `python report/generate_report.py` or `-m`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import scoring  # noqa: E402
from botpress_api import BotpressClient, BotpressError  # noqa: E402

VERDICT_COLORS = {
    scoring.GOOD: colors.HexColor("#2e7d32"),
    scoring.SOFT_FAIL: colors.HexColor("#f9a825"),
    scoring.HARD_FAIL: colors.HexColor("#c62828"),
}
VERDICT_LABEL = {
    scoring.GOOD: "GOOD",
    scoring.SOFT_FAIL: "SOFT FAIL",
    scoring.HARD_FAIL: "HARD FAIL",
}


# --- CLI --------------------------------------------------------------------
def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate the Quality of Bot PDF report.")
    p.add_argument("--days", type=int, default=7, help="Window size in days (default: 7).")
    p.add_argument("--start", help="Window start (ISO 8601). Overrides --days.")
    p.add_argument("--end", help="Window end (ISO 8601). Defaults to now.")
    p.add_argument(
        "--max-conversations",
        type=int,
        default=200,
        help="Cap on conversations to score (controls message-fetch cost). Default: 200.",
    )
    p.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parent / "bot-quality-report.pdf"),
        help="Output PDF path.",
    )
    p.add_argument(
        "--llm-judge",
        action="store_true",
        help="Also score each conversation with an OpenAI LLM judge that reads the "
        "transcript (needs OPENAI_API_KEY). Adds cost; deterministic scoring stays as fallback.",
    )
    p.add_argument(
        "--llm-model",
        default=None,
        help="Override the LLM-judge model (default: gpt-4o, or OPENAI_MODEL).",
    )
    p.add_argument(
        "--concurrency",
        type=int,
        default=8,
        help="Parallel workers for fetching/scoring/judging conversations (default: 8).",
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


# --- analytics helpers ------------------------------------------------------
def sum_analytics(records: list[dict[str, Any]]) -> dict[str, Any]:
    totals = {
        "userMessages": 0,
        "botMessages": 0,
        "sessions": 0,
        "newUsers": 0,
        "returningUsers": 0,
        "events": 0,
        "llmCalls": 0,
        "llmErrors": 0,
        "llmInputTokens": 0,
        "llmOutputTokens": 0,
        "llmCost": 0.0,
    }
    for r in records:
        totals["userMessages"] += r.get("userMessages", 0) or 0
        totals["botMessages"] += r.get("botMessages", 0) or 0
        totals["sessions"] += r.get("sessions", 0) or 0
        totals["newUsers"] += r.get("newUsers", 0) or 0
        totals["returningUsers"] += r.get("returningUsers", 0) or 0
        totals["events"] += r.get("events", 0) or 0
        llm = r.get("llm") or {}
        totals["llmCalls"] += llm.get("calls", 0) or 0
        totals["llmErrors"] += llm.get("errors", 0) or 0
        totals["llmInputTokens"] += llm.get("inputTokens", 0) or 0
        totals["llmOutputTokens"] += llm.get("outputTokens", 0) or 0
        totals["llmCost"] += (llm.get("cost") or {}).get("sum", 0) or 0
    return totals


def _day_label(record: dict[str, Any]) -> str:
    raw = record.get("startDateTimeUtc", "")
    return raw[5:10] if len(raw) >= 10 else raw  # MM-DD


# --- charts (matplotlib -> reportlab Image) ---------------------------------
def _fig_to_image(fig, width_cm: float = 16.0) -> Image:
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", dpi=150)
    plt.close(fig)
    buf.seek(0)
    w = width_cm * cm
    h = w * fig.get_figheight() / fig.get_figwidth()
    return Image(buf, width=w, height=h)


def chart_messages(records: list[dict[str, Any]]) -> Optional[Image]:
    if not records:
        return None
    labels = [_day_label(r) for r in records]
    x = range(len(labels))
    user = [r.get("userMessages", 0) or 0 for r in records]
    bot = [r.get("botMessages", 0) or 0 for r in records]
    fig, ax = plt.subplots(figsize=(8, 3))
    width = 0.4
    ax.bar([i - width / 2 for i in x], user, width, label="User", color="#1565c0")
    ax.bar([i + width / 2 for i in x], bot, width, label="Bot", color="#90caf9")
    ax.set_title("Messages per day")
    ax.set_xticks(list(x))
    ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
    ax.legend()
    return _fig_to_image(fig)


def chart_users_sessions(records: list[dict[str, Any]]) -> Optional[Image]:
    if not records:
        return None
    labels = [_day_label(r) for r in records]
    x = list(range(len(labels)))
    sessions = [r.get("sessions", 0) or 0 for r in records]
    new_u = [r.get("newUsers", 0) or 0 for r in records]
    ret_u = [r.get("returningUsers", 0) or 0 for r in records]
    fig, ax = plt.subplots(figsize=(8, 3))
    ax.plot(x, sessions, marker="o", label="Sessions", color="#6a1b9a")
    ax.plot(x, new_u, marker="o", label="New users", color="#2e7d32")
    ax.plot(x, ret_u, marker="o", label="Returning users", color="#ef6c00")
    ax.set_title("Sessions & users per day")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
    ax.legend()
    return _fig_to_image(fig)


def chart_llm_cost(records: list[dict[str, Any]]) -> Optional[Image]:
    costs = [((r.get("llm") or {}).get("cost") or {}).get("sum", 0) or 0 for r in records]
    if not records or not any(costs):
        return None
    labels = [_day_label(r) for r in records]
    x = list(range(len(labels)))
    fig, ax = plt.subplots(figsize=(8, 2.6))
    ax.bar(x, costs, color="#00838f")
    ax.set_title("LLM cost per day (USD)")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
    return _fig_to_image(fig)


def chart_verdicts(verdict_counts: Counter) -> Optional[Image]:
    if not sum(verdict_counts.values()):
        return None
    order = [scoring.GOOD, scoring.SOFT_FAIL, scoring.HARD_FAIL]
    sizes = [verdict_counts.get(v, 0) for v in order]
    labels = [f"{VERDICT_LABEL[v]} ({verdict_counts.get(v, 0)})" for v in order]
    chart_colors = ["#2e7d32", "#f9a825", "#c62828"]
    # Drop zero slices so the pie stays readable.
    data = [(s, l, c) for s, l, c in zip(sizes, labels, chart_colors) if s > 0]
    fig, ax = plt.subplots(figsize=(4.5, 3.5))
    ax.pie(
        [d[0] for d in data],
        labels=[d[1] for d in data],
        colors=[d[2] for d in data],
        autopct="%1.0f%%",
        startangle=90,
    )
    ax.set_title("Conversation verdicts")
    ax.axis("equal")
    return _fig_to_image(fig, width_cm=9)


def chart_failed_checks(scores: list[scoring.ConversationScore]) -> Optional[Image]:
    counter: Counter = Counter()
    for s in scores:
        for name in s.failed_checks:
            counter[name] += 1
    if not counter:
        return None
    items = counter.most_common()
    names = [n for n, _ in items][::-1]
    values = [v for _, v in items][::-1]
    fig, ax = plt.subplots(figsize=(8, max(2.5, 0.4 * len(names) + 1)))
    ax.barh(names, values, color="#c62828")
    ax.set_title("Most frequently failed checklist signals (conversations)")
    ax.tick_params(axis="y", labelsize=7)
    return _fig_to_image(fig)


def chart_resolution(scores: list[scoring.ConversationScore]) -> Optional[Image]:
    """Stacked bars: resolved vs not resolved, split by bot-alone vs handed-off."""
    if not scores:
        return None
    no_ho = [s for s in scores if not s.handed_off]
    ho = [s for s in scores if s.handed_off]
    cats = ["No handoff\n(bot alone)", "Handed off\nto human"]
    resolved = [sum(1 for s in no_ho if s.resolved), sum(1 for s in ho if s.resolved)]
    unresolved = [len(no_ho) - resolved[0], len(ho) - resolved[1]]
    fig, ax = plt.subplots(figsize=(7, 3.2))
    b1 = ax.bar(cats, resolved, label="Problem resolved", color="#2e7d32")
    b2 = ax.bar(cats, unresolved, bottom=resolved, label="Not resolved", color="#c62828")
    for bars, vals, base in ((b1, resolved, [0, 0]), (b2, unresolved, resolved)):
        for rect, v, btm in zip(bars, vals, base):
            if v:
                ax.text(rect.get_x() + rect.get_width() / 2, btm + v / 2, str(v),
                        ha="center", va="center", color="white", fontsize=9, fontweight="bold")
    ax.set_title("Problem resolution: bot self-service vs human handoff")
    ax.set_ylabel("conversations")
    ax.legend()
    return _fig_to_image(fig, width_cm=12)


# --- PDF assembly -----------------------------------------------------------
def build_pdf(
    out_path: str,
    bot_id: str,
    start: str,
    end: str,
    records: list[dict[str, Any]],
    scores: list[scoring.ConversationScore],
    skipped_agent_side: int = 0,
    handoffs: int = 0,
    llm_enabled: bool = False,
    llm_model: Optional[str] = None,
) -> None:
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle("Small", parent=styles["Normal"], fontSize=8, leading=10))
    h1 = styles["Title"]
    h2 = styles["Heading2"]
    body = styles["Normal"]
    small = styles["Small"]

    story: list[Any] = []
    totals = sum_analytics(records)
    # When the LLM judge ran, the effective verdict is the LLM's (deterministic
    # is the fallback); otherwise it's the deterministic verdict.
    verdict_counts: Counter = Counter(s.effective_verdict for s in scores)
    n = len(scores) or 1
    judged = [s for s in scores if s.llm_verdict is not None]
    agree = sum(1 for s in judged if s.llm_verdict == s.verdict)

    def pct(v: str) -> str:
        return f"{100 * verdict_counts.get(v, 0) / n:.0f}%"

    resolution_rate = 100 * verdict_counts.get(scoring.GOOD, 0) / n

    # --- 1. Cover / summary ---
    story.append(Paragraph("Quality of Bot — Report", h1))
    story.append(Paragraph(f"Bot <b>{bot_id}</b>", body))
    story.append(Paragraph(f"Window: {start} → {end}", small))
    story.append(Spacer(1, 0.4 * cm))

    kpi_rows = [
        ["Quantitative (Botpress Analytics)", ""],
        ["User messages", f"{totals['userMessages']:,}"],
        ["Bot messages", f"{totals['botMessages']:,}"],
        ["Sessions", f"{totals['sessions']:,}"],
        ["New / returning users", f"{totals['newUsers']:,} / {totals['returningUsers']:,}"],
        ["Events", f"{totals['events']:,}"],
        ["LLM calls / errors", f"{totals['llmCalls']:,} / {totals['llmErrors']:,}"],
        [
            "LLM tokens (in / out)",
            f"{totals['llmInputTokens']:,} / {totals['llmOutputTokens']:,}",
        ],
        ["LLM cost (USD)", f"${totals['llmCost']:.2f}"],
    ]
    verdict_source = (
        f"LLM judge: {llm_model}" if llm_enabled else "Deterministic (CHECKLIST.md)"
    )
    quality_rows = [
        ["Qualitative — verdict source", ""],
        ["Source", verdict_source],
        ["Bot conversations scored", f"{len(scores):,}"],
        ["GOOD", f"{verdict_counts.get(scoring.GOOD, 0)} ({pct(scoring.GOOD)})"],
        ["SOFT FAIL", f"{verdict_counts.get(scoring.SOFT_FAIL, 0)} ({pct(scoring.SOFT_FAIL)})"],
        ["HARD FAIL", f"{verdict_counts.get(scoring.HARD_FAIL, 0)} ({pct(scoring.HARD_FAIL)})"],
        ["Resolution rate (GOOD)", f"{resolution_rate:.0f}%"],
        ["Handoffs to human", f"{handoffs:,}"],
        ["Agent-side convs skipped", f"{skipped_agent_side:,}"],
    ]
    if llm_enabled and judged:
        quality_rows.append(
            ["LLM↔heuristic agreement", f"{100 * agree / len(judged):.0f}% ({agree}/{len(judged)})"]
        )

    def kpi_table(rows: list[list[str]]) -> Table:
        t = Table(rows, colWidths=[6.5 * cm, 4 * cm])
        t.setStyle(
            TableStyle(
                [
                    ("SPAN", (0, 0), (1, 0)),
                    ("BACKGROUND", (0, 0), (1, 0), colors.HexColor("#263238")),
                    ("TEXTCOLOR", (0, 0), (1, 0), colors.white),
                    ("FONTNAME", (0, 0), (1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cfd8dc")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#eceff1")]),
                ]
            )
        )
        return t

    summary = Table(
        [[kpi_table(kpi_rows), kpi_table(quality_rows)]],
        colWidths=[10.7 * cm, 10.7 * cm],
    )
    summary.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(summary)
    story.append(Spacer(1, 0.4 * cm))

    verdict_pie = chart_verdicts(verdict_counts)
    if verdict_pie:
        story.append(verdict_pie)

    # --- 2. Analytics charts ---
    story.append(PageBreak())
    story.append(Paragraph("Analytics (volume & cost)", h2))
    if not records:
        story.append(Paragraph("No analytics records returned for this window.", body))
    for chart in (chart_messages(records), chart_users_sessions(records), chart_llm_cost(records)):
        if chart:
            story.append(chart)
            story.append(Spacer(1, 0.3 * cm))

    # --- 3. Quality breakdown ---
    story.append(PageBreak())
    story.append(Paragraph("Quality breakdown", h2))
    failed_chart = chart_failed_checks(scores)
    if failed_chart:
        story.append(failed_chart)
    else:
        story.append(Paragraph("No failed checks across the scored conversations.", body))

    # --- 3b. Self-service resolution (no human handoff) ---
    story.append(PageBreak())
    story.append(Paragraph("Self-service resolution — did the bot solve it alone?", h2))
    no_ho = [s for s in scores if not s.handed_off]
    ho = [s for s in scores if s.handed_off]
    res_source = "LLM judge's problem_resolved" if llm_enabled else "GOOD verdict (deterministic proxy)"
    story.append(
        Paragraph(
            "Not escalating to a human does <b>not</b> imply the bot resolved the user's "
            "problem — a conversation can end with no human and no resolution (the user "
            f"simply drifted away). Resolution here = <i>{res_source}</i>. The critical "
            "bucket is <b>no-handoff &amp; not resolved</b>: users the bot neither solved "
            "for nor escalated.",
            small,
        )
    )
    story.append(Spacer(1, 0.3 * cm))
    a = len(no_ho) or 1
    resolved_no_ho = sum(1 for s in no_ho if s.resolved)
    unresolved_no_ho = len(no_ho) - resolved_no_ho
    res_rows = [
        ["Segment", "Conversations", "Resolved", "Not resolved"],
        [
            "Bot alone (no handoff)",
            f"{len(no_ho)} ({100*len(no_ho)/(len(scores) or 1):.0f}%)",
            f"{resolved_no_ho} ({100*resolved_no_ho/a:.0f}%)",
            f"{unresolved_no_ho} ({100*unresolved_no_ho/a:.0f}%)",
        ],
        [
            "Handed off to human",
            f"{len(ho)} ({100*len(ho)/(len(scores) or 1):.0f}%)",
            f"{sum(1 for s in ho if s.resolved)}",
            f"{sum(1 for s in ho if not s.resolved)}",
        ],
    ]
    rt = Table(res_rows, colWidths=[6 * cm, 4 * cm, 4 * cm, 4 * cm])
    rt.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#263238")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cfd8dc")),
                ("TEXTCOLOR", (3, 1), (3, -1), colors.HexColor("#c62828")),
                ("TEXTCOLOR", (2, 1), (2, -1), colors.HexColor("#2e7d32")),
            ]
        )
    )
    story.append(rt)
    story.append(Spacer(1, 0.3 * cm))
    story.append(
        Paragraph(
            f"<b>Self-service resolution rate: {100*resolved_no_ho/a:.0f}%</b> "
            f"— of the {len(no_ho)} conversations the bot handled without a human, "
            f"<b><font color='#c62828'>{unresolved_no_ho} ({100*unresolved_no_ho/a:.0f}%) ended "
            "unresolved</font></b> (no human, no solution).",
            body,
        )
    )
    story.append(Spacer(1, 0.3 * cm))
    res_chart = chart_resolution(scores)
    if res_chart:
        story.append(res_chart)

    # --- 4. Per-conversation table ---
    story.append(PageBreak())
    story.append(Paragraph("Per-conversation scores (worst first)", h2))
    if scores:
        rank = {scoring.HARD_FAIL: 0, scoring.SOFT_FAIL: 1, scoring.GOOD: 2}
        ordered = sorted(
            scores, key=lambda s: (rank.get(s.effective_verdict, 3), -s.message_count)
        )
        if llm_enabled:
            # Last column is the LLM's reasoning; "det" shows the heuristic verdict
            # letter so divergences are visible at a glance.
            header = ["Conversation", "Phone", "Verdict", "det", "End state", "Msgs", "LLM reasoning"]
            last_w = 7.0 * cm
        else:
            header = ["Conversation", "Phone", "Verdict", "End state", "HITL", "Msgs", "Top failed checks"]
            last_w = 6.2 * cm
        table_rows = [header]
        verdict_cell_styles = []
        for i, s in enumerate(ordered, start=1):
            ev = s.effective_verdict
            if llm_enabled:
                last_cell = Paragraph(s.llm_reasoning or "—", small)
                col4 = VERDICT_LABEL.get(s.verdict, "?")[0]  # deterministic letter
            else:
                last_cell = Paragraph(", ".join(s.failed_checks[:3]) or "—", small)
                col4 = s.end_state
            table_rows.append(
                [
                    Paragraph(s.conversation_id, small),
                    s.phone or "—",
                    VERDICT_LABEL[ev],
                    col4,
                    s.end_state if llm_enabled else s.hitl_status,
                    str(s.message_count),
                    last_cell,
                ]
            )
            verdict_cell_styles.append(("TEXTCOLOR", (2, i), (2, i), VERDICT_COLORS[ev]))
        t = Table(
            table_rows,
            colWidths=[4.0 * cm, 2.4 * cm, 1.9 * cm, 1.0 * cm, 2.2 * cm, 1.0 * cm, last_w],
            repeatRows=1,
        )
        t.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#263238")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 7),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#cfd8dc")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f5f5")]),
                    *verdict_cell_styles,
                ]
            )
        )
        story.append(t)
    else:
        story.append(Paragraph("No conversations found in this window.", body))

    # --- 5. Methodology appendix ---
    story.append(PageBreak())
    story.append(Paragraph("Methodology", h2))
    story.append(
        Paragraph(
            "Quantitative KPIs come from the Botpress Admin Analytics endpoint "
            "(<font face='Courier'>GET /v1/admin/bots/{botId}/analytics</font>), the same "
            "source as the dashboard. Each conversation is scored deterministically against "
            "<b>CHECKLIST.md</b> using observable signals only — no LLM judgement.",
            body,
        )
    )
    story.append(Spacer(1, 0.2 * cm))
    method_items = [
        "<b>Scope:</b> only customer-facing bot conversations are scored. A HITL handoff "
        "spawns a mirror conversation on the human-agent side (Zendesk) whose messages have no "
        "workflow origin; those are excluded ("
        f"{skipped_agent_side} skipped here) and counted instead as <b>handoffs to human</b>.",
        "<b>Axis 1 (tools/flows):</b> bot messages carry a <font face='Courier'>workflow://…</font> "
        "origin tag; no origin points at <font face='Courier'>wf-error</font>; no node repeats "
        "back-to-back (loop); the data-lookup fallback text is absent.",
        "<b>Axis 2 (intent):</b> the first bot response lands in a "
        "<font face='Courier'>wf-main</font> branch and does not drop to the generic "
        "\"Como podemos te ajudar?\" message.",
        "<b>Axis 3 (resolution):</b> ended in <font face='Courier'>wf-conversation-end</font> "
        "(GOOD) vs <font face='Courier'>wf-timeout</font> (abandon); not parked in HITL "
        "(<font face='Courier'>hitlActive:true</font> with no end reason); the bot answered every "
        "inbound message (no trailing incoming-only run); no dangling final question.",
        "<b>Verdict (triage rubric):</b> <font color='#c62828'>HARD FAIL</font> = stuck HITL, "
        "error flow, failed data-lookup, wrong-intent routing, or the bot stopped responding; "
        "<font color='#f9a825'>SOFT FAIL</font> = handled but abandoned (timeout) / no explicit "
        "end; <font color='#2e7d32'>GOOD</font> = clean end with none of the above.",
    ]
    if llm_enabled:
        method_items.append(
            f"<b>LLM judge ({llm_model}):</b> the headline verdicts and the "
            "per-conversation table above come from an OpenAI judge that <i>reads each "
            "transcript</i> against the same CHECKLIST.md rubric, deciding whether the "
            "user was actually helped (not just whether a flow reached its end node). The "
            "deterministic verdict is shown in the <font face='Courier'>det</font> column "
            "for comparison; the agreement rate between the two is on the summary page. "
            "Unlike the heuristic, LLM verdicts are not byte-reproducible across runs."
        )
    for item in method_items:
        story.append(Paragraph("• " + item, small))
        story.append(Spacer(1, 0.12 * cm))

    doc = SimpleDocTemplate(
        out_path,
        pagesize=A4,
        leftMargin=1.2 * cm,
        rightMargin=1.2 * cm,
        topMargin=1.2 * cm,
        bottomMargin=1.2 * cm,
        title="Quality of Bot Report",
    )
    doc.build(story)


# --- main -------------------------------------------------------------------
def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    start, end = resolve_window(args)
    try:
        client = BotpressClient()
    except BotpressError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(f"Window: {start} -> {end}", file=sys.stderr)
    print("Fetching analytics…", file=sys.stderr)
    records = client.get_analytics(start, end)

    judge_client = None
    judge_model = None
    if args.llm_judge:
        import llm_judge

        try:
            judge_client = llm_judge.make_client()
        except Exception as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        judge_model = args.llm_model or llm_judge.default_model()
        print(f"LLM judge enabled ({judge_model}).", file=sys.stderr)

    print("Fetching conversations…", file=sys.stderr)
    skipped_agent_side = 0
    handoffs = 0
    # Scan generously but only keep customer-facing bot conversations up to the
    # cap; agent-side (Zendesk/HITL) mirror conversations are skipped, not scored.
    scan_budget = max(args.max_conversations * 5, 250)
    bot_convs: list[dict[str, Any]] = []
    for conv in client.iter_conversations(after_date=start, before_date=end, max_items=scan_budget):
        if not conv.get("id"):
            continue
        if not scoring.is_bot_conversation(conv):
            skipped_agent_side += 1
            continue
        if scoring.was_handed_off(conv):
            handoffs += 1
        bot_convs.append(conv)
        if len(bot_convs) >= args.max_conversations:
            break

    # Per-conversation work (fetch messages + HITL, score, optionally LLM-judge)
    # is I/O-bound, so run it across a thread pool. Each worker uses the shared
    # clients, which are safe for concurrent independent requests.
    done = 0

    def process(conv: dict[str, Any]) -> scoring.ConversationScore:
        cid = conv["id"]
        messages = client.list_all_messages(cid)
        hitl = client.get_hitl_state(cid)
        score = scoring.score_conversation(conv, messages, hitl)
        score.handed_off = scoring.was_handed_off(conv)
        if judge_client is not None:
            import llm_judge

            verdict = llm_judge.judge_conversation(
                judge_client, conv, messages, score, score.handed_off, model=judge_model
            )
            if verdict is not None:
                llm_judge.attach_verdict(score, verdict)
        return score

    print(f"Scoring {len(bot_convs)} bot conversation(s) with {args.concurrency} workers…", file=sys.stderr)
    scores: list[scoring.ConversationScore] = []
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for score in pool.map(process, bot_convs):
            scores.append(score)
            done += 1
            if done % 25 == 0:
                print(f"  …{done}/{len(bot_convs)} scored", file=sys.stderr)

    print(
        f"Scored {len(scores)} bot conversation(s); skipped {skipped_agent_side} agent-side.",
        file=sys.stderr,
    )
    print(f"Rendering PDF -> {args.out}", file=sys.stderr)
    build_pdf(
        args.out,
        client.bot_id,
        start,
        end,
        records,
        scores,
        skipped_agent_side=skipped_agent_side,
        handoffs=handoffs,
        llm_enabled=bool(judge_client),
        llm_model=judge_model,
    )
    print(f"Done. {len(scores)} conversation(s) scored. Report at {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
