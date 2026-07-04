// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * React Native / Expo プラットフォーム依存の実装（KeyStore と SocketFactory）。
 * 中核ロジック（store.ts / relayClient.ts）はこれらをインターフェース越しに使うため、
 * テストではメモリ実装・fakeソケットに差し替えられる。
 */

import * as SecureStore from 'expo-secure-store';
import type { KeyStore } from './store.js';
import type { SocketFactory, SocketLike } from './relayClient.js';

/** expo-secure-store（iOS Keychain / Android Keystore）による KeyStore 実装。 */
export const secureKeyStore: KeyStore = {
	async getItem(key: string): Promise<string | null> {
		return SecureStore.getItemAsync(sanitize(key));
	},
	async setItem(key: string, value: string): Promise<void> {
		await SecureStore.setItemAsync(sanitize(key), value, {
			keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
		});
	},
	async deleteItem(key: string): Promise<void> {
		await SecureStore.deleteItemAsync(sanitize(key));
	},
};

// SecureStore のキーは英数・._- のみ許容されるため正規化する。
function sanitize(key: string): string {
	return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** React Native の global WebSocket を使う SocketFactory。 */
export const rnSocketFactory: SocketFactory = (url: string): SocketLike => {
	// RN の WebSocket は onopen/onmessage/onclose/onerror を持ち、SocketLike と互換。
	// binaryType は 'arraybuffer' を指定してバイナリを ArrayBuffer で受ける。
	const ws = new WebSocket(url);
	return ws as unknown as SocketLike;
};
