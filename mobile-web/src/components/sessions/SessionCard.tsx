import { useGlobalStore } from '../../stores';
import type { Session } from '../../types';

interface SessionCardProps {
  session: Session;
}

export function SessionCard({ session }: SessionCardProps) {
  const { sessionStatus, setActiveSession } = useGlobalStore();
  const status = sessionStatus.get(session.id);

  const isRunning = status?.running ?? false;
  const isProcessing = status?.isProcessing ?? false;

  return (
    <button
      onClick={() => setActiveSession(session.id)}
      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#2a2a2a] transition-colors text-left"
    >
      {/* Status indicator */}
      <div
        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
          isProcessing
            ? 'bg-blue-500 animate-pulse'
            : isRunning
            ? 'bg-green-500'
            : 'bg-gray-600'
        }`}
      />

      {/* Session info */}
      <div className="flex-1 min-w-0">
        <div className="text-white font-medium truncate">{session.name}</div>
        <div className="text-sm text-gray-500 truncate">
          {session.agent_type} • {session.working_dir.replace(/^~\//, '')}
        </div>
      </div>

      {/* Chevron */}
      <div className="text-gray-500">›</div>
    </button>
  );
}
