export interface ChatSettings {
  provider: 'openai' | 'anthropic';
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; phase: 'start' | 'done' | 'error' };

export type ChatEvent = AgentEvent | { type: 'done' };
export type ChatFrame =
  | ChatEvent
  | { type: 'error'; code: string }
  | { type: 'heartbeat' }
  | { type: 'rpc'; id: number; frame: unknown };

export interface AgentTurn {
  settings: ChatSettings;
  /** The last entry is the current user message. */
  history: ChatMessage[];
  signal: AbortSignal;
  emit(event: AgentEvent): void;
  exchange(frame: unknown): Promise<unknown>;
}
