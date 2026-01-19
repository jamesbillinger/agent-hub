import React, { useEffect, useState, useCallback } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Alert } from 'react-native';
import { router, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SessionList } from '../../components/sessions/SessionList';
import { NewSessionModal } from '../../components/sessions/NewSessionModal';
import { LoadingScreen } from '../../components/common/LoadingScreen';
import { useSessionsStore } from '../../stores/sessionsStore';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Session } from '../../types/session';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';

export default function SessionsScreen() {
  const sessions = useSessionsStore(state => state.sessions);
  const isLoading = useSessionsStore(state => state.isLoading);
  const error = useSessionsStore(state => state.error);
  const fetchSessions = useSessionsStore(state => state.fetchSessions);
  const createSession = useSessionsStore(state => state.createSession);
  const deleteSession = useSessionsStore(state => state.deleteSession);
  const clearError = useSessionsStore(state => state.clearError);

  const logout = useAuthStore(state => state.logout);
  const serverUrl = useAuthStore(state => state.serverUrl);
  const defaultWorkingDir = useSettingsStore(state => state.defaultWorkingDir);

  const [showNewSession, setShowNewSession] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  useEffect(() => {
    fetchSessions().finally(() => setInitialLoadDone(true));
  }, [fetchSessions]);

  useEffect(() => {
    if (error) {
      Alert.alert('Error', error, [{ text: 'OK', onPress: clearError }]);
    }
  }, [error, clearError]);

  const handleRefresh = useCallback(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleSessionPress = useCallback((session: Session) => {
    router.push(`/(main)/session/${session.id}`);
  }, []);

  const handleSessionDelete = useCallback(async (session: Session) => {
    try {
      await deleteSession(session.id);
    } catch {
      // Error handled in store
    }
  }, [deleteSession]);

  const handleCreateSession = useCallback(async (name: string, workingDir: string) => {
    setIsCreating(true);
    try {
      const session = await createSession({ name, working_dir: workingDir });
      setShowNewSession(false);
      router.push(`/(main)/session/${session.id}`);
    } catch {
      // Error handled in store
    } finally {
      setIsCreating(false);
    }
  }, [createSession]);

  const handleLogout = useCallback(() => {
    Alert.alert(
      'Disconnect',
      'Are you sure you want to disconnect from the server?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/auth/connect');
          },
        },
      ]
    );
  }, [logout]);

  if (!initialLoadDone && isLoading) {
    return <LoadingScreen message="Loading sessions..." />;
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: 'Sessions',
          headerRight: () => (
            <TouchableOpacity onPress={handleLogout} style={styles.logoutButton}>
              <Text style={styles.logoutText}>Disconnect</Text>
            </TouchableOpacity>
          ),
        }}
      />

      <SessionList
        sessions={sessions}
        isLoading={isLoading}
        onRefresh={handleRefresh}
        onSessionPress={handleSessionPress}
        onSessionDelete={handleSessionDelete}
        onCreateSession={() => setShowNewSession(true)}
      />

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setShowNewSession(true)}
      >
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>

      <NewSessionModal
        visible={showNewSession}
        onClose={() => setShowNewSession(false)}
        onSubmit={handleCreateSession}
        isLoading={isCreating}
        defaultWorkingDir={defaultWorkingDir}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  logoutButton: {
    paddingHorizontal: SPACING.sm,
  },
  logoutText: {
    color: COLORS.error,
    fontSize: FONT_SIZES.sm,
  },
  fab: {
    position: 'absolute',
    right: SPACING.lg,
    bottom: SPACING.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.accent,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabText: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '300',
    marginTop: -2,
  },
});
