import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PairingCodeInput } from '../../components/auth/PairingCodeInput';
import { LoadingScreen } from '../../components/common/LoadingScreen';
import { useAuthStore } from '../../stores/authStore';
import { COLORS } from '../../utils/constants';

export default function PairingScreen() {
  const requestPairing = useAuthStore(state => state.requestPairing);
  const completePairing = useAuthStore(state => state.completePairing);
  const isPairing = useAuthStore(state => state.isPairing);
  const pairingId = useAuthStore(state => state.pairingId);
  const isLoading = useAuthStore(state => state.isLoading);
  const error = useAuthStore(state => state.error);
  const clearError = useAuthStore(state => state.clearError);

  useEffect(() => {
    // Request pairing when screen loads
    if (!pairingId && !isPairing) {
      requestPairing().catch(console.error);
    }
  }, [pairingId, isPairing, requestPairing]);

  const handleSubmit = async (code: string) => {
    clearError();
    try {
      await completePairing(code);
      router.replace('/(main)/sessions');
    } catch {
      // Error is handled in the store
    }
  };

  const handleCancel = () => {
    clearError();
    router.back();
  };

  if (!pairingId && isPairing) {
    return <LoadingScreen message="Requesting pairing..." />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <PairingCodeInput
          onSubmit={handleSubmit}
          onCancel={handleCancel}
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
