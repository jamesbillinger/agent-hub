import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { COLORS, FONT_SIZES, SPACING, DEFAULT_PORT } from '../../utils/constants';

interface ServerInputProps {
  onConnect: (url: string) => Promise<void>;
  isLoading: boolean;
  error?: string | null;
}

export function ServerInput({ onConnect, isLoading, error }: ServerInputProps) {
  const [serverAddress, setServerAddress] = useState('');

  const handleConnect = async () => {
    if (!serverAddress.trim()) return;

    let url = serverAddress.trim();
    // Add default port if not specified
    if (!url.includes(':') && !url.includes('localhost')) {
      url = `${url}:${DEFAULT_PORT}`;
    } else if (url === 'localhost' || url === '127.0.0.1') {
      url = `${url}:${DEFAULT_PORT}`;
    }

    await onConnect(url);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Connect to Server</Text>
        <Text style={styles.subtitle}>
          Enter your Agent Hub desktop server address
        </Text>

        <TextInput
          style={styles.input}
          placeholder={`192.168.1.100:${DEFAULT_PORT}`}
          placeholderTextColor={COLORS.textMuted}
          value={serverAddress}
          onChangeText={setServerAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={handleConnect}
          editable={!isLoading}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, (!serverAddress.trim() || isLoading) && styles.buttonDisabled]}
          onPress={handleConnect}
          disabled={!serverAddress.trim() || isLoading}
        >
          <Text style={styles.buttonText}>
            {isLoading ? 'Connecting...' : 'Connect'}
          </Text>
        </TouchableOpacity>

        <Text style={styles.hint}>
          Make sure Agent Hub is running on your computer and the server is enabled in Settings.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  title: {
    fontSize: FONT_SIZES.xxl,
    fontWeight: 'bold',
    color: COLORS.text,
    textAlign: 'center',
    marginBottom: SPACING.sm,
  },
  subtitle: {
    fontSize: FONT_SIZES.md,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  input: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 12,
    padding: SPACING.md,
    fontSize: FONT_SIZES.lg,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.md,
  },
  error: {
    color: COLORS.error,
    fontSize: FONT_SIZES.sm,
    textAlign: 'center',
    marginBottom: SPACING.md,
  },
  button: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    padding: SPACING.md,
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: COLORS.text,
    fontSize: FONT_SIZES.lg,
    fontWeight: '600',
  },
  hint: {
    color: COLORS.textMuted,
    fontSize: FONT_SIZES.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
});
