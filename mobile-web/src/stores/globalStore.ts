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

  // Settings from desktop
  showActiveSessionsGroup: boolean;

  // Pending scroll-to-message target (uuid). Set when a search hit is
  // tapped; consumed by MessageList once the messages render.
  pendingScrollTargetUuid: string | null;
  setPendingScrollTarget: (uuid: string | null) => void;

  // Search "back" trail. When a search hit is tapped:
  //   lastSearchQuery := the query that produced the hit list
  //   cameFromSearch  := true
  // ChatView shows a "Back to search" pill while cameFromSearch is true.
  // Tapping it triggers pendingSearchOpen, which SessionsView consumes to
  // re-open the SearchPanel pre-filled with lastSearchQuery.
  lastSearchQuery: string | null;
  cameFromSearch: boolean;
  pendingSearchOpen: boolean;
  rememberSearchQuery: (q: string) => void;
  triggerBackToSearch: () => void;
  consumePendingSearchOpen: () => string | null;
  clearSearchBackTrail: () => void;

  // Actions
  setSessions: (sessions: Session[]) => void;
  setFolders: (folders: Folder[]) => void;
  setShowActiveSessionsGroup: (value: boolean) => void;
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
  showActiveSessionsGroup: true,
  pendingScrollTargetUuid: null,
  setPendingScrollTarget: (uuid) => set({ pendingScrollTargetUuid: uuid }),

  lastSearchQuery: null,
  cameFromSearch: false,
  pendingSearchOpen: false,
  rememberSearchQuery: (q) => set({ lastSearchQuery: q, cameFromSearch: true }),
  triggerBackToSearch: () => set({ pendingSearchOpen: true, cameFromSearch: false }),
  consumePendingSearchOpen: () => {
    const q = get().lastSearchQuery;
    if (!get().pendingSearchOpen) return null;
    set({ pendingSearchOpen: false });
    return q;
  },
  clearSearchBackTrail: () => set({ cameFromSearch: false }),

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

  // Navigation: clear cameFromSearch by default so the back-pill only
  // shows when a search-hit handler explicitly sets it after this call.
  setActiveSession: (id) => set({ activeSessionId: id, cameFromSearch: false }),

  setConnected: (connected) => set({ isConnected: connected }),

  setShowActiveSessionsGroup: (value) => set({ showActiveSessionsGroup: value }),

  reorderSessions: (order) => set({ sessionsOrder: order }),
}));
