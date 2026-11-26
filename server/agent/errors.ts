export type AgentErrorCode =
  | 'provider_auth'
  | 'provider_endpoint'
  | 'provider_rate_limit'
  | 'provider_error'
  | 'canvas_error'
  | 'chat_cancelled'
  | 'agent_error';

/** Public failures carry only a stable display code. Never return provider bodies or credentials. */
export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode) {
    super(code);
    this.name = 'AgentError';
  }
}
