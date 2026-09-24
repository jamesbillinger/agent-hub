import { useEffect } from 'react';
import { useGlobalStore, useSessionStore } from '../../stores';
import { websocketService } from '../../services/websocket';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

interface ChatViewProps {
  sessionId: string;
}

export function ChatView({ sessionId }: ChatViewProps) {
  const { sessions, sessionStatus, setActiveSession, isConnected } = useGlobalStore();
  const cameFromSearch = useGlobalStore((s) => s.cameFromSearch);
  const lastSearchQuery = useGlobalStore((s) => s.lastSearchQuery);
  const triggerBackToSearch = useGlobalStore((s) => s.triggerBackToSearch);
  const { messages } = useSessionStore();
  const activityExpanded = useSessionStore((s) => s.activityExpanded.get(sessionId) ?? false);
  const setActivityExpanded = useSessionStore((s) => s.setActivityExpanded);

  const session = sessions.get(sessionId);
  const status = sessionStatus.get(sessionId);
  const sessionMessages = messages.get(sessionId) || [];

  // Subscribe to session on mount and on reconnect, unsubscribe on unmount
  useEffect(() => {
    if (isConnected) {
      websocketService.subscribe(sessionId);
    }
    return () => {
      websocketService.unsubscribe(sessionId);
    };
  }, [sessionId, isConnected]);

  const handleBack = () => {
    setActiveSession(null);
  };

  if (!session) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        Session not found
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#1a1a1a]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[#3c3c3c] pt-[env(safe-area-inset-top)]">
        <button
          onClick={handleBack}
          className="text-[#0e9fd8] font-medium"
        >
          ‹ Back
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-white font-medium truncate">{session.name}</div>
        </div>
        {status?.isProcessing && (
          <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
        )}
        <button
          type="button"
          onClick={() => setActivityExpanded(sessionId, !activityExpanded)}
          title={activityExpanded ? 'Roll up tool calls' : 'Show all tool calls and subagent output'}
          aria-pressed={activityExpanded}
          className={`text-sm px-2 py-1 rounded border ${activityExpanded ? 'border-[#0e9fd8] text-[#0e9fd8]' : 'border-[#3c3c3c] text-gray-400'}`}
        >
          {activityExpanded ? '⊟' : '⊞'}
        </button>
      </div>

      {/* Back-to-search pill: visible when the user landed here via a
          search hit. Tap returns to the SearchPanel pre-filled with the
          original query, with the same hit list cached. */}
      {cameFromSearch && lastSearchQuery && (
        <button
          onClick={triggerBackToSearch}
          className="mx-3 mt-2 px-3 py-1.5 self-start inline-flex items-center gap-2 text-xs rounded-full bg-[#222] border border-[#3c3c3c] text-gray-200 hover:border-[#0e9fd8]"
        >
          <span className="text-[#0e9fd8]">←</span>
          <span>Back to search results</span>
          <span className="text-gray-500 truncate max-w-[200px]">"{lastSearchQuery}"</span>
        </button>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-hidden">
        <MessageList key={sessionId} sessionId={sessionId} messages={sessionMessages} />
      </div>

      {/* Input */}
      <ChatInput sessionId={sessionId} />
    </div>
  );
}
