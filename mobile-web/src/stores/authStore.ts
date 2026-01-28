import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  serverUrl: string | null;
  authToken: string | null;
  isAuthenticated: boolean;
  pinEnabled: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  setServerUrl: (url: string) => void;
  setAuthToken: (token: string) => void;
  setPinEnabled: (enabled: boolean) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      serverUrl: null,
      authToken: null,
      isAuthenticated: false,
      pinEnabled: false,
      isLoading: false,
      error: null,

      setServerUrl: (url) => set({ serverUrl: url, error: null }),

      setAuthToken: (token) => set({
        authToken: token,
        isAuthenticated: true,
        error: null
      }),

      setPinEnabled: (enabled) => set({ pinEnabled: enabled }),

      setError: (error) => set({ error, isLoading: false }),

      setLoading: (loading) => set({ isLoading: loading }),

      logout: () => set({
        authToken: null,
        isAuthenticated: false,
        error: null,
      }),
    }),
    {
      name: 'agent-hub-auth',
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        authToken: state.authToken,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
