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
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';

interface PairingCodeInputProps {
  onSubmit: (code: string) => Promise<void>;
  onCancel: () => void;
  isLoading: boolean;
  error?: string | null;
}

export function PairingCodeInput({
  onSubmit,
  onCancel,
  isLoading,
  error,
}: PairingCodeInputProps) {
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  const handleCodeChange = (index: number, value: string) => {
    // Only allow numbers
    const numericValue = value.replace(/[^0-9]/g, '');
    if (numericValue.length > 1) {
      // Handle paste
      const digits = numericValue.slice(0, 6).split('');
      const newCode = [...code];
      digits.forEach((digit, i) => {
        if (index + i < 6) {
          newCode[index + i] = digit;
        }
      });
      setCode(newCode);
      const nextIndex = Math.min(index + digits.length, 5);
      inputRefs.current[nextIndex]?.focus();
    } else {
      const newCode = [...code];
      newCode[index] = numericValue;
      setCode(newCode);

      // Move to next input
      if (numericValue && index < 5) {
        inputRefs.current[index + 1]?.focus();
      }
    }
  };

  const handleKeyPress = (index: number, key: string) => {
    if (key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleSubmit = async () => {
    const fullCode = code.join('');
    if (fullCode.length === 6) {
      await onSubmit(fullCode);
    }
  };

  const isComplete = code.every(c => c !== '');

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Enter Pairing Code</Text>
        <Text style={styles.subtitle}>
          Enter the 6-digit code shown on your desktop
        </Text>

        <View style={styles.codeContainer}>
          {code.map((digit, index) => (
            <TextInput
              key={index}
              ref={(ref) => { inputRefs.current[index] = ref; }}
              style={[styles.codeInput, digit && styles.codeInputFilled]}
              value={digit}
              onChangeText={value => handleCodeChange(index, value)}
              onKeyPress={({ nativeEvent }) => handleKeyPress(index, nativeEvent.key)}
              keyboardType="number-pad"
              maxLength={6}
              selectTextOnFocus
              editable={!isLoading}
            />
          ))}
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, (!isComplete || isLoading) && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={!isComplete || isLoading}
        >
          <Text style={styles.buttonText}>
            {isLoading ? 'Verifying...' : 'Pair Device'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
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
  codeContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.lg,
  },
  codeInput: {
    width: 48,
    height: 56,
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    fontSize: FONT_SIZES.xl,
    fontWeight: 'bold',
    color: COLORS.text,
    textAlign: 'center',
  },
  codeInputFilled: {
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
  cancelButton: {
    padding: SPACING.md,
    alignItems: 'center',
  },
  cancelText: {
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.md,
  },
});
