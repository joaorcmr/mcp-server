import streamlit as st
import plotly.graph_objects as go
import pandas as pd

# ==============================================================================
# 1) CONFIG + CSS (OMNI)
# ==============================================================================
st.set_page_config(layout="wide", page_title="Escalation Report - Bot vs Humano")

OMNI_DARK = "#000919"
OMNI_RH = "#215EC2"
OMNI_CANAIS = "#9CDBFF"
OMNI_NEUTRAL_1 = "#E6E6E6"
BACKGROUND_COLOR = "#F8F9FA"
TEXT_COLOR = "#000919"

C_GOOD = "#2e7d32"
C_BAD = "#c62828"
C_NEUTRAL = "#90a4ae"

def apply_global_css():
    st.markdown(
        f"""
        <style>
            [data-testid="stAppViewContainer"] {{
                background-color: {BACKGROUND_COLOR};
                color: {TEXT_COLOR};
            }}
            .main {{
                background-color: {BACKGROUND_COLOR};
                padding: 20px;
            }}
            .block-container {{
                padding-top: 1.5rem;
                padding-bottom: 1rem;
            }}
            .page-title {{
                font-size: 32px;
                font-weight: 800;
                color: {OMNI_DARK};
            }}
            .page-subtitle {{
                font-size: 16px;
                color: #666;
                margin-bottom: 18px;
            }}
            .kpi-card {{
                background-color: white;
                padding: 18px;
                border-radius: 12px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.05);
                border-left: 6px solid {OMNI_RH};
            }}
            .kpi-card.good {{ border-left-color: {C_GOOD}; }}
            .kpi-card.bad {{ border-left-color: {C_BAD}; }}
            .kpi-label {{
                font-size: 13px;
                color: #666;
                font-weight: 700;
                text-transform: uppercase;
            }}
            .kpi-value {{
                font-size: 34px;
                font-weight: 900;
                color: {OMNI_DARK};
                margin-top: 6px;
            }}
            .kpi-sub {{
                font-size: 12px;
                color: #888;
                margin-top: 2px;
            }}
            .note-box {{
                background: #ffffff;
                border: 1px solid {OMNI_NEUTRAL_1};
                border-radius: 12px;
                padding: 12px 14px;
                margin: 6px 0 14px 0;
                box-shadow: 0 2px 4px rgba(0,0,0,0.03);
                font-size: 14px;
                color: #333;
            }}
            .note-box b {{ color: {OMNI_DARK}; }}
        </style>
        """,
        unsafe_allow_html=True,
    )

apply_global_css()

def render_kpi(label, value, sub="", tone=""):
    cls = "kpi-card" + (f" {tone}" if tone else "")
    sub_html = f'<div class="kpi-sub">{sub}</div>' if sub else ""
    st.markdown(
        f"""
        <div class="{cls}">
            <div class="kpi-label">{label}</div>
            <div class="kpi-value">{value}</div>
            {sub_html}
        </div>
        """,
        unsafe_allow_html=True,
    )

def render_note(html_text: str):
    st.markdown(f'<div class="note-box">{html_text}</div>', unsafe_allow_html=True)

def format_int_br(value):
    return f"{int(value):,}".replace(",", ".")

def pct(part, whole):
    return (100 * part / whole) if whole else 0

# ==============================================================================
# 2) DATA (from escalation-report.pdf)
# ==============================================================================
# Source: report/escalation_report.py run — OpenAI judge gpt-5.5-2026-04-23.
# Window: 2026-06-19 -> 2026-06-26. Sample of 400 customer-facing bot conversations.
# The conversations themselves are NOT shown raw; the LLM judge already classified
# each one into a category, so we surface those classifications as histograms.
# Values are hardcoded aggregates (one-off judge run, not a live Snowflake table),
# following the same static-DataFrame pattern the KPIs dashboard uses for AI costs.

REPORT_META = {
    "bot_id": "4b12b2f4-fb00-4853-b512-798e907cbc50",
    "window": "2026-06-19 -> 2026-06-26",
    "judge_model": "OpenAI gpt-5.5-2026-04-23",
    "sample_size": 400,
    "escalated": 158,
    "not_escalated": 242,
    "agent_mirror_skipped": 345,
}

