import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface SettingsState {
  defaultWorkingDir: string;
  hapticFeedback: boolean;

  // Actions
  initialize: () => Promise<void>;
  setDefaultWorkingDir: (dir: string) => Promise<void>;
  setHapticFeedback: (enabled: boolean) => Promise<void>;
}

const SETTINGS_KEY = 'app_settings';

export const useSettingsStore = create<SettingsState>((set, get) => ({
  defaultWorkingDir: '~',
  hapticFeedback: true,

  initialize: async () => {
    try {
      const stored = await AsyncStorage.getItem(SETTINGS_KEY);
      if (stored) {
        const settings = JSON.parse(stored);
        set({
          defaultWorkingDir: settings.defaultWorkingDir || '~',
          hapticFeedback: settings.hapticFeedback ?? true,
        });
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  },

  setDefaultWorkingDir: async (dir: string) => {
    set({ defaultWorkingDir: dir });
    await persistSettings(get());
  },

  setHapticFeedback: async (enabled: boolean) => {
    set({ hapticFeedback: enabled });
    await persistSettings(get());
  },
}));

async function persistSettings(state: SettingsState) {
  try {
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        defaultWorkingDir: state.defaultWorkingDir,
        hapticFeedback: state.hapticFeedback,
      })
    );
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}
