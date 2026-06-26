# Conversation Quality Checklist

What makes a bot conversation **"good"** — judged on three axes: **tools/flows used**, **intent correctly
registered**, and **problem solved**. Every item lists the *signal* to look for and *how to verify it* with
the MCP tools in this server (plus Botpress observability endpoints worth wiring up).

This checklist is grounded in real conversation data from the Omni Saúde WhatsApp bot (see the worked
example at the bottom).

---

## How to pull a conversation for review

1. `list_conversations` — find the conversation. Phone lives in the tag `whatsapp:userPhone`
   (⚠️ format drift: newer convs store it **with** `+`, e.g. `+5511981063002`, older ones **without** —
   query both). Filter by `integrationName: "whatsapp"` (NOT `channel` — the channel field is literally
   `"channel"`).
2. `list_messages` with the `conversationId` — full transcript, newest first. Each message exposes
   `direction`, `type`, `text`, `payload`, and `tags`.
3. `get_bot_logs` (`timeStart` required) — runtime log lines for errors/traces, filterable by
   `conversationId`.
4. `get_state` on `hitl#hitl` — check if the conversation is paused in human handoff
   (`{ "hitlActive": true }`).

---

## Axis 1 — Tools / flows used correctly

The single most useful signal: **every outgoing bot message carries an `origin` tag** of the form
`workflow://<workflowId>/node/<nodeId>/card/<cardId>`. Reading the sequence of `origin` values reconstructs
exactly which flows and cards the bot executed.

- [ ] **Right workflow handled the request.** The `origin` workflow matches the user's need
      (e.g. a purchase request runs through `wf-main`'s purchase nodes, not an error/fallback node).
- [ ] **Data-lookup tools actually ran and succeeded.** When the user identifies themselves (CPF, wallet),
      the bot replies with *resolved* data ("Empresa: …, Plano: …, Saldo: …"), not the fallback
      "Não encontramos os seus dados em nosso sistema". A fallback after a valid ID = a failed lookup tool.
- [ ] **No error/exception flow fired.** No `origin` pointing at an error-handler node; `get_bot_logs`
      shows no `level: "error"` for the conversation.
- [ ] **Structured prompts used where appropriate.** `type: "choice"` messages (with `payload.options`)
      for yes/no or menu steps, and the user's reply carries `whatsapp:replyTo` linking back to the prompt —
      confirms the choice was answered, not free-typed past.
- [ ] **No redundant repetition.** The same node/card `origin` shouldn't repeat back-to-back (e.g. asking
      "digite seu CPF" twice in a row = a loop / validation problem).
- [ ] **HITL used only when warranted.** A `startHitl` (state `hitl#hitl` → `hitlActive: true`) should
      correspond to a genuine escalation, not an accidental dead-end. See Axis 3.

## Axis 2 — Intent correctly registered

- [ ] **First user message routed to the matching flow.** Compare the user's opening intent
      ("Preciso fazer uma compra.") against the `origin` of the bot's next outgoing message — it should land
      in the corresponding workflow branch.
- [ ] **No misclassification / wrong-branch.** The bot doesn't answer a purchase request with an unrelated
      flow, and doesn't drop to the generic "Como podemos te ajudar?" when a clear intent was stated.
- [ ] **Slots filled from the right entities.** Identifiers the user provided (CPF, company) are echoed back
      correctly in later messages — proves the value was captured into the right variable, not lost.
- [ ] **KB/AI answers are on-topic.** For `wf` nodes backed by a knowledge base or LLM card, the answer
      addresses the actual question (cross-check with `list_knowledge_bases` / the KB the node uses).
- [ ] **Disambiguation when ambiguous.** If intent is unclear, the bot asks a clarifying `choice` rather
      than guessing.

## Axis 3 — Problem solved (resolution)

- [ ] **Reached a clean end state.** The transcript ends in `wf-conversation-end`
      ("o seu atendimento foi encerrado ✅") — the explicit "resolved" signal.
- [ ] **Not abandoned by timeout.** Ending in `wf-timeout` ("Notamos que você está ausente…") means the
      user dropped off mid-task — a *soft* failure worth investigating, not a resolution.