# Universe 1 — escalated to a human: was the handoff justified?
ESC_CORRECT = 115
ESC_UNNECESSARY = 43

# Human-readable labels for the judge's justification_category enum.
JUSTIFICATION_LABELS = {
    "data_inconsistency": "Inconsistência de dados",
    "prescription_validation": "Validação de receita",
    "complex_case": "Caso complexo",
    "direct_request": "Pedido direto de atendente",
    "user_frustration": "Frustração do usuário",
    "other": "Outros",
}

@st.cache_data
def q_justification_categories():
    data = [
        {"CATEGORIA": "data_inconsistency", "TOTAL": 47},
        {"CATEGORIA": "prescription_validation", "TOTAL": 35},
        {"CATEGORIA": "complex_case", "TOTAL": 19},
        {"CATEGORIA": "direct_request", "TOTAL": 13},
        {"CATEGORIA": "user_frustration", "TOTAL": 1},
    ]
    df = pd.DataFrame(data)
    df["LABEL"] = df["CATEGORIA"].map(JUSTIFICATION_LABELS).fillna(df["CATEGORIA"])
    return df

# Universe 2 — not escalated: should it have escalated, and what happened?
NOESC_MISSED = 24
NOESC_CORRECT = 218

# Human-readable labels for the judge's outcome_category enum.
OUTCOME_LABELS = {
    "user_abandoned": "Usuário abandonou",
    "info_provided_no_human_needed": "Info fornecida (sem humano)",
    "bot_deflected_no_resolution": "Bot desviou (sem resolução)",
    "outside_business_hours": "Fora do horário",
    "resolved_satisfied": "Resolvido e satisfeito",
    "other": "Outros",
}

@st.cache_data
def q_outcome_categories():
    data = [
        {"CATEGORIA": "user_abandoned", "TOTAL": 105},
        {"CATEGORIA": "info_provided_no_human_needed", "TOTAL": 56},
        {"CATEGORIA": "bot_deflected_no_resolution", "TOTAL": 30},
        {"CATEGORIA": "outside_business_hours", "TOTAL": 30},
        {"CATEGORIA": "resolved_satisfied", "TOTAL": 21},
    ]
    df = pd.DataFrame(data)
    df["LABEL"] = df["CATEGORIA"].map(OUTCOME_LABELS).fillna(df["CATEGORIA"])
    return df

# ==============================================================================
# 3) CHART HELPERS
# ==============================================================================
def build_pie(values, labels, colors, title):
    fig = go.Figure(
        go.Pie(
            values=values,
            labels=labels,
            marker=dict(colors=colors),
            textinfo="label+percent",
            textfont=dict(size=13),
            hole=0.0,
            sort=False,
        )
    )
    fig.update_layout(
        title=title,
        template="plotly_white",
        height=400,
        margin=dict(l=10, r=10, t=50, b=10),
        showlegend=False,
        font=dict(family="Source Sans Pro"),
    )
    return fig

def build_histogram(df, title, color, total):
    """Horizontal histogram of the judge's category classification."""
    df = df.sort_values("TOTAL", ascending=True).copy()
    df["PCT"] = (df["TOTAL"] / total * 100).round(0)
    fig = go.Figure()
    fig.add_bar(
        x=df["TOTAL"],
        y=df["LABEL"],
        orientation="h",
        marker_color=color,
        text=[f"{t}  ({p:.0f}%)" for t, p in zip(df["TOTAL"], df["PCT"])],
        textposition="outside",
    )
    fig.update_layout(
        title=title,
        template="plotly_white",
        height=max(320, 70 * len(df) + 120),
        margin=dict(l=10, r=40, t=50, b=10),
        xaxis=dict(gridcolor=OMNI_NEUTRAL_1, title="Conversas"),
        yaxis=dict(title=None),
        font=dict(family="Source Sans Pro"),
        showlegend=False,
    )
    # headroom so outside labels don't clip
    fig.update_xaxes(range=[0, df["TOTAL"].max() * 1.18])
    return fig

