import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore } from '../stores/authStore';
import { useSettingsStore } from '../stores/settingsStore';
import { COLORS } from '../utils/constants';

export default function RootLayout() {
  const initialize = useAuthStore(state => state.initialize);
  const initializeSettings = useSettingsStore(state => state.initialize);

  useEffect(() => {
    initialize();
    initializeSettings();
  }, [initialize, initializeSettings]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: COLORS.background }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: {
              backgroundColor: COLORS.background,
            },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="(main)" options={{ headerShown: false }} />
          <Stack.Screen name="auth" options={{ headerShown: false }} />
          <Stack.Screen name="index" options={{ headerShown: false }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
