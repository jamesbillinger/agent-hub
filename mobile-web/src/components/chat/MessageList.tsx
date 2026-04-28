import { useRef, useCallback, useEffect, useState } from 'react';
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
  const pendingScrollTargetUuid = useGlobalStore((s) => s.pendingScrollTargetUuid);
  const setPendingScrollTarget = useGlobalStore((s) => s.setPendingScrollTarget);

  const isProcessing = sessionStatus?.isProcessing ?? false;
  const isAtBottomRef = useRef(getScrollPosition(sessionId).isAtBottom);

  // Track the uuid we're flashing right now (and clear after the animation).
  const [flashUuid, setFlashUuid] = useState<string | null>(null);

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

  // Consume pendingScrollTargetUuid: find the message index, scroll Virtuoso
  // to it, briefly flash. Retries while messages are still loading in.
  useEffect(() => {
    if (!pendingScrollTargetUuid) return;
    const uuid = pendingScrollTargetUuid;
    let cancelled = false;
    let attempts = 0;
    const tryScroll = () => {
      if (cancelled) return;
      const idx = messages.findIndex((m) => m.uuid === uuid);
      if (idx >= 0 && virtuosoRef.current) {
        virtuosoRef.current.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
        setFlashUuid(uuid);
        setPendingScrollTarget(null);
        window.setTimeout(() => {
          if (!cancelled) setFlashUuid((cur) => (cur === uuid ? null : cur));
        }, 1500);
        return;
      }
      attempts++;
      if (attempts < 25) window.setTimeout(tryScroll, 120);
      else setPendingScrollTarget(null); // give up; messages may not have it
    };
    tryScroll();
    return () => { cancelled = true; };
  }, [pendingScrollTargetUuid, messages, setPendingScrollTarget]);

  return (
    <div className="h-full">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        followOutput={handleFollowOutput}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={50}
        itemContent={(index, message) => {
          const highlight = !!message.uuid && message.uuid === flashUuid;
          const wrap = !!message.uuid;
          if (!wrap && !highlight) {
            return <MessageBubble key={index} message={message} />;
          }
          return (
            <div
              data-uuid={message.uuid}
              className={highlight ? 'ah-search-flash' : undefined}
            >
              <MessageBubble key={index} message={message} />
            </div>
          );
        }}
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
