import React from 'react';
import { View, StyleSheet, RefreshControl, FlatList } from 'react-native';
import { Session } from '../../types/session';
import { SessionCard } from './SessionCard';
import { EmptyState } from '../common/EmptyState';
import { COLORS, SPACING } from '../../utils/constants';

interface SessionListProps {
  sessions: Session[];
  isLoading: boolean;
  onRefresh: () => void;
  onSessionPress: (session: Session) => void;
  onSessionDelete: (session: Session) => void;
  onCreateSession: () => void;
}

export function SessionList({
  sessions,
  isLoading,
  onRefresh,
  onSessionPress,
  onSessionDelete,
  onCreateSession,
}: SessionListProps) {
  if (sessions.length === 0 && !isLoading) {
    return (
      <EmptyState
        title="No Sessions"
        message="Create a new session to start chatting with Claude"
        actionLabel="Create Session"
        onAction={onCreateSession}
      />
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={sessions}
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            onPress={() => onSessionPress(item)}
            onDelete={() => onSessionDelete(item)}
          />
        )}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={onRefresh}
            tintColor={COLORS.accent}
            colors={[COLORS.accent]}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  listContent: {
    paddingVertical: SPACING.sm,
  },
});
