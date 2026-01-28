import { useGlobalStore, useAuthStore } from '../../stores';
import { websocketService } from '../../services/websocket';
import { SessionCard } from './SessionCard';

export function SessionsView() {
  const { sessions, sessionsOrder, isConnected } = useGlobalStore();
  const logout = useAuthStore((s) => s.logout);

  const handleRefresh = () => {
    // Reconnect WebSocket to get fresh data
    websocketService.disconnect();
    websocketService.connect();
  };

  const handleLogout = () => {
    websocketService.disconnect();
    logout();
  };

  return (
    <div className="h-full flex flex-col bg-[#1a1a1a]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c] pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-white">Sessions</h1>
          {!isConnected && (
            <span className="text-xs text-red-400">(disconnected)</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleRefresh}
            className="p-2 text-gray-400 hover:text-white"
            title="Refresh"
          >
            ↻
          </button>
          <button
            onClick={handleLogout}
            className="p-2 text-gray-400 hover:text-white"
            title="Disconnect"
          >
            ⏻
          </button>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessionsOrder.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            No sessions
          </div>
        ) : (
          <div className="divide-y divide-[#3c3c3c]">
            {sessionsOrder.map((id) => {
              const session = sessions.get(id);
              if (!session) return null;
              return <SessionCard key={id} session={session} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
