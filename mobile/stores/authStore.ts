import { create } from 'zustand';
import { Platform } from 'react-native';
import { apiClient } from '../services/api';
import {
  getAuthToken,
  setAuthToken,
  clearAuthToken,
  getServerUrl,
  setServerUrl,
  clearAllAuthData,
} from '../services/storage';

interface AuthState {
  serverUrl: string | null;
  authToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  pairingId: string | null;
  isPairing: boolean;
  pinEnabled: boolean;
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  setServerUrl: (url: string) => Promise<boolean>;
  checkPinStatus: () => Promise<boolean>;
  requestPairing: () => Promise<string>;
  completePairing: (code: string) => Promise<void>;
  loginWithPin: (pin: string) => Promise<void>;
  checkAuth: () => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
}

function getDeviceName(): string {
  const platform = Platform.OS === 'ios' ? 'iPhone' : 'Android';
  return `Agent Hub Mobile (${platform})`;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  serverUrl: null,
  authToken: null,
  isAuthenticated: false,
  isLoading: true,
  pairingId: null,
  isPairing: false,
  pinEnabled: false,
  error: null,

  initialize: async () => {
    set({ isLoading: true, error: null });
    try {
      const [storedUrl, storedToken] = await Promise.all([
        getServerUrl(),
        getAuthToken(),
      ]);

      if (storedUrl && storedToken) {
        apiClient.setBaseUrl(storedUrl);
        apiClient.setAuthToken(storedToken);

        // Verify token is still valid
        try {
          const result = await apiClient.checkAuth();
          if (result.valid) {
            set({
              serverUrl: storedUrl,
              authToken: storedToken,
              isAuthenticated: true,
              isLoading: false,
            });
            return;
          }
        } catch {
          // Token invalid, clear it
          await clearAuthToken();
        }
      }

      set({
        serverUrl: storedUrl,
        authToken: null,
        isAuthenticated: false,
        isLoading: false,
      });
    } catch (error) {
      console.error('Auth initialization error:', error);
      set({
        isAuthenticated: false,
        isLoading: false,
        error: 'Failed to initialize authentication',
      });
    }
  },

  setServerUrl: async (url: string) => {
    set({ isLoading: true, error: null });
    try {
      // Normalize URL
      let normalizedUrl = url.trim();
      if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        normalizedUrl = `http://${normalizedUrl}`;
      }

      apiClient.setBaseUrl(normalizedUrl);

      // Test connection by checking pin status
      await apiClient.getPinStatus();

      await setServerUrl(normalizedUrl);
      set({ serverUrl: normalizedUrl, isLoading: false });
      return true;
    } catch (error) {
      console.error('Server connection error:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to connect to server',
      });
      return false;
    }
  },

  checkPinStatus: async () => {
    try {
      const { enabled } = await apiClient.getPinStatus();
      set({ pinEnabled: enabled });
      return enabled;
    } catch (error) {
      console.error('Pin status check error:', error);
      set({ pinEnabled: false });
      return false;
    }
  },

  requestPairing: async () => {
    set({ isPairing: true, error: null });
    try {
      const { pairing_id } = await apiClient.requestPairing();
      set({ pairingId: pairing_id });
      return pairing_id;
    } catch (error) {
      console.error('Pairing request error:', error);
      set({
        isPairing: false,
        error: error instanceof Error ? error.message : 'Failed to request pairing',
      });
      throw error;
    }
  },

  completePairing: async (code: string) => {
    const { pairingId } = get();
    if (!pairingId) {
      throw new Error('No pairing in progress');
    }

    set({ isLoading: true, error: null });
    try {
      const { token } = await apiClient.completePairing(
        pairingId,
        code,
        getDeviceName()
      );

      await setAuthToken(token);
      apiClient.setAuthToken(token);

      set({
        authToken: token,
        isAuthenticated: true,
        isPairing: false,
        pairingId: null,
        isLoading: false,
      });
    } catch (error) {
      console.error('Pairing completion error:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Invalid pairing code',
      });
      throw error;
    }
  },

  loginWithPin: async (pin: string) => {
    set({ isLoading: true, error: null });
    try {
      const { token } = await apiClient.loginWithPin(pin, getDeviceName());

      await setAuthToken(token);
      apiClient.setAuthToken(token);

      set({
        authToken: token,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (error) {
      console.error('PIN login error:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Invalid PIN',
      });
      throw error;
    }
  },

  checkAuth: async () => {
    try {
      const result = await apiClient.checkAuth();
      if (!result.valid) {
        set({ isAuthenticated: false, authToken: null });
        await clearAuthToken();
      }
      return result.valid;
    } catch {
      set({ isAuthenticated: false, authToken: null });
      return false;
    }
  },

  logout: async () => {
    await clearAllAuthData();
    apiClient.setAuthToken(null);
    set({
      serverUrl: null,
      authToken: null,
      isAuthenticated: false,
      pairingId: null,
      isPairing: false,
    });
  },

  clearError: () => set({ error: null }),
}));
