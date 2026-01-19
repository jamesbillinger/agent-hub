import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, Stack, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChatView } from '../../../components/chat/ChatView';
import { LoadingScreen } from '../../../components/common/LoadingScreen';
import { ErrorView } from '../../../components/common/ErrorView';
import { useSessionsStore } from '../../../stores/sessionsStore';
import { COLORS } from '../../../utils/constants';

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessions = useSessionsStore(state => state.sessions);
  const fetchSessions = useSessionsStore(state => state.fetchSessions);
  const isLoading = useSessionsStore(state => state.isLoading);

  const session = sessions.find(s => s.id === id);

  useEffect(() => {
    // Refresh sessions if we don't have this one
    if (!session && !isLoading) {
      fetchSessions();
    }
  }, [session, isLoading, fetchSessions]);

  if (!id) {
    return (
      <ErrorView
        message="Invalid session ID"
        onRetry={() => router.back()}
      />
    );
  }

  if (!session && isLoading) {
    return <LoadingScreen message="Loading session..." />;
  }

  if (!session) {
    return (
      <ErrorView
        message="Session not found"
        onRetry={() => router.back()}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: session.name,
          headerBackTitle: 'Sessions',
        }}
      />
      <View style={styles.content}>
        <ChatView sessionId={id} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    flex: 1,
  },
});
