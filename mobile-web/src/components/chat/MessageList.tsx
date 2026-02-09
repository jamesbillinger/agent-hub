import { useRef, useCallback } from 'react';
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
  const isAtBottomRef = useRef(getScrollPosition(sessionId).isAtBottom);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    setScrollPosition(sessionId, atBottom);
  }, [sessionId, setScrollPosition]);

  // Only auto-follow new output when user is at the bottom.
  // Using a callback avoids the race condition between scroll state updates
  // and message arrivals that caused choppy/jerky scrolling.
  const handleFollowOutput = useCallback(() => {
    return isAtBottomRef.current ? 'smooth' : false;
  }, []);

  return (
    <div className="h-full">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        followOutput={handleFollowOutput}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={50}
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
