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

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent | ImageContent;

export interface Message {
  type: 'system' | 'user' | 'assistant' | 'result';
  subtype?: 'init' | 'success' | 'error';
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    content: ContentBlock[] | string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  result?: string;
  is_error?: boolean;
  model?: string;
  cwd?: string;
  // For local user messages with images
  images?: Array<{ mediaType: string; base64Data: string }>;
}

export interface PendingImage {
  mediaType: string;
  base64Data: string;
  previewUrl: string;
}
