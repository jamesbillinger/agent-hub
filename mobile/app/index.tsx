import React, { useEffect } from 'react';
import { Redirect } from 'expo-router';
import { useAuthStore } from '../stores/authStore';
import { LoadingScreen } from '../components/common/LoadingScreen';

export default function Index() {
  const isLoading = useAuthStore(state => state.isLoading);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const serverUrl = useAuthStore(state => state.serverUrl);

  if (isLoading) {
    return <LoadingScreen message="Initializing..." />;
  }

  // If authenticated, go to main sessions screen
  if (isAuthenticated) {
    return <Redirect href="/(main)/sessions" />;
  }

  // If server URL is set but not authenticated, go to auth selection
  if (serverUrl) {
    return <Redirect href="/auth/connect" />;
  }

  // Otherwise, go to server connection screen
  return <Redirect href="/auth/connect" />;
}
