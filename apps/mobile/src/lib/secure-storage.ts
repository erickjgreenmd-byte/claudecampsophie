import * as SecureStore from 'expo-secure-store';
import type { SecureStorage } from './mode.ts';

/** Device keychain/keystore storage for child refresh tokens and mode (never adult credentials). */
export const secureStorage: SecureStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};
