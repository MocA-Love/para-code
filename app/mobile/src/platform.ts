// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * React Native / Expo プラットフォーム依存の実装（KeyStore と SocketFactory）。
 * 中核ロジック（store.ts / relayClient.ts）はこれらをインターフェース越しに使うため、
 * テストではメモリ実装・fakeソケットに差し替えられる。
 */

import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
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

// NSE（NotifyExtension）と共有するKeychainアクセスグループ。エンタイトルメントの
// keychain-access-groups（$(AppIdentifierPrefix)ltd.paradis.paracode.mobile.shared）と一致させる。
const NOTIFY_KEYCHAIN_ACCESS_GROUP = 'WB4G82C384.ltd.paradis.paracode.mobile.shared';

/**
 * 通知鍵（32バイトのhex）を、Notification Service Extension から読める共有Keychainへ保存する。
 * NSE はロック中にも起動するため AFTER_FIRST_UNLOCK を使う（初回ロック解除後は常に読める）。
 * シミュレータ等で accessGroup が使えない場合は失敗するが、プッシュ自体が使えない環境なので無視してよい。
 */
export async function persistNotifyKey(hex: string): Promise<void> {
	try {
		await SecureStore.setItemAsync('notifyKey', hex, {
			keychainService: 'paracode.notify',
			accessGroup: NOTIFY_KEYCHAIN_ACCESS_GROUP,
			keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
		});
	} catch (err) {
		console.warn('[platform] failed to persist notify key for NSE', err);
	}
}

/** React Native の global WebSocket を使う SocketFactory。 */
export const rnSocketFactory: SocketFactory = (url: string): SocketLike => {
	// RN の WebSocket は onopen/onmessage/onclose/onerror を持ち、SocketLike と互換。
	// binaryType は 'arraybuffer' を指定してバイナリを ArrayBuffer で受ける。
	const ws = new WebSocket(url);
	return ws as unknown as SocketLike;
};

// 前面表示中もバナーを出す（既定では前面時に抑制されるため）。
// モジュールのトップレベルで同期的に呼ぶと、ネイティブモジュール初期化のタイミング次第で
// 例外が上位（expo-router の entry.js の登録処理）まで伝播し、"App entry not found" として
// アプリ全体が起動不能になる。副作用は関数にくるみ、呼び出し側（appState.init）から
// try/catch 付きで一度だけ実行する。
let notificationHandlerConfigured = false;
export function configureNotificationHandler(): void {
	if (notificationHandlerConfigured) {
		return;
	}
	notificationHandlerConfigured = true;
	try {
		Notifications.setNotificationHandler({
			handleNotification: async () => ({
				// SDKバージョン差異に両対応（旧: shouldShowAlert / 新: shouldShowBanner+List）。
				shouldShowAlert: true,
				shouldShowBanner: true,
				shouldShowList: true,
				shouldPlaySound: true,
				shouldSetBadge: false,
			}),
		});
	} catch (err) {
		console.warn('[platform] failed to configure notification handler', err);
	}
}

/** ローカル通知の権限を要求する（初回接続時などに呼ぶ）。 */
export async function ensureNotificationPermission(): Promise<boolean> {
	const settings = await Notifications.getPermissionsAsync();
	if (settings.granted) {
		return true;
	}
	const req = await Notifications.requestPermissionsAsync();
	return req.granted;
}

/**
 * APNs デバイストークン（hex）を取得する。iOS実機以外（シミュレータ・Android・権限拒否）では
 * undefined を返す。取得したトークンはリレーへ register-push で登録し、アプリ未起動時の
 * リモートプッシュ（リレー→APNs→Notification Service Extension）の宛先になる。
 */
export async function getApnsDeviceToken(): Promise<string | undefined> {
	try {
		const granted = await ensureNotificationPermission();
		if (!granted) {
			return undefined;
		}
		const token = await Notifications.getDevicePushTokenAsync();
		// iOS では { type: 'ios', data: '<64桁hex>' }
		if (token.type === 'ios' && typeof token.data === 'string' && /^[0-9a-f]{64}$/i.test(token.data)) {
			return token.data.toLowerCase();
		}
		return undefined;
	} catch (err) {
		// シミュレータや entitlement 未設定では registerForRemoteNotifications が失敗する。ローカル通知は影響なし。
		console.warn('[platform] APNs token unavailable', err);
		return undefined;
	}
}

/**
 * ローカル通知を即時表示する（オンライン時の notify フレーム受信で使用）。
 * オフライン時の APNs リモート通知は、リレー→APNs→Notification Service Extension で別途配送する
 * （設計書 §5.2。NSE はネイティブ実装。ios/ の NotifyExtension ターゲット参照）。
 */
export async function presentLocalNotification(title: string, body: string, data: Record<string, unknown>): Promise<void> {
	await Notifications.scheduleNotificationAsync({
		content: { title, body, data },
		trigger: null, // 即時
	});
}
