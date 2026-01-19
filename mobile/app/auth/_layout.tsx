import React from 'react';
import { Stack } from 'expo-router';
import { COLORS } from '../../utils/constants';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: COLORS.backgroundSecondary,
        },
        headerTintColor: COLORS.text,
        headerTitleStyle: {
          fontWeight: '600',
        },
        contentStyle: {
          backgroundColor: COLORS.background,
        },
        headerShown: false,
      }}
    />
  );
}
