import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';

interface NewSessionModalProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (name: string, workingDir: string) => Promise<void>;
  isLoading: boolean;
  defaultWorkingDir: string;
}

export function NewSessionModal({
  visible,
  onClose,
  onSubmit,
  isLoading,
  defaultWorkingDir,
}: NewSessionModalProps) {
  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState(defaultWorkingDir);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    await onSubmit(name.trim(), workingDir.trim() || '~');
    setName('');
    setWorkingDir(defaultWorkingDir);
  };

  const handleClose = () => {
    setName('');
    setWorkingDir(defaultWorkingDir);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>New Session</Text>
            <TouchableOpacity onPress={handleClose}>
              <Text style={styles.closeButton}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>Session Name</Text>
            <TextInput
              style={styles.input}
              placeholder="My Chat Session"
              placeholderTextColor={COLORS.textMuted}
              value={name}
              onChangeText={setName}
              autoFocus
              editable={!isLoading}
            />

            <Text style={styles.label}>Working Directory</Text>
            <TextInput
              style={styles.input}
              placeholder="~"
              placeholderTextColor={COLORS.textMuted}
              value={workingDir}
              onChangeText={setWorkingDir}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isLoading}
            />
          </View>

          <TouchableOpacity
            style={[styles.submitButton, (!name.trim() || isLoading) && styles.submitDisabled]}
            onPress={handleSubmit}
            disabled={!name.trim() || isLoading}
          >
            <Text style={styles.submitText}>
              {isLoading ? 'Creating...' : 'Create Session'}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: COLORS.backgroundSecondary,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: SPACING.lg,
    paddingBottom: SPACING.xl + 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  title: {
    fontSize: FONT_SIZES.xl,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  closeButton: {
    fontSize: FONT_SIZES.md,
    color: COLORS.accent,
  },
  form: {
    marginBottom: SPACING.lg,
  },
  label: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
    marginTop: SPACING.md,
  },
  input: {
    backgroundColor: COLORS.backgroundTertiary,
    borderRadius: 12,
    padding: SPACING.md,
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  submitButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    padding: SPACING.md,
    alignItems: 'center',
  },
  submitDisabled: {
    opacity: 0.5,
  },
  submitText: {
    color: COLORS.text,
    fontSize: FONT_SIZES.lg,
    fontWeight: '600',
  },
});
