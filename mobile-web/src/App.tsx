import { useEffect } from 'react';
import { useAuthStore, useGlobalStore } from './stores';
import { websocketService } from './services/websocket';

// Views
import { AuthFlow } from './components/auth/AuthFlow';
import { SessionsView } from './components/sessions/SessionsView';
import { ChatView } from './components/chat/ChatView';

// Parse session ID from URL hash (e.g., #/session/abc123)
function getSessionIdFromHash(): string | null {
  const hash = window.location.hash;
  const match = hash.match(/^#\/session\/(.+)$/);
  return match ? match[1] : null;
}

// Update URL hash when session changes
function updateUrlHash(sessionId: string | null) {
  if (sessionId) {
    window.history.replaceState(null, '', `#/session/${sessionId}`);
  } else {
    window.history.replaceState(null, '', window.location.pathname);
  }
}

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const activeSessionId = useGlobalStore((s) => s.activeSessionId);
  const setActiveSession = useGlobalStore((s) => s.setActiveSession);

  // Connect WebSocket when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      websocketService.connect();
    }
    return () => {
      websocketService.disconnect();
    };
  }, [isAuthenticated]);

  // Restore session from URL on mount only (not on every activeSessionId change)
  useEffect(() => {
    if (isAuthenticated) {
      const sessionIdFromUrl = getSessionIdFromHash();
      if (sessionIdFromUrl) {
        setActiveSession(sessionIdFromUrl);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]); // Only run on mount/auth change, NOT on activeSessionId change

  // Sync URL when active session changes
  useEffect(() => {
    if (isAuthenticated) {
      updateUrlHash(activeSessionId);
    }
  }, [isAuthenticated, activeSessionId]);

  // Handle browser back/forward
  useEffect(() => {
    const handleHashChange = () => {
      const sessionId = getSessionIdFromHash();
      setActiveSession(sessionId);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [setActiveSession]);

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
