import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Session } from '../../types/session';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';
import { formatRelativeTime } from '../../utils/formatters';

interface SessionCardProps {
  session: Session;
  onPress: () => void;
  onDelete: () => void;
}

export function SessionCard({ session, onPress, onDelete }: SessionCardProps) {
  const handleLongPress = () => {
    Alert.alert(
      'Delete Session',
      `Are you sure you want to delete "${session.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ]
    );
  };

  const statusColor =
    session.status === 'running'
      ? COLORS.success
      : session.status === 'error'
      ? COLORS.error
      : COLORS.textMuted;

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      onLongPress={handleLongPress}
      delayLongPress={500}
    >
      <View style={styles.header}>
        <Text style={styles.name} numberOfLines={1}>
          {session.name}
        </Text>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
      </View>

      <Text style={styles.workingDir} numberOfLines={1}>
        {session.working_dir}
      </Text>

      <View style={styles.footer}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Claude JSON</Text>
        </View>
        <Text style={styles.time}>{formatRelativeTime(session.updated_at)}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 12,
    padding: SPACING.md,
    marginHorizontal: SPACING.md,
    marginVertical: SPACING.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.xs,
  },
  name: {
    flex: 1,
    fontSize: FONT_SIZES.lg,
    fontWeight: '600',
    color: COLORS.text,
    marginRight: SPACING.sm,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  workingDir: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginBottom: SPACING.sm,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  badge: {
    backgroundColor: COLORS.backgroundTertiary,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    fontWeight: '500',
  },
  time: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textMuted,
  },
});
