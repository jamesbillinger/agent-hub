import { useMemo } from 'react';
import { marked } from 'marked';
import type { Message, TextContent, ToolUseContent } from '../../types';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.type === 'system' && message.subtype === 'init') {
    return (
      <div className="px-4 py-2 text-center">
        <span className="text-sm text-gray-500">
          Session started • {message.model || 'Claude'}
        </span>
      </div>
    );
  }

  if (message.type === 'user') {
    const text = extractUserText(message);
    const images = message.images || extractUserImages(message);

    if (!text && images.length === 0) return null;

    return (
      <div className="px-4 py-2 flex justify-end">
        <div className="max-w-[85%] bg-[#0e9fd8] text-white rounded-2xl rounded-br px-4 py-2">
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mediaType};base64,${img.base64Data}`}
                  alt="Attached"
                  className="max-w-[150px] max-h-[100px] rounded object-cover"
                />
              ))}
            </div>
          )}
          {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
        </div>
      </div>
    );
  }

  if (message.type === 'assistant' && message.message?.content) {
    const content = message.message.content;
    const blocks = Array.isArray(content) ? content : [];

    // Check if this is a tool use message
    const hasToolUse = blocks.some((b) => b.type === 'tool_use');

    if (hasToolUse) {
      return (
        <div className="px-4 py-2">
          {blocks.map((block, i) => {
            if (block.type === 'tool_use') {
              return <ToolUseBlock key={i} block={block as ToolUseContent} />;
            }
            if (block.type === 'text' && (block as TextContent).text) {
              return (
                <div key={i} className="max-w-[85%] bg-[#2a2a2a] text-gray-200 rounded-2xl rounded-bl px-4 py-2 mb-2">
                  <div className="whitespace-pre-wrap break-words">
                    {(block as TextContent).text}
                  </div>
                </div>
              );
            }
            return null;
          })}
        </div>
      );
    }

    // Regular assistant message
    const textContent = blocks
      .filter((b): b is TextContent => b.type === 'text' && !!(b as TextContent).text)
      .map((b) => b.text)
      .join('\n\n');

    if (!textContent) return null;

    return <AssistantMessageContent text={textContent} />;
  }

  if (message.type === 'result' && message.is_error) {
    return (
      <div className="px-4 py-2 text-center">
        <span className="text-sm text-red-400">Error: {message.result}</span>
      </div>
    );
  }

  // Skip other message types
  return null;
}

function AssistantMessageContent({ text }: { text: string }) {
  const html = useMemo(() => {
    return marked.parse(text) as string;
  }, [text]);

  return (
    <div className="px-4 py-2">
      <div className="max-w-[85%] bg-[#2a2a2a] text-gray-200 rounded-2xl rounded-bl px-4 py-2">
        <div
          className="markdown-content break-words"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

function ToolUseBlock({ block }: { block: ToolUseContent }) {
  return (
    <div className="bg-[#1e3a4c] rounded-lg px-3 py-2 mb-2">
      <div className="text-[#4ec9b0] font-medium text-sm">{block.name}</div>
      {block.input && (
        <pre className="text-xs text-gray-400 mt-1 overflow-x-auto">
          {JSON.stringify(block.input, null, 2).slice(0, 200)}
          {JSON.stringify(block.input).length > 200 && '...'}
        </pre>
      )}
    </div>
  );
}

function extractUserText(message: Message): string {
  if (message.result) return message.result;

  const content = message.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is TextContent => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function extractUserImages(message: Message): Array<{ mediaType: string; base64Data: string }> {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];

  return content
    .filter((b) => b.type === 'image' && 'source' in b)
    .map((b) => ({
      mediaType: (b as any).source.media_type,
      base64Data: (b as any).source.data,
    }));
}
