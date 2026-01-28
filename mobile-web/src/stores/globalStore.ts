import { create } from 'zustand';
import type { Session, SessionStatus } from '../types';

interface GlobalState {
  // Sessions
  sessions: Map<string, Session>;
  sessionsOrder: string[];

  // Per-session status (for list view indicators)
  sessionStatus: Map<string, SessionStatus>;

  // Active session
  activeSessionId: string | null;

  // WebSocket connection state
  isConnected: boolean;

  // Actions
  setSessions: (sessions: Session[]) => void;
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
      // Initialize status if not exists
      if (!get().sessionStatus.has(session.id)) {
        statusMap.set(session.id, { running: false, isProcessing: false });
      } else {
        statusMap.set(session.id, get().sessionStatus.get(session.id)!);
      }
    }

    set({ sessions: sessionsMap, sessionsOrder: order, sessionStatus: statusMap });
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
