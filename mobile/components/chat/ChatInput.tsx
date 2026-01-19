import React, { useState } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, disabled, placeholder = 'Type a message...' }: ChatInputProps) {
  const [text, setText] = useState('');

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend(trimmed);
    setText('');
  };

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <View style={styles.container}>
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder={placeholder}
            placeholderTextColor={COLORS.textMuted}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={10000}
            editable={!disabled}
            returnKeyType="default"
          />
          <TouchableOpacity
            style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!canSend}
          >
            <View style={styles.sendIcon}>
              <View style={[styles.arrow, !canSend && styles.arrowDisabled]} />
            </View>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.background,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    paddingBottom: Platform.OS === 'ios' ? SPACING.lg : SPACING.sm,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 20,
    paddingLeft: SPACING.md,
    paddingRight: SPACING.xs,
    paddingVertical: SPACING.xs,
    minHeight: 40,
  },
  input: {
    flex: 1,
    color: COLORS.text,
    fontSize: FONT_SIZES.md,
    maxHeight: 120,
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
  },
  sendButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: SPACING.xs,
  },
  sendButtonDisabled: {
    backgroundColor: COLORS.backgroundTertiary,
  },
  sendIcon: {
    width: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  arrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: COLORS.text,
    transform: [{ translateY: -1 }],
  },
  arrowDisabled: {
    borderBottomColor: COLORS.textMuted,
  },
});
