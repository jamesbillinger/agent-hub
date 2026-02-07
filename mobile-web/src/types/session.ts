export interface Session {
  id: string;
  name: string;
  agent_type: 'claude-json' | 'claude' | 'codex' | 'aider' | 'shell' | 'custom';
  command: string;
  working_dir: string;
  created_at: string;
  claude_session_id?: string;
  sort_order: number;
  folder_id?: string | null;
}

export interface SessionStatus {
  running: boolean;
  isProcessing: boolean;
}

export interface Folder {
  id: string;
  name: string;
  sort_order: number;
  collapsed: boolean;
}