# ==============================================================================
# 4) UI
# ==============================================================================
st.markdown(
    '<div class="page-title">Escalation Report — Bot vs Humano</div>',
    unsafe_allow_html=True,
)
st.markdown(
    f'<div class="page-subtitle">Corretude da decisão de escalar (HITL) · '
    f'Janela {REPORT_META["window"]} · Juiz: {REPORT_META["judge_model"]}</div>',
    unsafe_allow_html=True,
)

# --- Top KPIs ---
c1, c2, c3, c4 = st.columns(4)
with c1:
    render_kpi("Conversas analisadas", format_int_br(REPORT_META["sample_size"]))
with c2:
    render_kpi(
        "Escaladas p/ humano",
        format_int_br(REPORT_META["escalated"]),
        sub=f'{pct(REPORT_META["escalated"], REPORT_META["sample_size"]):.0f}% do total',
    )
with c3:
    render_kpi(
        "Não escaladas",
        format_int_br(REPORT_META["not_escalated"]),
        sub=f'{pct(REPORT_META["not_escalated"], REPORT_META["sample_size"]):.0f}% do total',
    )
with c4:
    render_kpi(
        "Conversas espelho (agente) ignoradas",
        format_int_br(REPORT_META["agent_mirror_skipped"]),
    )

st.markdown("<br>", unsafe_allow_html=True)

tab1, tab2, tab3 = st.tabs(
    [
        "Universo 1 — Escaladas",
        "Universo 2 — Não escaladas",
        "Metodologia",
    ]
)

# ==============================================================================
# TAB 1 — ESCALATED (was the handoff justified?)
# ==============================================================================
with tab1:
    total_esc = ESC_CORRECT + ESC_UNNECESSARY
    st.markdown(
        f"**{total_esc} escalações julgadas.** "
        f"<span style='color:{C_GOOD}'>Corretas (justificadas): {ESC_CORRECT} "
        f"({pct(ESC_CORRECT, total_esc):.0f}%)</span> · "
        f"<span style='color:{C_BAD}'>Desnecessárias: {ESC_UNNECESSARY} "
        f"({pct(ESC_UNNECESSARY, total_esc):.0f}%)</span>.",
        unsafe_allow_html=True,
    )

    k1, k2, k3 = st.columns(3)
    with k1:
        render_kpi("Escalações julgadas", format_int_br(total_esc))
    with k2:
        render_kpi(
            "Corretas (justificadas)",
            f"{pct(ESC_CORRECT, total_esc):.0f}%",
            sub=f"{ESC_CORRECT} conversas",
            tone="good",
        )
    with k3:
        render_kpi(
            "Desnecessárias",
            f"{pct(ESC_UNNECESSARY, total_esc):.0f}%",
            sub=f"{ESC_UNNECESSARY} conversas",
            tone="bad",
        )

    col_a, col_b = st.columns([1, 1.3])
    with col_a:
        st.plotly_chart(
            build_pie(
                [ESC_CORRECT, ESC_UNNECESSARY],
                [f"Corretas ({ESC_CORRECT})", f"Desnecessárias ({ESC_UNNECESSARY})"],
                [C_GOOD, C_BAD],
                "Corretude da escalação",
            ),
            use_container_width=True,
        )
    with col_b:
        df_j = q_justification_categories()
        st.plotly_chart(
            build_histogram(
                df_j, "Por que a escalação foi justificada", C_GOOD, ESC_CORRECT
            ),
            use_container_width=True,
        )

    render_note(
        f"""
        Das <b>{total_esc}</b> conversas em que o bot escalou para um humano,
        <b>{ESC_CORRECT} ({pct(ESC_CORRECT, total_esc):.0f}%)</b> foram
        escalações corretas e <b>{ESC_UNNECESSARY} ({pct(ESC_UNNECESSARY, total_esc):.0f}%)</b>
        foram desnecessárias (o bot poderia ter resolvido em autoatendimento).<br><br>
        O histograma classifica as <b>escalações justificadas</b> por motivo — os
        principais gatilhos legítimos são <b>inconsistência de dados</b> e
        <b>validação de receita</b>, ambos exigem análise humana.
        """
    )

