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
) -> None:
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle("Small", parent=styles["Normal"], fontSize=8, leading=10))
    h1 = styles["Title"]
    h2 = styles["Heading2"]
    body = styles["Normal"]
    small = styles["Small"]

    story: list[Any] = []
    totals = sum_analytics(records)
    verdict_counts: Counter = Counter(s.verdict for s in scores)
    n = len(scores) or 1

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
    quality_rows = [
        ["Qualitative (CHECKLIST.md)", ""],
        ["Bot conversations scored", f"{len(scores):,}"],
        ["GOOD", f"{verdict_counts.get(scoring.GOOD, 0)} ({pct(scoring.GOOD)})"],
        ["SOFT FAIL", f"{verdict_counts.get(scoring.SOFT_FAIL, 0)} ({pct(scoring.SOFT_FAIL)})"],
        ["HARD FAIL", f"{verdict_counts.get(scoring.HARD_FAIL, 0)} ({pct(scoring.HARD_FAIL)})"],
        ["Resolution rate (GOOD)", f"{resolution_rate:.0f}%"],
        ["Handoffs to human", f"{handoffs:,}"],
        ["Agent-side convs skipped", f"{skipped_agent_side:,}"],
    ]

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

    # --- 4. Per-conversation table ---
    story.append(PageBreak())
    story.append(Paragraph("Per-conversation scores (worst first)", h2))
    if scores:
        rank = {scoring.HARD_FAIL: 0, scoring.SOFT_FAIL: 1, scoring.GOOD: 2}
        ordered = sorted(scores, key=lambda s: (rank.get(s.verdict, 3), -s.message_count))
        header = ["Conversation", "Phone", "Verdict", "End state", "HITL", "Msgs", "Top failed checks"]
        table_rows = [header]
        verdict_cell_styles = []
        for i, s in enumerate(ordered, start=1):
            failed = ", ".join(s.failed_checks[:3]) or "—"
            table_rows.append(
                [
                    Paragraph(s.conversation_id, small),
                    s.phone or "—",
                    VERDICT_LABEL[s.verdict],
                    s.end_state,
                    s.hitl_status,
                    str(s.message_count),
                    Paragraph(failed, small),
                ]
            )
            verdict_cell_styles.append(
                ("TEXTCOLOR", (2, i), (2, i), VERDICT_COLORS[s.verdict])
            )
        t = Table(
            table_rows,
            colWidths=[4.6 * cm, 2.6 * cm, 2 * cm, 2.6 * cm, 1.9 * cm, 1.1 * cm, 6.2 * cm],
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

    print("Fetching conversations…", file=sys.stderr)
    scores: list[scoring.ConversationScore] = []
    skipped_agent_side = 0
    handoffs = 0
    # Scan generously but only count customer-facing bot conversations toward the
    # cap; agent-side (Zendesk/HITL) mirror conversations are skipped, not scored.
    scan_budget = max(args.max_conversations * 5, 250)
    for conv in client.iter_conversations(after_date=start, before_date=end, max_items=scan_budget):
        cid = conv.get("id")
        if not cid:
            continue
        if not scoring.is_bot_conversation(conv):
            skipped_agent_side += 1
            continue
        if scoring.was_handed_off(conv):
            handoffs += 1
        messages = client.list_all_messages(cid)
        hitl = client.get_hitl_state(cid)
        scores.append(scoring.score_conversation(conv, messages, hitl))
        if len(scores) % 25 == 0:
            print(f"  …{len(scores)} scored", file=sys.stderr)
        if len(scores) >= args.max_conversations:
            break

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
    )
    print(f"Done. {len(scores)} conversation(s) scored. Report at {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
