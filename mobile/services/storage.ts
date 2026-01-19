import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from '../utils/constants';

// Secure storage for sensitive data (tokens)
export async function getSecureItem(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (error) {
    console.error('SecureStore get error:', error);
    return null;
  }
}

export async function setSecureItem(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch (error) {
    console.error('SecureStore set error:', error);
    throw error;
  }
}

export async function deleteSecureItem(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (error) {
    console.error('SecureStore delete error:', error);
  }
}

// Regular storage for non-sensitive data
export async function getItem(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch (error) {
    console.error('AsyncStorage get error:', error);
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch (error) {
    console.error('AsyncStorage set error:', error);
    throw error;
  }
}

export async function deleteItem(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch (error) {
    console.error('AsyncStorage delete error:', error);
  }
}

// Auth-specific helpers
export async function getAuthToken(): Promise<string | null> {
  return getSecureItem(STORAGE_KEYS.AUTH_TOKEN);
}

export async function setAuthToken(token: string): Promise<void> {
  return setSecureItem(STORAGE_KEYS.AUTH_TOKEN, token);
}

export async function clearAuthToken(): Promise<void> {
  return deleteSecureItem(STORAGE_KEYS.AUTH_TOKEN);
}

export async function getServerUrl(): Promise<string | null> {
  return getItem(STORAGE_KEYS.SERVER_URL);
}

export async function setServerUrl(url: string): Promise<void> {
  return setItem(STORAGE_KEYS.SERVER_URL, url);
}

export async function clearServerUrl(): Promise<void> {
  return deleteItem(STORAGE_KEYS.SERVER_URL);
}

export async function clearAllAuthData(): Promise<void> {
  await Promise.all([
    clearAuthToken(),
    clearServerUrl(),
    deleteItem(STORAGE_KEYS.DEVICE_ID),
  ]);
}
