import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';

interface PinInputProps {
  onSubmit: (pin: string) => Promise<void>;
  onUsePairing: () => void;
  isLoading: boolean;
  error?: string | null;
}

export function PinInput({ onSubmit, onUsePairing, isLoading, error }: PinInputProps) {
  const [pin, setPin] = useState('');
  const inputRef = useRef<TextInput>(null);

  const handlePinChange = (value: string) => {
    const numericValue = value.replace(/[^0-9]/g, '');
    setPin(numericValue);
  };

  const handleSubmit = async () => {
    if (pin.length >= 4) {
      try {
        await onSubmit(pin);
      } catch {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPin('');
        inputRef.current?.focus();
      }
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Enter PIN</Text>
        <Text style={styles.subtitle}>
          Enter your Agent Hub PIN to connect
        </Text>

        <View style={styles.pinContainer}>
          <TextInput
            ref={inputRef}
            style={styles.pinInput}
            value={pin}
            onChangeText={handlePinChange}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={8}
            autoFocus
            editable={!isLoading}
            placeholder="----"
            placeholderTextColor={COLORS.textMuted}
          />
        </View>

        {/* Pin dots display */}
        <View style={styles.dotsContainer}>
          {[...Array(Math.max(4, pin.length))].map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i < pin.length && styles.dotFilled]}
            />
          ))}
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, (pin.length < 4 || isLoading) && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={pin.length < 4 || isLoading}
        >
          <Text style={styles.buttonText}>
            {isLoading ? 'Authenticating...' : 'Login'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.pairingButton} onPress={onUsePairing}>
          <Text style={styles.pairingText}>Use pairing code instead</Text>
        </TouchableOpacity>
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
  pinContainer: {
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  pinInput: {
    width: 200,
    height: 56,
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    fontSize: FONT_SIZES.xl,
    fontWeight: 'bold',
    color: COLORS.text,
    textAlign: 'center',
    letterSpacing: 8,
  },
  dotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.lg,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.backgroundTertiary,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  dotFilled: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
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
    marginBottom: SPACING.md,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: COLORS.text,
    fontSize: FONT_SIZES.lg,
    fontWeight: '600',
  },
  pairingButton: {
    padding: SPACING.md,
    alignItems: 'center',
  },
  pairingText: {
    color: COLORS.accent,
    fontSize: FONT_SIZES.md,
  },
});
