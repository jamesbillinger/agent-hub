import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';

interface StatusBarProps {
  connected: boolean;
  serverUrl?: string | null;
}

export function ConnectionStatusBar({ connected, serverUrl }: StatusBarProps) {
  return (
    <View style={[styles.container, connected ? styles.connected : styles.disconnected]}>
      <View style={[styles.dot, connected ? styles.dotConnected : styles.dotDisconnected]} />
      <Text style={styles.text}>
        {connected ? 'Connected' : 'Disconnected'}
        {serverUrl && connected && (
          <Text style={styles.serverUrl}> - {serverUrl.replace(/^https?:\/\//, '')}</Text>
        )}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  connected: {
    backgroundColor: 'rgba(76, 175, 80, 0.1)',
  },
  disconnected: {
    backgroundColor: 'rgba(244, 67, 54, 0.1)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: SPACING.sm,
  },
  dotConnected: {
    backgroundColor: COLORS.success,
  },
  dotDisconnected: {
    backgroundColor: COLORS.error,
  },
  text: {
    color: COLORS.text,
    fontSize: FONT_SIZES.sm,
  },
  serverUrl: {
    color: COLORS.textSecondary,
  },
});
