/**
 * Tipos do conteúdo do Botpress.
 *
 * O JSON de deploy do bot é grande e fracamente tipado (a forma varia conforme
 * a versão do Studio e os plugins instalados). Tipamos apenas o que as tools
 * realmente leem e deixamos o resto como índice aberto — assim uma mudança de
 * schema no Botpress não quebra o build.
 */

export interface BotSummary {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  deployedAt?: string;
  type?: string;
  tags?: Record<string, string>;
  [key: string]: unknown;
}

/** Uma instrução dentro de um nó: transição, action, skill, captura, mensagem… */
export interface Instruction {
  id?: string;
  type?: string;
  label?: string;
  name?: string;
  category?: string;
  code?: string;
  flowId?: string;
  actionId?: string;
  toolType?: string;
  condition?: { type?: string; payload?: string };
  destination?: { node?: string };
  guidelines?: DynamicValue;
  question?: DynamicValue;
  content?: Record<string, any>;
  data?: Record<string, any>;
  retry?: { maxRetries?: number; retryMessage?: DynamicValue };
  cancellation?: Record<string, any>;
  handleFailure?: boolean;
  [key: string]: unknown;
}

/** Campo do Studio que pode ser estático ou interpolado. */
export interface DynamicValue {
  valueType?: string;
  staticValue?: unknown;
  dynamicValue?: string;
  [key: string]: unknown;
}

export interface FlowNode {
  id?: string;
  name?: string;
  type?: string;
  instructions?: Instruction[];
  guidelines?: DynamicValue;
  defaultTransition?: { targetNodeId?: string | null };
  [key: string]: unknown;
}

export interface Flow {
  id?: string;
  name?: string;
  startNode?: string;
  nodes?: FlowNode[];
  [key: string]: unknown;
}

export interface KnowledgeBase {
  id?: string;
  name?: string;
  description?: string;
  dataSources?: Array<{
    id?: string;
    type?: string;
    data?: { html?: string; [key: string]: unknown };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface Hook {
  type?: string;
  name?: string;
  code?: string;
  transpiledCode?: string;
  [key: string]: unknown;
}

export interface BotAction {
  id?: string;
  name?: string;
  type?: string;
  description?: string;
  raw_code?: string;
  transpiled_code?: string;
  [key: string]: unknown;
}

export interface BotContent {
  settings?: Record<string, any>;
  flows?: Flow[];
  knowledge_base?: KnowledgeBase[];
  hooks?: Hook[];
  actions?: BotAction[];
  tables?: Record<string, Record<string, any>>;
  agents?: Record<string, any>;
  identity?: Record<string, any>;
  [key: string]: unknown;
}

export interface Conversation {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  channel?: string;
  integration?: string;
  tags?: Record<string, string>;
  [key: string]: unknown;
}
