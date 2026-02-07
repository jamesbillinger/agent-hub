import { create } from 'zustand';
import type { Session, SessionStatus, Folder } from '../types';

interface GlobalState {
  // Sessions
  sessions: Map<string, Session>;
  sessionsOrder: string[];

  // Folders
  folders: Map<string, Folder>;

  // Per-session status (for list view indicators)
  sessionStatus: Map<string, SessionStatus>;

  // Active session
  activeSessionId: string | null;

  // WebSocket connection state
  isConnected: boolean;

  // Actions
  setSessions: (sessions: Session[]) => void;
  setFolders: (folders: Folder[]) => void;
  setSession: (session: Session) => void;
  addSession: (session: Session) => void;
  updateSession: (session: Session) => void;
  removeSession: (id: string) => void;
  updateSessionStatus: (id: string, status: Partial<SessionStatus>) => void;
  setActiveSession: (id: string | null) => void;
  setConnected: (connected: boolean) => void;
  reorderSessions: (order: string[]) => void;
}

export const useGlobalStore = create<GlobalState>((set, get) => ({
  sessions: new Map(),
  sessionsOrder: [],
  folders: new Map(),
  sessionStatus: new Map(),
  activeSessionId: null,
  isConnected: false,

  setSessions: (sessions) => {
    const sessionsMap = new Map<string, Session>();
    const order: string[] = [];
    const statusMap = new Map<string, SessionStatus>();

    // Sort by sort_order
    const sorted = [...sessions].sort((a, b) => a.sort_order - b.sort_order);

    for (const session of sorted) {
      sessionsMap.set(session.id, session);
      order.push(session.id);
      // Use running status from server, preserve isProcessing if we have it
      const existing = get().sessionStatus.get(session.id);
      const running = (session as Session & { running?: boolean }).running ?? false;
      statusMap.set(session.id, {
        running,
        isProcessing: existing?.isProcessing ?? false,
      });
    }

    set({ sessions: sessionsMap, sessionsOrder: order, sessionStatus: statusMap });
  },

  setFolders: (folders) => {
    const foldersMap = new Map<string, Folder>();
    for (const folder of folders) {
      foldersMap.set(folder.id, folder);
    }
    set({ folders: foldersMap });
  },

  setSession: (session) => {
    const sessions = new Map(get().sessions);
    sessions.set(session.id, session);

    const order = get().sessionsOrder;
    if (!order.includes(session.id)) {
      set({
        sessions,
        sessionsOrder: [session.id, ...order],
      });
    } else {
      set({ sessions });
    }

    // Initialize status if needed
    if (!get().sessionStatus.has(session.id)) {
      const statusMap = new Map(get().sessionStatus);
      statusMap.set(session.id, { running: false, isProcessing: false });
      set({ sessionStatus: statusMap });
    }
  },

  // Alias for setSession - adds a session to the list
  addSession: (session) => {
    get().setSession(session);
  },

  // Alias for setSession - updates an existing session
  updateSession: (session) => {
    get().setSession(session);
  },

  removeSession: (id) => {
    const sessions = new Map(get().sessions);
    sessions.delete(id);

    const statusMap = new Map(get().sessionStatus);
    statusMap.delete(id);

    set({
      sessions,
      sessionsOrder: get().sessionsOrder.filter((sid) => sid !== id),
      sessionStatus: statusMap,
      activeSessionId: get().activeSessionId === id ? null : get().activeSessionId,
    });
  },

  updateSessionStatus: (id, status) => {
    const statusMap = new Map(get().sessionStatus);
    const current = statusMap.get(id) || { running: false, isProcessing: false };
    statusMap.set(id, { ...current, ...status });
    set({ sessionStatus: statusMap });
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  setConnected: (connected) => set({ isConnected: connected }),

  reorderSessions: (order) => set({ sessionsOrder: order }),
}));
