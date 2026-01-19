export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent;

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: ContentBlock[];
  stop_reason?: string | null;
  usage?: TokenUsage;
}

export interface SystemMessage {
  type: 'system';
  subtype: 'init' | 'success' | 'error';
  session_id?: string;
  model?: string;
  cwd?: string;
  message?: string;
}

export interface UserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
}

export interface AssistantMessage {
  type: 'assistant';
  message: Message;
}

export interface ResultMessage {
  type: 'result';
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ResultMessage;

// Use intersection type instead of interface extension for union types
export type ChatMessageWithId = ChatMessage & {
  localId: string;
  timestamp: number;
};
