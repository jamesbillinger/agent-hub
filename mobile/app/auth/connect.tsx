import React from 'react';
import { View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ServerInput } from '../../components/auth/ServerInput';
import { useAuthStore } from '../../stores/authStore';
import { COLORS } from '../../utils/constants';

export default function ConnectScreen() {
  const setServerUrl = useAuthStore(state => state.setServerUrl);
  const checkPinStatus = useAuthStore(state => state.checkPinStatus);
  const isLoading = useAuthStore(state => state.isLoading);
  const error = useAuthStore(state => state.error);
  const clearError = useAuthStore(state => state.clearError);

  const handleConnect = async (url: string) => {
    clearError();
    const success = await setServerUrl(url);
    if (success) {
      const pinEnabled = await checkPinStatus();
      if (pinEnabled) {
        router.replace('/auth/pin');
      } else {
        router.replace('/auth/pairing');
      }
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <ServerInput
          onConnect={handleConnect}
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
