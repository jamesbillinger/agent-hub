import { useRef, useEffect } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useSessionStore, useGlobalStore } from '../../stores';
import { MessageBubble } from './MessageBubble';
import type { Message } from '../../types';

interface MessageListProps {
  sessionId: string;
  messages: Message[];
}

export function MessageList({ sessionId, messages }: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const { getScrollPosition, setScrollPosition } = useSessionStore();
  const sessionStatus = useGlobalStore((s) => s.sessionStatus.get(sessionId));

  const isProcessing = sessionStatus?.isProcessing ?? false;
  const { isAtBottom } = getScrollPosition(sessionId);

  // Auto-scroll to bottom when new messages arrive (if user was at bottom)
  useEffect(() => {
    if (isAtBottom && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({
        index: messages.length - 1,
        behavior: 'smooth',
      });
    }
  }, [messages.length, isAtBottom]);

  const handleScroll = (scrolling: boolean) => {
    if (!scrolling && virtuosoRef.current) {
      // Check if we're at bottom after scrolling stops
      // This is a simplified check - react-virtuoso has better ways to do this
    }
  };

  const handleAtBottomStateChange = (atBottom: boolean) => {
    setScrollPosition(sessionId, atBottom);
  };

  return (
    <div className="h-full">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        followOutput="smooth"
        atBottomStateChange={handleAtBottomStateChange}
        isScrolling={handleScroll}
        itemContent={(index, message) => (
          <MessageBubble key={index} message={message} />
        )}
        components={{
          Footer: () =>
            isProcessing ? (
              <div className="px-4 py-2">
                <div className="flex items-center gap-2 text-gray-400 text-sm">
                  <div className="flex gap-1">
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <span>Thinking...</span>
                </div>
              </div>
            ) : null,
        }}
      />
    </div>
  );
}
