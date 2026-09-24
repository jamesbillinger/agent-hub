import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useSessionStore, useGlobalStore } from '../../stores';
import { MessageBubble } from './MessageBubble';
import { ActivityGroup } from './ActivityGroup';
import { findItemIndex, groupMessages } from '../../utils/activity';
import type { Message } from '../../types';

interface MessageListProps {
  sessionId: string;
  messages: Message[];
}

export function MessageList({ sessionId, messages }: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const setScrollPosition = useSessionStore((s) => s.setScrollPosition);
  const activityExpanded = useSessionStore((s) => s.activityExpanded.get(sessionId) ?? false);
  const groupOpen = useSessionStore((s) => s.groupOpen.get(sessionId));
  const setGroupOpen = useSessionStore((s) => s.setGroupOpen);
  const sessionStatus = useGlobalStore((s) => s.sessionStatus.get(sessionId));
  const pendingScrollTargetUuid = useGlobalStore((s) => s.pendingScrollTargetUuid);
  const setPendingScrollTarget = useGlobalStore((s) => s.setPendingScrollTarget);

  const isProcessing = sessionStatus?.isProcessing ?? false;

  // Opening a session always lands at the bottom; the ref only tracks
  // whether the user has since scrolled up (so live output stops following).
  const isAtBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const [flashUuid, setFlashUuid] = useState<string | null>(null);

  const items = useMemo(() => groupMessages(messages, activityExpanded), [messages, activityExpanded]);

  const handleAtBottomStateChange = useCallback((isAtBottom: boolean) => {
    isAtBottomRef.current = isAtBottom;
    setAtBottom(isAtBottom);
    setScrollPosition(sessionId, isAtBottom);
  }, [sessionId, setScrollPosition]);

  // Follow live output only while pinned to the bottom. 'auto' (instant)
  // rather than 'smooth': a smooth scroll across a virtualized list keeps
  // re-targeting as items are measured, which is what made long sessions
  // crawl toward the bottom.
  const handleFollowOutput = useCallback(() => {
    return isAtBottomRef.current ? 'auto' : false;
  }, []);

  const jumpToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
  }, []);

  // Search jump: open the group holding the hit (if any), scroll the row into
  // view, then the exact message, and flash it. Retries while history loads.
  useEffect(() => {
    if (!pendingScrollTargetUuid) return;
    const uuid = pendingScrollTargetUuid;
    let cancelled = false;
    let attempts = 0;
    const tryScroll = () => {
      if (cancelled) return;
      const idx = findItemIndex(items, uuid);
      if (idx >= 0 && virtuosoRef.current) {
        const item = items[idx];
        if (item.kind === 'activity' && !(groupOpen?.get(item.key) ?? item.isTail)) {
          setGroupOpen(sessionId, item.key, true);
          // Re-run once the open group has rendered
          window.setTimeout(tryScroll, 50);
          return;
        }
        virtuosoRef.current.scrollToIndex({ index: idx, align: 'start', behavior: 'auto' });
        setFlashUuid(uuid);
        setPendingScrollTarget(null);
        window.setTimeout(() => {
          document.querySelector(`[data-uuid="${CSS.escape(uuid)}"]`)?.scrollIntoView({ block: 'center' });
        }, 80);
        window.setTimeout(() => {
          if (!cancelled) setFlashUuid((cur) => (cur === uuid ? null : cur));
        }, 1500);
        return;
      }
      attempts++;
      if (attempts < 25) window.setTimeout(tryScroll, 120);
      else setPendingScrollTarget(null);
    };
    tryScroll();
    return () => { cancelled = true; };
  }, [pendingScrollTargetUuid, items, groupOpen, sessionId, setGroupOpen, setPendingScrollTarget]);

  if (items.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        {messages.length === 0 ? 'Loading…' : 'No messages yet'}
      </div>
    );
  }

  return (
    <div className="h-full relative">
      <Virtuoso
        ref={virtuosoRef}
        data={items}
        computeItemKey={(_, item) => item.key}
        // Start rendered at the last row instead of scrolling there
        initialTopMostItemIndex={{ index: items.length - 1, align: 'end' }}
        alignToBottom
        followOutput={handleFollowOutput}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={50}
        increaseViewportBy={{ top: 400, bottom: 200 }}
        itemContent={(_, item) => {
          if (item.kind === 'activity') {
            const open = activityExpanded || (groupOpen?.get(item.key) ?? item.isTail);
            return (
              <ActivityGroup
                messages={item.messages}
                summary={item.summary}
                open={open}
                onToggle={() => setGroupOpen(sessionId, item.key, !open)}
                flashUuid={flashUuid}
              />
            );
          }
          const { message } = item;
          const highlight = !!message.uuid && message.uuid === flashUuid;
          return (
            <div data-uuid={message.uuid} className={highlight ? 'ah-search-flash' : undefined}>
              <MessageBubble message={message} />
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
      {!atBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="Jump to latest"
          className="absolute right-4 bottom-4 w-10 h-10 rounded-full bg-[#0e9fd8] text-white shadow-lg flex items-center justify-center text-lg"
        >
          ↓
        </button>
      )}
    </div>
  );
}
