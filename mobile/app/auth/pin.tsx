import React from 'react';
import { View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PinInput } from '../../components/auth/PinInput';
import { useAuthStore } from '../../stores/authStore';
import { COLORS } from '../../utils/constants';

export default function PinScreen() {
  const loginWithPin = useAuthStore(state => state.loginWithPin);
  const isLoading = useAuthStore(state => state.isLoading);
  const error = useAuthStore(state => state.error);
  const clearError = useAuthStore(state => state.clearError);

  const handleSubmit = async (pin: string) => {
    clearError();
    await loginWithPin(pin);
    // If successful, navigate to main
    router.replace('/(main)/sessions');
  };

  const handleUsePairing = () => {
    clearError();
    router.push('/auth/pairing');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <PinInput
          onSubmit={handleSubmit}
          onUsePairing={handleUsePairing}
          isLoading={isLoading}
          error={error}
        />
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
