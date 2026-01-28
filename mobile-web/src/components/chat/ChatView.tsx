import { useEffect } from 'react';
import { useGlobalStore, useSessionStore } from '../../stores';
import { websocketService } from '../../services/websocket';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

interface ChatViewProps {
  sessionId: string;
}

export function ChatView({ sessionId }: ChatViewProps) {
  const { sessions, sessionStatus, setActiveSession } = useGlobalStore();
  const { messages } = useSessionStore();

  const session = sessions.get(sessionId);
  const status = sessionStatus.get(sessionId);
  const sessionMessages = messages.get(sessionId) || [];

  // Subscribe to session on mount, unsubscribe on unmount
  useEffect(() => {
    websocketService.subscribe(sessionId);
    return () => {
      websocketService.unsubscribe(sessionId);
    };
  }, [sessionId]);

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
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-hidden">
        <MessageList sessionId={sessionId} messages={sessionMessages} />
      </div>

      {/* Input */}
      <ChatInput sessionId={sessionId} />
    </div>
  );
}
