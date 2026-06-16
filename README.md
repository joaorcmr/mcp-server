# Botpress MCP Server

Servidor [MCP](https://modelcontextprotocol.io) que conecta o **Claude Code** ao **Botpress**, funcionando como camada adaptadora:

```
Claude Code → MCP Server (este projeto) → API do Botpress → Bot/Workspace
```

O Claude Code chama "tools" simples (ex.: `send_message_to_botpress`) e o servidor traduz essas chamadas para a API do Botpress.

## Duas APIs do Botpress (importante)

O Botpress expõe duas APIs diferentes, e este servidor já está preparado para ambas:

| API | Base URL | Autenticação | Para quê |
|-----|----------|--------------|----------|
| **Chat API** | `https://chat.botpress.cloud/{webhookId}` | header `x-user-key` (JWT de usuário, gerenciado pelo SDK) | **Conversar** com o bot — enviar mensagens e receber respostas |
| **Management API** | `https://api.botpress.cloud` | Bearer `BOTPRESS_TOKEN` + `x-bot-id` + `x-workspace-id` | **Gerenciar** o bot — tabelas, bases de conhecimento, info do bot, etc. |

> O MVP `send_message_to_botpress` usa a **Chat API**, que precisa de um **`BOTPRESS_WEBHOOK_ID`** (e **não** do PAT token). As tools futuras (`list_tables`, `query_knowledge_base`, `get_bot_info`...) usarão a Management API com o `BOTPRESS_TOKEN`.

## Estrutura

```
src/
  index.ts                          # entrypoint: cria o McpServer e registra as tools (stdio)
  config/
    env.ts                          # leitura/validação das variáveis de ambiente
  botpress/
    botpress-client.ts              # camada de chamadas à API do Botpress (Chat API)
    errors.ts                       # normaliza erros em um formato legível
  tools/
    send-message-to-botpress.tool.ts # definição da tool MCP (schema + handler)
```

Separação de responsabilidades:
- **`config/`** — de onde vêm as credenciais (sempre via env, nunca hardcoded).
- **`botpress/`** — toda a comunicação HTTP/SDK com o Botpress fica isolada aqui.
- **`tools/`** — cada tool MCP é um arquivo com `name`, `description`, `inputSchema` (zod) e `handler`. O `index.ts` apenas registra a lista.

## Configuração

1. Instale as dependências:
   ```bash
   npm install
   ```

2. Crie seu `.env` a partir do exemplo:
   ```bash
   cp .env.example .env
   ```

3. Preencha o `.env`. Para o MVP, basta o `BOTPRESS_WEBHOOK_ID`:
   - No Botpress Studio, adicione/abra a **Chat Integration** do seu bot.
   - Copie o **Webhook ID** (na URL `https://chat.botpress.cloud/abc-123`, o ID é `abc-123`).

4. Compile:
   ```bash
   npm run build
   ```

## Uso com o Claude Code

Registre o servidor (a partir da raiz deste projeto):

```bash
claude mcp add botpress --env BOTPRESS_WEBHOOK_ID=seu-webhook-id -- node /caminho/absoluto/para/mcp-server/dist/index.js
```

Ou adicione manualmente a um `.mcp.json` / config do Claude Code:

```json
{
  "mcpServers": {
    "botpress": {
      "command": "node",
      "args": ["/caminho/absoluto/para/mcp-server/dist/index.js"],
      "env": {
        "BOTPRESS_WEBHOOK_ID": "seu-webhook-id"
      }
    }
  }
}
```

Depois, no Claude Code, peça algo como: *"Use a tool send_message_to_botpress e mande 'oi' para o bot"*.

### Desenvolvimento

```bash
npm run dev        # tsx watch, lê o .env automaticamente
npm run typecheck  # checagem de tipos sem emitir
```

## Tool disponível

### `send_message_to_botpress`

Envia uma mensagem ao bot e aguarda a(s) resposta(s).

**Entrada:**
- `message` (string, obrigatório) — texto a enviar.
- `userId` (string, opcional) — rótulo informativo do usuário de teste.

**Saída (JSON):**
```json
{
  "ok": true,
  "conversationId": "conv_...",
  "userId": "user_...",
  "requestedUserId": "meu-teste",
  "sent": { "text": "oi" },
  "replies": [
    { "id": "msg_...", "authorId": "...", "text": "Olá! Como posso ajudar?", "payload": { "type": "text", "text": "Olá! ..." }, "createdAt": "..." }
  ],
  "timedOut": false
}
```

Em caso de falha, retorna `{ "ok": false, "error": { "message": "...", "type": "...", "code": "..." } }` com `isError: true`.

> Como o bot responde de forma assíncrona, o servidor abre um stream (`listenConversation`), envia a mensagem e coleta as respostas marcadas com `isBot`. Aguarda até `timeoutMs` (padrão 30s) pela 1ª resposta e mais `idleMs` (padrão 2s) por mensagens adicionais.

## Próximas tools (roadmap)

Usarão majoritariamente a **Management API** (`@botpress/client`, já instalado), com a config em `getManagementConfig()`:

- `get_conversation`, `list_conversations` (Chat API)
- `query_knowledge_base`
- `list_tables`, `create_table_record`
- `get_bot_info`
- `test_intent_detection`
- `inspect_workflow`

Para adicionar uma tool: crie `src/tools/<nome>.tool.ts` exportando um `ToolDefinition`, implemente a chamada correspondente em `src/botpress/`, e inclua a tool na lista em `src/index.ts`.
