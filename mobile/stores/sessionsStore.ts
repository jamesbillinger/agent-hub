import { create } from 'zustand';
import { apiClient } from '../services/api';
import { Session, CreateSessionRequest } from '../types/session';

interface SessionsState {
  sessions: Session[];
  activeSessionId: string | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchSessions: () => Promise<void>;
  createSession: (data: Omit<CreateSessionRequest, 'agent_type'>) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  startSession: (id: string) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  getSession: (id: string) => Session | undefined;
  clearError: () => void;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,
  error: null,

  fetchSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const sessions = await apiClient.getSessions();
      // Filter to only claude-json sessions
      const jsonSessions = sessions.filter(s => s.agent_type === 'claude-json');
      set({ sessions: jsonSessions, isLoading: false });
    } catch (error) {
      console.error('Fetch sessions error:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load sessions',
      });
    }
  },

  createSession: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const session = await apiClient.createSession({
        ...data,
        agent_type: 'claude-json',
      });
      set(state => ({
        sessions: [...state.sessions, session],
        isLoading: false,
      }));
      return session;
    } catch (error) {
      console.error('Create session error:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to create session',
      });
      throw error;
    }
  },

  deleteSession: async (id: string) => {
    set({ error: null });
    try {
      await apiClient.deleteSession(id);
      set(state => ({
        sessions: state.sessions.filter(s => s.id !== id),
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
      }));
    } catch (error) {
      console.error('Delete session error:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to delete session',
      });
      throw error;
    }
  },

  startSession: async (id: string) => {
    set({ error: null });
    try {
      await apiClient.startSession(id);
      set(state => ({
        sessions: state.sessions.map(s =>
          s.id === id ? { ...s, status: 'running' as const } : s
        ),
      }));
    } catch (error) {
      console.error('Start session error:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to start session',
      });
      throw error;
    }
  },

  setActiveSession: (id: string | null) => {
    set({ activeSessionId: id });
  },

  getSession: (id: string) => {
    return get().sessions.find(s => s.id === id);
  },

  clearError: () => set({ error: null }),
}));