- [ ] **Not stuck in HITL.** `get_state hitl#hitl` is `false` **or** the conversation tags carry
      `hitl#hitlEndReason: agent-closed-ticket`. A conversation with `hitlActive: true` and **no**
      `hitl#hitlEndReason` is silently parked — the bot ignores every inbound message. (Root-cause &
      remediation: use `release_hitl`. The bot defines `startHitl` in 19 nodes and `stopHitl` in 0, with no
      inactivity auto-release, so this is the #1 silent-failure mode.)
- [ ] **Responsiveness.** Every `incoming` message is followed by an `outgoing` within a reasonable window.
      A trailing run of `incoming`-only messages with no reply = the bot stopped responding (classic stuck-HITL
      fingerprint).
- [ ] **No dangling questions.** The conversation doesn't end on a bot `choice`/question the user never got
      to answer because the flow died.
- [ ] **CSAT / NPS captured when applicable.** If the flow collects feedback (`Feedback`, `NPS` variables),
      a resolved conversation should have it recorded.

---

## Quick triage rubric

| Verdict | Looks like |
|---------|-----------|
| ✅ Good | Intent → correct `wf-main` branch → data tools resolved real data → user served → `wf-conversation-end`. No errors, no stuck HITL. |
| ⚠️ Soft fail | Handled correctly but ended in `wf-timeout` (user abandoned), or HITL closed properly but slowly. |
| ❌ Hard fail | Stuck HITL (`hitlActive: true`, no `hitlEndReason`, trailing incoming-only messages), failed data lookup loop, error flow, or wrong-intent routing. |

---

## Observability endpoints (Botpress) — wired vs. worth adding

Source: <https://botpress.com/docs/api-reference/introduction> + the docs index.

**Already wrapped as MCP tools:**
- Runtime `GET /v1/chat/conversations` → `list_conversations`
- Runtime `GET /v1/chat/messages` → `list_messages`
- Admin `GET /v1/admin/bots/{botId}/logs` → `get_bot_logs`
- Admin `GET /v1/admin/bots/{botId}/analytics` → `get_bot_analytics` (volume/usuários/sessões + uso de LLM,
  em buckets diários — a fonte do painel de Analytics)
- Runtime state `GET/PATCH/POST /v1/chat/states/...` → `get_state` / `patch_state` / `set_state` (+ `release_hitl`)

**Not yet wrapped — high value for this checklist:**
- **`GET /v1/chat/events`** (+ `/{eventId}`) — the event stream behind a conversation: workflow starts,
  intent/NLU events, card executions. The richest source for Axis 1 & 2 ("which tool ran, which intent
  registered") beyond what `origin` tags give. **Strongest candidate to add next.**
- **`GET /v1/admin/bots/{botId}/issues`** (+ `POST`, + `/issues/events`) — Botpress-detected bot issues and
  their event history; a ready-made "what's going wrong" feed.
- **`GET /v1/admin/integrations/{integrationId}/logs`** — integration-side logs (e.g. Zendesk/WhatsApp
  delivery) for diagnosing handoff/delivery failures the bot logs don't show.
- **`GET /v1/admin/workspaces/{workspaceId}/audit-records`** — who changed what, newest first
  (governance / change correlation).
- **`GET /v1/chat/conversations/{id}`** — single-conversation detail (lighter than listing).

---

## Worked example

`conv_01KVWQ565GJQHH0ZSNMSRA97H5` (+5511999985717), 19 messages, 2026-06-24:

- **Intent:** user opens with *"Preciso fazer uma compra."* → next bot message `origin` is
  `wf-main/.../nd-6b6b5955cb` welcome + a `choice` "Você está na farmácia?" → **correctly routed.** ✅
- **Tools:** answered "Sim" (`whatsapp:replyTo` links it) → `wf-main` asks CPF → user sends CPF → data-lookup
  resolves real wallet ("SW DROGARIA LTDA / Genérico 100 / Saldo R$100"). **Lookup tool succeeded.** ✅
- **Resolution:** later closes via `wf-conversation-end` ("atendimento foi encerrado ✅"). A separate earlier
  branch had hit `wf-timeout` ("Notamos que você está ausente") — that segment was a ⚠️ soft abandon, but the
  final segment resolved. **Mixed, ultimately resolved.**
- **HITL:** no `hitl#hitlActive`/`hitl#downstream` tags → never escalated, fully self-served. ✅

Contrast with `conv_01KJCTF7GH1V3YFXW33P6WD9PB` (+5511981063002): `hitlActive` was `true` with no
`hitl#hitlEndReason`, trailing incoming-only messages for 2+ months → **❌ hard fail (stuck HITL).** Fixed via
`release_hitl`.
