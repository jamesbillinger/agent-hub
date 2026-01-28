import { useRef, useEffect, useCallback } from 'react';
import { useSessionStore, useGlobalStore } from '../../stores';
import { api } from '../../services/api';
import { websocketService } from '../../services/websocket';

interface ChatInputProps {
  sessionId: string;
}

export function ChatInput({ sessionId }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { inputText, pendingImages, setInputText, clearPendingImages, removePendingImage, addPendingImage } = useSessionStore();
  const { sessionStatus, updateSessionStatus } = useGlobalStore();

  const text = inputText.get(sessionId) || '';
  const images = pendingImages.get(sessionId) || [];
  const status = sessionStatus.get(sessionId);
  const isProcessing = status?.isProcessing ?? false;

  const hasContent = text.trim() || images.length > 0;

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
  }, [text]);

  const handleSend = useCallback(async () => {
    if (!hasContent) return;

    // Build message content
    let content: unknown;
    if (images.length > 0) {
      content = [
        ...images.map((img) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.base64Data,
          },
        })),
        ...(text.trim() ? [{ type: 'text', text: text.trim() }] : []),
      ];
    } else {
      content = text.trim();
    }

    // Clear input
    setInputText(sessionId, '');
    clearPendingImages(sessionId);

    // Start session if not running
    const currentStatus = sessionStatus.get(sessionId);
    if (!currentStatus?.running) {
      try {
        await api.startSession(sessionId);
        updateSessionStatus(sessionId, { running: true });
      } catch (err) {
        console.error('Failed to start session:', err);
        return;
      }
    }

    // Send via WebSocket
    websocketService.sendMessage(sessionId, content);
    updateSessionStatus(sessionId, { isProcessing: true });
  }, [sessionId, text, images, hasContent, sessionStatus, setInputText, clearPendingImages, updateSessionStatus]);

  const handleInterrupt = useCallback(() => {
    websocketService.interrupt(sessionId);
    updateSessionStatus(sessionId, { isProcessing: false });
  }, [sessionId, updateSessionStatus]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            addPendingImage(sessionId, {
              mediaType: matches[1],
              base64Data: matches[2],
              previewUrl: dataUrl,
            });
          }
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  }, [sessionId, addPendingImage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-[#3c3c3c] bg-[#252526] pb-[env(safe-area-inset-bottom)]">
      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex gap-2 px-3 pt-3">
          {images.map((img, i) => (
            <div key={i} className="relative">
              <img
                src={img.previewUrl}
                alt="Pending"
                className="w-16 h-16 rounded-lg object-cover"
              />
              <button
                onClick={() => removePendingImage(sessionId, i)}
                className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2 p-3">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setInputText(sessionId, e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Type a message..."
          rows={1}
          className="flex-1 px-4 py-2.5 bg-[#1a1a1a] border border-[#3c3c3c] rounded-full text-white resize-none min-h-[40px] max-h-[120px] focus:outline-none focus:border-[#0e9fd8]"
        />

        {isProcessing && (
          <button
            onClick={handleInterrupt}
            className="px-4 py-2.5 bg-red-500 text-white rounded-full font-medium"
          >
            Stop
          </button>
        )}

        <button
          onClick={handleSend}
          disabled={!hasContent}
          className="px-4 py-2.5 bg-[#0e9fd8] text-white rounded-full font-medium disabled:opacity-50 disabled:bg-gray-600"
        >
          Send
        </button>
      </div>
    </div>
  );
}
