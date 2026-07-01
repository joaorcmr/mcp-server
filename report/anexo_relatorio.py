#!/usr/bin/env python3
"""Anexo ao Escalation Report — falha de handoff HITL (escalonamento que não
acontece por erro de integração, e não por decisão do bot).

Gera um PDF de anexo, auto-contido, com três partes pedidas:
  1. A conversa real (caso "deveria ter escalado e não escalou").
  2. A causa do erro, mapeada via logs do bot (getBotLogs / stack trace).
  3. A incidência: quantas OUTRAS conversas sofreram o mesmo no período de 7 dias.

Os dados foram coletados manualmente via tools do MCP Botpress (list_messages /
get_bot_logs) na janela 2026-06-22 → 2026-06-29 e estão embutidos aqui de forma
estática — este anexo documenta um achado pontual, não um pipeline recorrente.

    python report/anexo_relatorio.py
    python report/anexo_relatorio.py --out report/anexo_relatorio.pdf
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

# Paleta reutilizada do escalation_report.py para consistência visual.
C_GOOD = colors.HexColor("#2e7d32")
C_BAD = colors.HexColor("#c62828")
C_WARN = colors.HexColor("#f9a825")
C_HEAD = colors.HexColor("#263238")
C_GRID = colors.HexColor("#cfd8dc")

WINDOW = "2026-06-22 → 2026-06-29 (últimos 7 dias)"
BOT_ID = "Omni Saúde / Vitta (WhatsApp)"

# --- Parte 1: a conversa (caso principal) -----------------------------------
CASE_ID = "conv_01KW9T4RWB1NFNB6FEWJDXMFHC"
CASE_PHONE = "+55 92 9409-7400"
CASE_WHEN = "29/06/2026, ~13:47–13:52 (horário comercial)"

# (quem, texto). "BOT»wf" e "SYS" são anotações leves.
TRANSCRIPT: list[tuple[str, str]] = [
    ("USER", "Bomdia"),
    ("BOT", "Olá, bem-vindo ao suporte da Omni Saúde! 💙"),
    ("BOT", "[escolha] Você está na farmácia? (Sim/Não)"),
    ("USER", "Bom dia. Eu gostaria de trocar o cupom fiscal anexado na compra com "
             "bônus. A imagem ficou muito longe e por isso não tá aprovada, fica "
             "em análise o tempo todo"),
    ("USER", "Essa imagem está legível, preciso anexar essa"),
    ("USER", "[imagem] + [arquivo: NF hidroxicloroquina 27062026.jpg]"),
    ("USER", "Não  (resposta a 'Você está na farmácia?')"),
    ("BOT", "Por favor, digite seu CPF"),
    ("USER", "69821526268"),
    ("BOT", "Não encontramos os seus dados em nosso sistema, mas estamos aqui para "
            "ajudar com qualquer dúvida que você tenha!"),
    ("BOT", "Como podemos te ajudar?"),
    ("BOT", "Obrigado por informar seu CPF. Entendo que você gostaria de trocar o "
            "cupom fiscal anexado na compra com bônus..."),
    ("BOT", "Para resolver isso, você pode anexar a nova imagem diretamente no "
            "aplicativo. Acesse a aba 'Histórico'... e anexe a imagem legível."),
    ("USER", "Não está com pendência, está EM ANÁLISE faz 3 dias"),
    ("BOT", "Entendo que seu cupom fiscal está em análise há 3 dias... Você "
            "receberá uma notificação assim que a análise for concluída..."),
    ("USER", "Eu gostaria de trocar a imagem anexada em cupom fiscal para uma mais legível"),
    ("BOT", "Entendo que você gostaria de trocar a imagem... acesse a aba "
            "'Histórico'... anexe a nova imagem legível."),
    ("USER", "Preciso falar com atendente   ← PEDIDO DIRETO DE HUMANO"),
    ("BOT", "Vou te conectar com um atendente agora para verificar seu cupom. Por "
            "favor, aguarde um instante."),
    ("BOT", "«inconsistência» Um de nossos especialistas avaliará seu caso em "
            "breve. Nosso sistema identificou alguma inconsistência em sua última compra..."),
    ("BOT", "«plugin://hitl» , você será atendido em breve!"),
    ("SYS", "✗ startHitl falhou (HTTP 400 _linkUser) — handoff NÃO completou"),
    ("BOT", "Desculpe, não consegui conectar você a um atendente no momento. Por "
            "favor, tente novamente mais tarde ou posso te ajudar com mais alguma "
            "informação sobre o cupom fiscal?"),
    ("USER", "Preciso falar com atendente   ← PEDE DE NOVO"),
    ("BOT", "Entendido. Vou tentar te conectar com um atendente novamente. Por "
            "favor, aguarde um instante."),
    ("BOT", "«inconsistência» Um de nossos especialistas avaliará seu caso em breve..."),
    ("BOT", "«plugin://hitl» , você será atendido em breve!"),
    ("USER", "Vou ficar aguardando"),
    ("SYS", "✗ startHitl falhou de novo (mesmo erro, mesmo id) — handoff NÃO completou"),
    ("BOT", "Desculpe, não consegui conectar você a um atendente no momento. Por "
            "favor, tente novamente mais tarde... [FIM — cliente esperando, "
            "nenhum humano notificado]"),
]

# --- Parte 3: incidência (7 dias) -------------------------------------------
INCIDENTS = [
    # data, conversa, fluxo, causa, desfecho
    ["22/06 12:10", "conv_01KRDYE9…", "(HITL) SLA Workflow\n(Receita)",
     "HTTP 400 — _linkUser /\ngetDownstreamUserId", "Loop de 'reconectar?';\nsem humano"],
    ["23/06 21:51", "conv_01KVV6R5…", "(HITL) Solve\nInconsistency",
     "TimeoutError\n(>10s ao enviar msg)", "Encerrada por\ninatividade; sem humano"],
    ["29/06 13:50", "conv_01KW9T4R…", "(HITL) Solve\nInconsistency",
     "HTTP 400 — _linkUser /\ngetDownstreamUserId", "Cliente abandonado\n(caso deste anexo)"],
    ["29/06 13:52", "conv_01KW9T4R…", "(HITL) Solve\nInconsistency",
     "HTTP 400 — _linkUser\n(2ª tentativa, mesmo id)", "Idem (retry falhou\nidêntico)"],
]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Gera o anexo_relatorio.pdf.")
    p.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parent / "anexo_relatorio.pdf"),
        help="Caminho do PDF de saída.",
    )
    return p.parse_args(argv)


def build(out_path: str) -> None:
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle("Small", parent=styles["Normal"], fontSize=8.5, leading=11))
    styles.add(ParagraphStyle("Mono", parent=styles["Normal"], fontName="Courier",
                              fontSize=7.2, leading=9))
    styles.add(ParagraphStyle("MonoErr", parent=styles["Normal"], fontName="Courier",
                              fontSize=6.8, leading=8.2, textColor=C_BAD))
    h1, h2, h3 = styles["Title"], styles["Heading2"], styles["Heading3"]
    body, small, mono = styles["Normal"], styles["Small"], styles["Mono"]
    story: list[Any] = []

    # ---- Capa ----
    story.append(Paragraph("Anexo ao Escalation Report", h1))
    story.append(Paragraph("Falha de handoff HITL — escalonamento que não acontece "
                           "por erro de integração (não por decisão do bot)", h3))
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(f"Bot: <b>{BOT_ID}</b>", body))
    story.append(Paragraph(f"Janela analisada: {WINDOW}", small))
    story.append(Paragraph("Fonte: tools MCP Botpress — list_messages (transcrição) e "
                           "get_bot_logs / getBotLogs (logs e stack trace).", small))
    story.append(Spacer(1, 0.4 * cm))
    story.append(Paragraph(
        "<b>Resumo:</b> No relatório principal, este caso cai no Universo 2 (não "
        "escalado). A leitura ingênua seria 'o bot resolveu sozinho'. Na verdade, o "
        "bot <b>decidiu corretamente escalar</b> — o cliente pediu humano "
        "explicitamente e havia inconsistência de compra, em horário comercial — mas "
        "a ação <font face='Courier'>hitl:startHitl</font> <b>falhou na integração "
        "(Zendesk)</b>. Como a conversa do cliente nunca recebe a tag "
        "<font face='Courier'>hitl#downstream</font>, ela é contabilizada como 'não "
        "escalou'. É um falso negativo de escalonamento causado por falha de infra, "
        "que abandona o cliente em silêncio.", small))

    # ---- Parte 1: a conversa ----
    story.append(PageBreak())
    story.append(Paragraph("1. A conversa", h2))
    meta = (f"<font face='Courier'>{CASE_ID}</font> · telefone {CASE_PHONE} · "
            f"{CASE_WHEN} · sem <font face='Courier'>hitl#downstream</font> → "
            f"classificada como NÃO escalada")
    story.append(Paragraph(meta, small))
    story.append(Spacer(1, 0.2 * cm))

    rows = [["", "Transcrição (cronológica)"]]
    for who, text in TRANSCRIPT:
        rows.append([who, Paragraph(text, mono)])
    t = Table(rows, colWidths=[1.6 * cm, 16.4 * cm])
    tstyle = [
        ("BACKGROUND", (0, 0), (-1, 0), C_HEAD),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8.5),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 1), (0, -1), 7),
        ("GRID", (0, 0), (-1, -1), 0.3, C_GRID),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 1), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 2),
    ]
    for i, (who, _) in enumerate(TRANSCRIPT, start=1):
        if who == "USER":
            tstyle.append(("TEXTCOLOR", (0, i), (0, i), colors.HexColor("#1565c0")))
        elif who == "SYS":
            tstyle.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#fdecea")))
            tstyle.append(("TEXTCOLOR", (0, i), (-1, i), C_BAD))
    t.setStyle(TableStyle(tstyle))
    story.append(t)
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(
        "<b>Por que deveria ter escalado:</b> (a) pedido direto de atendente, repetido; "
        "(b) inconsistência de compra detectada pelo próprio sistema; (c) em horário "
        "comercial. Todos são gatilhos de handoff do playbook. O bot tentou — e falhou.",
        small))

    # ---- Parte 2: causa ----
    story.append(PageBreak())
    story.append(Paragraph("2. Causa do erro (mapeada via logs)", h2))
    story.append(Paragraph(
        "A lógica de escalonamento executou inteira e corretamente. O fluxo "
        "<font face='Courier'>(HITL) Solve Inconsistency Workflow</font> passou por "
        "todos os gates antes de chamar a integração:", small))
    gate_rows = [
        ["Passo", "Resultado"],
        ["Entrada no fluxo HITL", "OK — a partir de '9. Nota Fiscal'"],
        ["conversation.n1 === true", "OK — tier N1 (horário comercial)"],
        ["Check_CH (horário comercial)", "OK — 'Dia útil', isCommercialHour === true"],
        ["user.isVip == false", "OK"],
        ["card: Start HITL → hitl:startHitl", "✗ ERRO — HTTP 400 na integração"],
    ]
    gt = Table(gate_rows, colWidths=[8.0 * cm, 9.0 * cm])
    gt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), C_HEAD),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("GRID", (0, 0), (-1, -1), 0.3, C_GRID),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#eceff1")]),
        ("TEXTCOLOR", (1, 5), (1, 5), C_BAD),
        ("FONTNAME", (1, 5), (1, 5), "Helvetica-Bold"),
    ]))
    story.append(Spacer(1, 0.2 * cm))
    story.append(gt)
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph("Stack trace registrado (nível ERROR):", small))
    err = (
        "Error executing action hitl:startHitl\n"
        "xr [Error]: An unexpected error occurred in the integration.\n"
        "    at async Object._linkUser           (customer_code.js:4295:65575)\n"
        "    at async Object.getDownstreamUserId  (customer_code.js:4295:65264)\n"
        "    at async startHitl                   (customer_code.js:4295:66834)\n"
        "    at async executeActionPlugin         (customer_code.js:3077:1452)\n"
        "  isApiError: true,  code: 400,  type: 'Runtime',\n"
        "  id: '73bdd4d44f6bdd1f3169141b3dfa9e87'"
    )
    for line in err.split("\n"):
        story.append(Paragraph(line.replace(" ", "&nbsp;"), styles["MonoErr"]))
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(
        "<b>O que falhou:</b> o <font face='Courier'>startHitl</font> quebrou "
        "<i>antes</i> de criar o ticket, no passo "
        "<font face='Courier'>getDownstreamUserId → _linkUser</font> — ou seja, ao "
        "criar/vincular no Zendesk o usuário 'downstream' que receberia o handoff. A "
        "integração devolveu HTTP 400 (Runtime).", small))
    story.append(Spacer(1, 0.1 * cm))
    story.append(Paragraph(
        "<b>Gatilho provável:</b> este contato <b>não estava cadastrado</b> ('Não "
        "encontramos os seus dados em nosso sistema'). O fluxo então sintetiza um "
        "e-mail a partir do CPF (card 'Create new email address using user's CPF.') e "
        "o Zendesk rejeita a criação/vínculo desse end-user. As duas tentativas "
        "falharam de forma idêntica (mesmo <font face='Courier'>id</font> de erro), "
        "logo <b>retry não resolve</b> para este contato.", small))
    story.append(Spacer(1, 0.1 * cm))
    story.append(Paragraph(
        "<b>Agravantes de robustez:</b> (1) o fallback trata falha de infra como se "
        "fosse 'sem atendente disponível' e <b>não cria fila/ticket nem retém o "
        "caso</b>; (2) <b>não há alerta</b> sobre o ERROR — a falha é totalmente "
        "silenciosa.", small))

    # ---- Parte 3: incidência ----
    story.append(PageBreak())
    story.append(Paragraph("3. Incidência nos últimos 7 dias", h2))
    story.append(Paragraph(
        "Busca em <font face='Courier'>getBotLogs</font> (22/06 → 29/06) pelas "
        "assinaturas <font face='Courier'>Error executing action hitl:startHitl</font> "
        "e <font face='Courier'>Error executing card \"card:Start HITL\"</font>.", small))
    story.append(Spacer(1, 0.2 * cm))

    inc_rows = [["Data", "Conversa", "Fluxo", "Causa", "Desfecho"]]
    for r in INCIDENTS:
        inc_rows.append([
            r[0],
            Paragraph(f"<font face='Courier' size=7>{r[1]}</font>", small),
            Paragraph(r[2], small),
            Paragraph(r[3], small),
            Paragraph(r[4], small),
        ])
    it = Table(inc_rows, colWidths=[2.3 * cm, 3.0 * cm, 3.4 * cm, 4.2 * cm, 4.1 * cm])
    it.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), C_HEAD),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.3, C_GRID),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#eceff1")]),
    ]))
    story.append(it)
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(
        "<b>Total: 4 eventos de erro em 3 conversas distintas</b> (o caso deste anexo "
        "tentou 2×). Em <b>nenhuma</b> das três o cliente chegou a um humano.", body))
    story.append(Spacer(1, 0.15 * cm))
    bullets = [
        "<b>2 das 3 conversas</b> falharam com a assinatura idêntica "
        "<font face='Courier'>_linkUser</font> HTTP 400 (Zendesk) — 22/06 e 29/06.",
        "<b>1 das 3</b> falhou por <font face='Courier'>TimeoutError</font> (&gt;10s) — "
        "causa diferente, mesmo desfecho: handoff não completou.",
        "Atinge <b>os dois fluxos HITL</b> — (HITL) SLA Workflow e (HITL) Solve "
        "Inconsistency — logo não é específico de um fluxo.",
        "O fallback é <b>inconsistente entre fluxos</b>: o SLA oferece 'tentar "
        "reconectar?', o de Inconsistência apenas diz 'tente mais tarde' e encerra. "
        "Nenhum dos dois cria ticket.",
        "<b>Subcontagem provável:</b> contam-se aqui apenas falhas que geraram log de "
        "ERROR com esta assinatura; modos de falha silenciosos não apareceriam.",
    ]
    for b in bullets:
        story.append(Paragraph("• " + b, small))
        story.append(Spacer(1, 0.08 * cm))

    story.append(Spacer(1, 0.25 * cm))
    story.append(Paragraph("Recomendações", h3))
    recs = [
        "Tornar o <font face='Courier'>startHitl</font> resiliente a contato sem "
        "cadastro: validar/normalizar o e-mail sintetizado do CPF ou usar um "
        "identificador alternativo aceito pelo Zendesk antes do <font "
        "face='Courier'>_linkUser</font>.",
        "Em falha de infra, <b>não encerrar</b>: criar ticket/fila assíncrona ou "
        "registrar o caso para retomada por um humano, em vez de 'tente mais tarde'.",
        "Padronizar o fallback de erro de handoff entre os fluxos HITL.",
        "Adicionar alerta/monitor sobre <font face='Courier'>hitl:startHitl</font> "
        "falhando (esses ERROR hoje passam despercebidos).",
    ]
    for r in recs:
        story.append(Paragraph("• " + r, small))
        story.append(Spacer(1, 0.08 * cm))

    SimpleDocTemplate(out_path, pagesize=A4, leftMargin=1.5 * cm, rightMargin=1.5 * cm,
                      topMargin=1.4 * cm, bottomMargin=1.4 * cm,
                      title="Anexo — Falha de handoff HITL").build(story)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    build(args.out)
    print(f"Anexo gerado em {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
