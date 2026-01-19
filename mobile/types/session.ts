export type AgentType = 'claude-json';

export interface Session {
  id: string;
  name: string;
  agent_type: AgentType;
  working_dir: string;
  created_at: string;
  updated_at: string;
  status: 'idle' | 'running' | 'error';
}

export interface CreateSessionRequest {
  name: string;
  agent_type: AgentType;
  working_dir: string;
}

export interface SessionListResponse {
  sessions: Session[];
}