# ==============================================================================
# TAB 2 — NOT ESCALATED (should it have? what happened?)
# ==============================================================================
with tab2:
    total_noesc = NOESC_MISSED + NOESC_CORRECT
    st.markdown(
        f"**{total_noesc} não-escalações julgadas.** "
        f"<span style='color:{C_BAD}'>Deveria ter escalado (perdidas): {NOESC_MISSED} "
        f"({pct(NOESC_MISSED, total_noesc):.0f}%)</span> · "
        f"<span style='color:{C_GOOD}'>Corretamente não escaladas: {NOESC_CORRECT} "
        f"({pct(NOESC_CORRECT, total_noesc):.0f}%)</span>.",
        unsafe_allow_html=True,
    )

    k1, k2, k3 = st.columns(3)
    with k1:
        render_kpi("Não-escalações julgadas", format_int_br(total_noesc))
    with k2:
        render_kpi(
            "Corretamente não escaladas",
            f"{pct(NOESC_CORRECT, total_noesc):.0f}%",
            sub=f"{NOESC_CORRECT} conversas",
            tone="good",
        )
    with k3:
        render_kpi(
            "Escalações perdidas",
            f"{pct(NOESC_MISSED, total_noesc):.0f}%",
            sub=f"{NOESC_MISSED} conversas",
            tone="bad",
        )

    col_a, col_b = st.columns([1, 1.3])
    with col_a:
        st.plotly_chart(
            build_pie(
                [NOESC_CORRECT, NOESC_MISSED],
                [
                    f"Corretas ({NOESC_CORRECT})",
                    f"Perdidas ({NOESC_MISSED})",
                ],
                [C_GOOD, C_BAD],
                "Corretude da não-escalação",
            ),
            use_container_width=True,
        )
    with col_b:
        df_o = q_outcome_categories()
        st.plotly_chart(
            build_histogram(
                df_o, "O que aconteceu (categoria de desfecho)", OMNI_RH, total_noesc
            ),
            use_container_width=True,
        )

    render_note(
        f"""
        Das <b>{total_noesc}</b> conversas que o bot <b>não</b> escalou,
        <b>{NOESC_CORRECT} ({pct(NOESC_CORRECT, total_noesc):.0f}%)</b> estavam corretas
        e apenas <b>{NOESC_MISSED} ({pct(NOESC_MISSED, total_noesc):.0f}%)</b> deveriam
        ter sido encaminhadas a um humano.<br><br>
        O histograma mostra o <b>desfecho real</b> dessas conversas. O maior grupo é
        <b>usuário abandonou</b> (105), seguido de <b>info fornecida sem necessidade de
        humano</b> (56) — indicando que boa parte não precisava de atendente.
        """
    )

# ==============================================================================
# TAB 3 — METHODOLOGY
# ==============================================================================
with tab3:
    render_note(
        f"""
        <b>Escopo:</b> apenas conversas do bot voltadas ao cliente são analisadas.
        Um handoff HITL cria uma conversa-espelho do lado do agente (Zendesk), que é
        excluída (<b>{REPORT_META['agent_mirror_skipped']}</b> ignoradas).
        """
    )
    render_note(
        """
        <b>Detecção de escalação:</b> a conversa do lado do cliente carrega a tag
        <code>hitl#downstream</code> (persiste após o handoff fechar) ou um estado
        <code>hitl#hitl</code> ativo. Apenas <i>entrar</i> em um workflow de HITL sem
        efetivar o handoff não conta.
        """
    )
    render_note(
        f"""
        <b>Juiz LLM ({REPORT_META['judge_model']}):</b> lê cada transcrição e os sinais
        determinísticos. Para conversas escaladas retorna
        <code>escalation_justified</code> + categoria; para não escaladas
        <code>should_have_escalated</code> + categoria de desfecho. Rubrica baseada no
        CHECKLIST.md e no playbook de escalação do bot.<br><br>
        <b>Nota:</b> as conversas brutas não são exibidas — as classificações do juiz
        são agregadas nos histogramas acima. Os veredictos do LLM não são
        byte-reproduzíveis entre execuções; para re-rodar o julgamento use
        <code>python report/escalation_report.py --days 7 --sample-size 400</code>.
        """
    )
