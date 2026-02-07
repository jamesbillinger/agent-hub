import { useState } from 'react';
import { useGlobalStore, useAuthStore } from '../../stores';
import { websocketService } from '../../services/websocket';
import { api } from '../../services/api';
import { SessionCard } from './SessionCard';

export function SessionsView() {
  const { sessions, sessionsOrder, folders, isConnected, setActiveSession, addSession } = useGlobalStore();
  const logout = useAuthStore((s) => s.logout);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionDir, setNewSessionDir] = useState('~/dev/');
  const [isCreating, setIsCreating] = useState(false);

  const handleRefresh = () => {
    // Reconnect WebSocket to get fresh data
    websocketService.disconnect();
    websocketService.connect();
  };

  const handleLogout = () => {
    websocketService.disconnect();
    logout();
  };

  const handleCreateSession = async () => {
    if (!newSessionName.trim() && !newSessionDir.trim()) return;

    setIsCreating(true);
    try {
      const name = newSessionName.trim() || newSessionDir.split('/').filter(Boolean).pop() || 'New Session';
      const session = await api.createSession(name, newSessionDir.trim() || '~/');
      addSession(session);
      setShowNewSessionModal(false);
      setNewSessionName('');
      setNewSessionDir('~/dev/');
      // Navigate to the new session
      setActiveSession(session.id);
    } catch (err) {
      console.error('Failed to create session:', err);
      alert('Failed to create session: ' + (err as Error).message);
    } finally {
      setIsCreating(false);
    }
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
            onClick={() => setShowNewSessionModal(true)}
            className="p-2 text-[#0e9fd8] hover:text-white font-bold text-lg"
            title="New Session"
          >
            +
          </button>
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

      {/* New Session Modal */}
      {showNewSessionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#2a2a2a] rounded-lg p-4 w-full max-w-sm">
            <h2 className="text-lg font-semibold text-white mb-4">New Session</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Name (optional)</label>
                <input
                  type="text"
                  value={newSessionName}
                  onChange={(e) => setNewSessionName(e.target.value)}
                  placeholder="Session name"
                  className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#3c3c3c] rounded text-white placeholder-gray-500 focus:outline-none focus:border-[#0e9fd8]"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Working Directory</label>
                <input
                  type="text"
                  value={newSessionDir}
                  onChange={(e) => setNewSessionDir(e.target.value)}
                  placeholder="~/dev/"
                  className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#3c3c3c] rounded text-white placeholder-gray-500 focus:outline-none focus:border-[#0e9fd8]"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setShowNewSessionModal(false)}
                className="flex-1 px-4 py-2 bg-[#3c3c3c] text-white rounded hover:bg-[#4a4a4a]"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateSession}
                disabled={isCreating}
                className="flex-1 px-4 py-2 bg-[#0e9fd8] text-white rounded hover:bg-[#0c8ec2] disabled:opacity-50"
              >
                {isCreating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessionsOrder.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            No sessions
          </div>
        ) : (
          <div className="divide-y divide-[#3c3c3c]">
            {(() => {
              // Group sessions by folder_id for display
              const hasFolders = sessionsOrder.some((id) => sessions.get(id)?.folder_id);
              if (!hasFolders) {
                // No folders — flat list
                return sessionsOrder.map((id) => {
                  const session = sessions.get(id);
                  if (!session) return null;
                  return <SessionCard key={id} session={session} />;
                });
              }

              // Group: unfiled first, then by folder
              const unfiled: string[] = [];
              const folderGroups = new Map<string, { name: string; ids: string[] }>();

              for (const id of sessionsOrder) {
                const session = sessions.get(id);
                if (!session) continue;
                if (!session.folder_id) {
                  unfiled.push(id);
                } else {
                  const folder = folders.get(session.folder_id);
                  const folderName = folder?.name || 'Unknown Folder';
                  const group = folderGroups.get(session.folder_id) || { name: folderName, ids: [] };
                  group.ids.push(id);
                  folderGroups.set(session.folder_id, group);
                }
              }

              return (
                <>
                  {unfiled.map((id) => {
                    const session = sessions.get(id);
                    if (!session) return null;
                    return <SessionCard key={id} session={session} />;
                  })}
                  {Array.from(folderGroups.entries()).map(([folderId, group]) => (
                    <div key={folderId}>
                      <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-[#222]">
                        {group.name}
                      </div>
                      {group.ids.map((id) => {
                        const session = sessions.get(id);
                        if (!session) return null;
                        return <SessionCard key={id} session={session} />;
                      })}
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
