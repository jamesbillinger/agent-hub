import React from 'react';
import {
  View,
  Text,
  TextInput,
  Switch,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';

export default function SettingsScreen() {
  const defaultWorkingDir = useSettingsStore(state => state.defaultWorkingDir);
  const hapticFeedback = useSettingsStore(state => state.hapticFeedback);
  const setDefaultWorkingDir = useSettingsStore(state => state.setDefaultWorkingDir);
  const setHapticFeedback = useSettingsStore(state => state.setHapticFeedback);
  const serverUrl = useAuthStore(state => state.serverUrl);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Connection</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Server</Text>
            <Text style={styles.value}>{serverUrl || 'Not connected'}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Sessions</Text>
          <View style={styles.inputRow}>
            <Text style={styles.label}>Default Working Directory</Text>
            <TextInput
              style={styles.input}
              value={defaultWorkingDir}
              onChangeText={setDefaultWorkingDir}
              placeholder="~"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Feedback</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Haptic Feedback</Text>
            <Switch
              value={hapticFeedback}
              onValueChange={setHapticFeedback}
              trackColor={{ false: COLORS.border, true: COLORS.accent }}
              thumbColor={COLORS.text}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Version</Text>
            <Text style={styles.value}>1.0.0</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: SPACING.md,
  },
  section: {
    marginBottom: SPACING.lg,
  },
  sectionTitle: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
    marginBottom: SPACING.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: COLORS.backgroundSecondary,
    padding: SPACING.md,
    borderRadius: 12,
    marginBottom: SPACING.xs,
  },
  inputRow: {
    backgroundColor: COLORS.backgroundSecondary,
    padding: SPACING.md,
    borderRadius: 12,
    marginBottom: SPACING.xs,
  },
  label: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
  },
  value: {
    fontSize: FONT_SIZES.md,
    color: COLORS.textSecondary,
  },
  input: {
    marginTop: SPACING.sm,
    backgroundColor: COLORS.backgroundTertiary,
    borderRadius: 8,
    padding: SPACING.sm,
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
  },
});
