# Botpress MCP Server

Servidor [MCP](https://modelcontextprotocol.io) que conecta o **Claude Code** ao **Botpress**, funcionando como camada adaptadora:

```
Claude Code → MCP Server (este projeto) → API do Botpress → Bot/Workspace
```

O objetivo é **auditar e diagnosticar** os bots da Omni sem precisar navegar o Studio nó a nó: buscar uma regra de negócio em todos os fluxos de uma vez, comparar bots entre si, ler o código dos hooks, inspecionar o encadeamento de HITL com o Zendesk.

## ⚠️ Somente leitura, por design

**Todas as tools fazem apenas `GET`.** Isso não é cautela arbitrária — é o que a API permite:

| Artefato | Gravável pela API? |
|---|---|
| Fluxos, nós, transições | ❌ Só existem no Studio |
| Guidelines dos agentes (os prompts) | ❌ Idem |
| Hooks e code actions | ❌ Idem |
| KB rich-text | ❌ Faz parte da definição do fluxo |
| KB *file-api* | ⚠️ Sim, mas serve o bot **publicado** — sobrescrever muda o comportamento na hora |
| Config de integração, tables | ⚠️ Sim, com efeito **imediato** em produção |

Ou seja: não existe caminho de API que seja gravável **e** deixe a mudança em rascunho. Alterar sem publicar só é possível dentro do Studio. Por isso este servidor não implementa escrita — para que rodá-lo nunca possa, sozinho, alterar produção.

> A Management API devolve o conteúdo do bot como o **artefato da última publicação** (`deployments/*.json`). Alterações salvas no Studio e ainda não publicadas **não aparecem** nas tools.

## Segredos

O JSON de conteúdo do bot traz credenciais em claro (`settings.configVariables` guarda `WHATSAPP_ACCESS_TOKEN`, `ZENDESK_ACCESS_TOKEN` etc.). Como a saída das tools vai para o contexto de um LLM, **`src/botpress/redact.ts` mascara tudo isso no carregamento**, antes de qualquer tool tocar no conteúdo. Os nomes das chaves são preservados (dá para auditar "a variável X está configurada?"), os valores não.

Se você baixar o conteúdo do bot por fora deste servidor, **não commite o arquivo**.

## As duas APIs do Botpress

| API | Base URL | Autenticação | Para quê |
|-----|----------|--------------|----------|
| **Chat API** | `https://chat.botpress.cloud/{webhookId}` | `x-user-key` (JWT gerenciado pelo SDK) | **Conversar** com o bot |
| **Management API** | `https://api.botpress.cloud` | Bearer `BOTPRESS_TOKEN` + `x-workspace-id` (+ `x-bot-id`) | **Inspecionar** bots, fluxos, KBs, tables, conversas |

## Tools

### Descoberta

| Tool | O que faz |
|---|---|
| `list_bots` | Inventário do workspace: nome, ID, último deploy, integrações de canal e **sinal de tráfego real**. Distingue bot de produção de cópia/teste. |
| `get_bot_overview` | Panorama do conteúdo de um bot: settings, fluxos com contagem de nós, KBs, hooks, actions, tables, variáveis. |

### Análise de conteúdo

| Tool | O que faz |
|---|---|
| `grep_bot_content` | **A principal.** Regex em todo o conteúdo — guidelines, KBs em HTML, código, mensagens, condições — reportando *fluxo › nó › ID do nó* de cada ocorrência. |
| `inspect_flow` | Renderiza um fluxo. `routemap` = grafo compacto de roteamento. `full` = inclui o texto integral das guidelines. |
| `get_bot_code` | Código-fonte de hooks, code actions e blocos `Execute code` dentro dos nós. Sempre o fonte, nunca o transpilado. |

### Consistência entre bots

| Tool | O que faz |
|---|---|
| `compare_bots` | Diff estrutural entre dois bots + auditoria de regras. |
| `audit_business_rules` | Audita regras de negócio da Omni em N bots e aponta onde ainda há valor obsoleto. |

### Runtime / HITL

| Tool | O que faz |
|---|---|
| `list_conversations` | Conversas recentes com canal, integração e tags. |
| `inspect_hitl_tags` | Censo das tags reais das conversas × acessos no código. Detecta `tags.downstream` onde deveria ser `tags['hitl#downstream']`. |

### Conversar

| Tool | O que faz |
|---|---|
| `send_message_to_botpress` | Envia mensagem ao bot pela Chat API e devolve as respostas. Testar fluxo de ponta a ponta. |

## Por que `grep_bot_content` é a tool central

A lógica de negócio deste bot **não está em código** — está em texto. Os nós autônomos (LLMz) carregam prompts em markdown no campo *Guidelines*, e as KBs são HTML rich-text. Uma regra como "o bloqueio por cupom fiscal dura 60 dias" aparece repetida em vários agentes, e nada garante que estejam de acordo.

O padrão típico: um prazo é atualizado em alguns agentes e esquecido em outros, e o bot passa a dar respostas contraditórias conforme o caminho que a conversa tomou. A busca mostra de uma vez todos os pontos que precisam de edição:

```
grep_bot_content  pattern="\b45\s*dias"
→ N ocorrências, agrupadas por local:
    fluxo "<agente A>" › nó "<nó>" (nd-xxxxxxxx)    8x
    fluxo "<agente B>" › nó "<nó>" (nd-yyyyyyyy)    6x
    fluxo "<agente C>" › nó "<nó>" (nd-zzzzzzzz)    1x
```

`inspect_hitl_tags` cobre outra classe de defeito — acesso a tag com o nome errado:

```
🔴 hook "<hook>" › upstreamConversation?.tags?.downstream
   → provável correção: tags["hitl#downstream"]
```

O plugin HITL grava as tags com prefixo `hitl#`. Sem o prefixo o acesso devolve `undefined` em silêncio — sem exceção, sem log de falha — e a funcionalidade simplesmente não roda. A tool confronta as tags **realmente observadas** nas conversas com o que o código tenta ler, então o desencontro fica evidente.

## Regras auditadas

Ficam em `DEFAULT_RULE_CHECKS`, em `src/botpress/diff.ts` — ponto único de verdade. Cada regra tem um padrão `expected` (o valor correto) e/ou `forbidden` (o obsoleto que não deveria mais existir):

- Prazo de bloqueio por cupom fiscal (60 dias, não 45)
- Orientação do botão "Cobertura" no app
- Exigência de prescrição médica
- Cobertura de homeopáticos (não são cobertos)
- Horário comercial divulgado ao usuário

**Quando uma regra de negócio mudar, atualize essa lista** — é o que mantém a auditoria útil.

## Estrutura

```
src/
  index.ts                    entrypoint: cria o McpServer e registra as tools (stdio)
  config/
    env.ts                    credenciais + resolveBotId()
  botpress/
    management-client.ts      Management API (read-only) + cache do conteúdo
    botpress-client.ts        Chat API (conversar com o bot)
    content.ts                travessia, grep, render de fluxo, route map
    diff.ts                   comparação entre bots, auditoria de regras, censo de tags
    redact.ts                 mascaramento de segredos
    types.ts                  tipos do conteúdo do bot
    errors.ts                 normalização de erros
  tools/
    tool.ts                   ToolDefinition + safeHandler compartilhados
    *.tool.ts                 uma tool por arquivo
scripts/
  smoke-test.ts               exercita as tools contra a API real (só GET)
```

### Cache

O conteúdo do bot principal tem ~1,8 MB e várias tools o consomem na mesma sessão. `getBotContent` mantém cache em memória com TTL de 10 min; passado o TTL, confere o `deployedAt` antes de baixar de novo, então **uma publicação nova invalida o cache automaticamente**. Force com `refresh: true`.

## Configuração

```bash
npm install
cp .env.example .env   # preencha
npm run build
```

| Variável | Obrigatória para | Onde obter |
|---|---|---|
| `BOTPRESS_TOKEN` | tools de inspeção | Personal Access Token no Botpress Cloud |
| `BOTPRESS_WORKSPACE_ID` | tools de inspeção | URL do workspace (`wkspace_…`) |
| `BOTPRESS_BOT_ID` | opcional | Bot default quando `botId` é omitido. Sem ele, passe `botId` nas chamadas. |
| `BOTPRESS_WEBHOOK_ID` | `send_message_to_botpress` | Webhook ID da Chat Integration |
| `BOTPRESS_API_BASE_URL` | não | Default `https://api.botpress.cloud` |
| `BOTPRESS_CHAT_API_URL` | não | Default `https://chat.botpress.cloud` |

### Registrar no Claude Code

```bash
claude mcp add botpress -- node /caminho/absoluto/para/mcp-server/dist/index.js
```

O servidor lê o `.env` da raiz do projeto automaticamente. Ou, num `.mcp.json`:

```json
{
  "mcpServers": {
    "botpress": {
      "command": "node",
      "args": ["/caminho/absoluto/para/mcp-server/dist/index.js"]
    }
  }
}
```

## Desenvolvimento

```bash
npm run dev        # tsx watch
npm run typecheck  # checagem de tipos
npm run smoke      # exercita as tools contra a API real (só GET)
```

O `smoke` precisa de `.env` válido e rede. Ele verifica, entre outras coisas, que a redação de segredos está ativa e que nenhum access token da Meta vaza na saída.

### Adicionar uma tool

1. Crie `src/tools/<nome>.tool.ts` exportando um `ToolDefinition`.
2. Use `safeHandler` de `./tool.js` — ele transforma exceção em resposta legível em vez de erro de protocolo.
3. Coloque a chamada HTTP em `src/botpress/management-client.ts`, não na tool.
4. Registre na lista em `src/index.ts`.
5. **Mantenha somente leitura.** Ver a seção no topo.

Toda tool deve limitar o tamanho da saída (`maxChars`, `maxMatches`): o conteúdo do bot é grande o bastante para estourar o contexto de uma conversa.

## Diagnósticos

Relatórios gerados com estas tools contêm dados internos e pessoais (CPF, telefone, tickets, IDs de infraestrutura). Ficam em `docs/`, que está no `.gitignore` **porque este repositório é público**. Não versione esse conteúdo aqui.
