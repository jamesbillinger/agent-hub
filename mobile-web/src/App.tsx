import { useEffect } from 'react';
import { useAuthStore, useGlobalStore } from './stores';
import { websocketService } from './services/websocket';

// Views
import { AuthFlow } from './components/auth/AuthFlow';
import { SessionsView } from './components/sessions/SessionsView';
import { ChatView } from './components/chat/ChatView';

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const activeSessionId = useGlobalStore((s) => s.activeSessionId);

  // Connect WebSocket when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      websocketService.connect();
    }
    return () => {
      websocketService.disconnect();
    };
  }, [isAuthenticated]);

  // Not authenticated - show auth flow
  if (!isAuthenticated) {
    return <AuthFlow />;
  }

  // Authenticated - show sessions or chat
  return (
    <div className="h-full flex flex-col">
      {activeSessionId ? (
        <ChatView sessionId={activeSessionId} />
      ) : (
        <SessionsView />
      )}
    </div>
  );
}
