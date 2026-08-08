// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * React Native / Expo プラットフォーム依存の実装（KeyStore と SocketFactory）。
 * 中核ロジック（store.ts / relayClient.ts）はこれらをインターフェース越しに使うため、
 * テストではメモリ実装・fakeソケットに差し替えられる。
 */

import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import type { KeyStore, TerminalOperationOutboxStore } from './store.js';
import type { SocketFactory, SocketLike } from './relayClient.js';
import {
	KeychainLockedError,
	isKeychainLockedError,
	migrateKeychainAccessibility,
	type KeychainAccessible,
} from './keychainAccessibility.js';

function keychainAccessibleValue(accessible: KeychainAccessible): SecureStore.KeychainAccessibilityConstant {
	return accessible === 'afterFirstUnlock'
		? SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
		: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
}

/**
 * 端末ロック中に起こされた起動でも読めるようにする（keychainAccessibility.ts 参照）。
 * NSE と共有する通知鍵と同じ水準。
 */
const DEFAULT_KEYCHAIN_ACCESSIBLE: KeychainAccessible = 'afterFirstUnlock';

/**
 * 既存項目のアクセシビリティ移行。全操作の手前で1度だけ走らせる。
 * 失敗しても呼び出し側の操作は止めない（番人を立てないので次回起動でやり直す）。
 */
let keychainMigration: Promise<void> | undefined;
function ensureKeychainMigrated(): Promise<void> {
	// `sanitize` は KeyStore の書き込みと同じ正規化。移行が素のキーを触ると、記号を含むキーが
	// 追加されたときに「別の項目を作り直す」に化ける。
	keychainMigration ??= migrateKeychainAccessibility({
		read: key => SecureStore.getItemAsync(sanitize(key)),
		write: (key, value, accessible) => SecureStore.setItemAsync(sanitize(key), value, {
			keychainAccessible: keychainAccessibleValue(accessible),
		}),
		remove: key => SecureStore.deleteItemAsync(sanitize(key)),
	}).then(() => undefined).catch(error => {
		console.warn('[platform] keychain accessibility migration deferred', error);
	});
	return keychainMigration;
}

/** expo-secure-store（iOS Keychain / Android Keystore）による KeyStore 実装。 */
export const secureKeyStore: KeyStore = {
	async getItem(key: string): Promise<string | null> {
		await ensureKeychainMigrated();
		try {
			return await SecureStore.getItemAsync(sanitize(key));
		} catch (error) {
			// 「ロックされていて読めない」を null にしてはいけない。呼び出し側は null を
			// 「まだ保存されていない」と解釈し、鍵を作り直してペアリングを捨てる。
			if (isKeychainLockedError(error)) {
				throw new KeychainLockedError(key, error);
			}
			throw error;
		}
	},
	async setItem(key: string, value: string): Promise<void> {
		await ensureKeychainMigrated();
		await SecureStore.setItemAsync(sanitize(key), value, {
			keychainAccessible: keychainAccessibleValue(DEFAULT_KEYCHAIN_ACCESSIBLE),
		});
	},
	async deleteItem(key: string): Promise<void> {
		await ensureKeychainMigrated();
		await SecureStore.deleteItemAsync(sanitize(key));
	},
};

/**
 * 未確定のターミナル操作を退避するファイルの置き場。**PC（ペアリング相手）ごとに分ける。**
 * 1本しか無いと、別のPCへ切り替えた瞬間に相手が変わったと判定されて中身が捨てられ、
 * 送ったか分からない操作の記録が失われる（MobileController.connect のスコープ比較）。
 *
 * 単一PCしか扱えなかった頃のファイル名（サフィックス無し）は、最初に読み込むPCのぶんとして
 * `migrateLegacyTerminalOperationOutbox()` が引き継ぐ。
 */
const TERMINAL_OPERATION_OUTBOX_BASE = LegacyFileSystem.documentDirectory
	? `${LegacyFileSystem.documentDirectory}terminal-operation-outbox.v1`
	: undefined;

interface OutboxPaths {
	readonly primary: string;
	readonly next: string;
	readonly backup: string;
	readonly commit: string;
}

/** ファイル名に使えるようPC識別子を正規化する（deviceId は base64url なので `-`/`_` を含む）。 */
function outboxPathsFor(pcId: string): OutboxPaths | undefined {
	if (TERMINAL_OPERATION_OUTBOX_BASE === undefined) {
		return undefined;
	}
	const suffix = pcId.replace(/[^A-Za-z0-9._-]/g, '_');
	const primary = suffix.length > 0 ? `${TERMINAL_OPERATION_OUTBOX_BASE}.${suffix}` : TERMINAL_OPERATION_OUTBOX_BASE;
	return { primary, next: `${primary}.next`, backup: `${primary}.backup`, commit: `${primary}.next.commit` };
}

async function readOperationOutbox(path: string | undefined): Promise<string | null> {
	if (path === undefined) {
		return null;
	}
	try {
		return await LegacyFileSystem.readAsStringAsync(path);
	} catch {
		return null;
	}
}

async function readOperationOutboxStrict(path: string): Promise<string | null> {
	const info = await LegacyFileSystem.getInfoAsync(path);
	return info.exists ? LegacyFileSystem.readAsStringAsync(path) : null;
}

function operationOutboxCommitToken(value: string): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193) >>> 0;
		second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
	}
	return `${value.length}:${first.toString(16)}:${second.toString(16)}`;
}

async function promoteCommittedOperationOutboxNext(paths: OutboxPaths | undefined): Promise<boolean> {
	if (paths === undefined) {
		return false;
	}
	const [next, marker] = await Promise.all([
		readOperationOutboxStrict(paths.next),
		readOperationOutboxStrict(paths.commit),
	]);
	if (next === null || marker !== operationOutboxCommitToken(next)) {
		return false;
	}
	const current = await LegacyFileSystem.getInfoAsync(paths.primary);
	try {
		if (current.exists) {
			await LegacyFileSystem.deleteAsync(paths.backup, { idempotent: true });
			await LegacyFileSystem.moveAsync({ from: paths.primary, to: paths.backup });
		}
		await LegacyFileSystem.moveAsync({ from: paths.next, to: paths.primary });
	} catch (error) {
		if (current.exists) {
			await LegacyFileSystem.moveAsync({ from: paths.backup, to: paths.primary }).catch(() => { });
		}
		throw error;
	}
	await LegacyFileSystem.deleteAsync(paths.commit, { idempotent: true }).catch(() => { });
	await LegacyFileSystem.deleteAsync(paths.backup, { idempotent: true }).catch(() => { });
	return true;
}

/**
 * 指定PC専用の操作アウトボックスを作る。payloadはMobileControllerがidentity由来鍵で
 * AEAD暗号化してから渡す（このレイヤーは中身を見ない）。
 */
export function createTerminalOperationOutboxStore(pcId: string): TerminalOperationOutboxStore {
	const paths = outboxPathsFor(pcId);
	return {
		async loadCandidates(): Promise<readonly string[]> {
			const [next, marker, primary, backup] = await Promise.all([
				readOperationOutbox(paths?.next),
				readOperationOutbox(paths?.commit),
				readOperationOutbox(paths?.primary),
				readOperationOutbox(paths?.backup),
			]);
			const committedNext = next !== null && marker === operationOutboxCommitToken(next) ? next : null;
			// marker付き.nextだけをcommit済み最新snapshotとして扱う。保存失敗後に掃除できなかった
			// 未commit.nextが、再起動後に操作として復活することを防ぐ。
			return [committedNext, primary, backup].filter((candidate): candidate is string => candidate !== null);
		},
		async save(encrypted: string): Promise<void> {
			if (paths === undefined) {
				throw new Error('operation outbox storage is unavailable');
			}
			// 前回renameだけ失敗したcommit済み.nextを先に昇格する。昇格できない間は新しい
			// snapshotで上書きせず、既に受理した操作のdurabilityを守る。
			await promoteCommittedOperationOutboxNext(paths);
			await LegacyFileSystem.deleteAsync(paths.commit, { idempotent: true });
			await LegacyFileSystem.writeAsStringAsync(paths.next, encrypted, { encoding: LegacyFileSystem.EncodingType.UTF8 });
			try {
				await LegacyFileSystem.writeAsStringAsync(paths.commit, operationOutboxCommitToken(encrypted), { encoding: LegacyFileSystem.EncodingType.UTF8 });
			} catch (error) {
				await LegacyFileSystem.deleteAsync(paths.next, { idempotent: true }).catch(() => { });
				throw error;
			}
			// marker書込み後は.next自体がcommit済み。renameに失敗してもload時に復旧できるため、
			// 呼び出し元へは保存成功として返し、PC送信とjournalの判断を一致させる。
			await promoteCommittedOperationOutboxNext(paths).catch(() => { });
		},
		async clear(): Promise<void> {
			if (paths === undefined) {
				return;
			}
			await Promise.all([
				LegacyFileSystem.deleteAsync(paths.primary, { idempotent: true }),
				LegacyFileSystem.deleteAsync(paths.next, { idempotent: true }),
				LegacyFileSystem.deleteAsync(paths.backup, { idempotent: true }),
				LegacyFileSystem.deleteAsync(paths.commit, { idempotent: true }),
			]);
		},
	};
}

/**
 * 単一PC時代のアウトボックス（サフィックス無し）を、指定PCのファイル名へ引き継ぐ。
 * PC単位のファイルが既にある場合は何もしない（新しい方を壊さない）。
 * 失敗しても呼び出し側を止めない: 最悪でも「送ったか分からない操作の記録が1回ぶん消える」だけで、
 * それは旧版から複数PC対応版へ上げた初回にしか起こらない。
 */
export async function migrateLegacyTerminalOperationOutbox(pcId: string): Promise<void> {
	const paths = outboxPathsFor(pcId);
	if (paths === undefined || TERMINAL_OPERATION_OUTBOX_BASE === undefined || paths.primary === TERMINAL_OPERATION_OUTBOX_BASE) {
		return;
	}
	const legacy: OutboxPaths = {
		primary: TERMINAL_OPERATION_OUTBOX_BASE,
		next: `${TERMINAL_OPERATION_OUTBOX_BASE}.next`,
		backup: `${TERMINAL_OPERATION_OUTBOX_BASE}.backup`,
		commit: `${TERMINAL_OPERATION_OUTBOX_BASE}.next.commit`,
	};
	for (const [from, to] of [[legacy.primary, paths.primary], [legacy.next, paths.next], [legacy.backup, paths.backup], [legacy.commit, paths.commit]] as const) {
		try {
			const [source, destination] = await Promise.all([LegacyFileSystem.getInfoAsync(from), LegacyFileSystem.getInfoAsync(to)]);
			if (source.exists && !destination.exists) {
				await LegacyFileSystem.moveAsync({ from, to });
			}
		} catch (error) {
			console.warn('[platform] legacy operation outbox migration skipped', error);
		}
	}
}

// SecureStore のキーは英数・._- のみ許容されるため正規化する。
function sanitize(key: string): string {
	return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

// NSE（NotifyExtension）と共有するKeychainアクセスグループ。エンタイトルメントの
// keychain-access-groups（$(AppIdentifierPrefix)ltd.paradis.paracode.mobile.shared）と一致させる。
const NOTIFY_KEYCHAIN_ACCESS_GROUP = 'WB4G82C384.ltd.paradis.paracode.mobile.shared';

/**
 * 通知鍵はPC（ペアリング相手）ごとに違う。NSEは共有Keychainに入っている鍵を順に試すので、
 * 保存名を `notifyKey.<pcId>` に分けておけば複数PCぶんを同時に持てる。
 * 単一PCしか扱えなかった頃の名前（`notifyKey`）は、最初のPCの鍵を保存し直したあとに掃除する。
 */
const LEGACY_NOTIFY_KEY_ACCOUNT = 'notifyKey';

function notifyKeyAccount(pcId: string): string {
	const suffix = pcId.replace(/[^A-Za-z0-9._-]/g, '_');
	return suffix.length > 0 ? `${LEGACY_NOTIFY_KEY_ACCOUNT}.${suffix}` : LEGACY_NOTIFY_KEY_ACCOUNT;
}

/**
 * 通知鍵（32バイトのhex）を、Notification Service Extension から読める共有Keychainへ保存する。
 * NSE はロック中にも起動するため AFTER_FIRST_UNLOCK を使う（初回ロック解除後は常に読める）。
 * シミュレータ等で accessGroup が使えない場合は失敗するが、プッシュ自体が使えない環境なので無視してよい。
 *
 * **保存できたかどうかを返す**。呼び出し側は、単一PC時代の鍵を消してよいかの判断にこれを使う
 * （失敗を握り潰して true 相当に扱うと、新しい鍵が入っていないのに古い鍵を消してしまい、
 * どの鍵でも復号できない＝プッシュ本文が固定文のままになる状態を作る）。
 */
export async function persistNotifyKey(pcId: string, hex: string): Promise<boolean> {
	try {
		await SecureStore.setItemAsync(notifyKeyAccount(pcId), hex, {
			keychainService: 'paracode.notify',
			accessGroup: NOTIFY_KEYCHAIN_ACCESS_GROUP,
			keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
		});
		return true;
	} catch (err) {
		console.warn('[platform] failed to persist notify key for NSE', err);
		return false;
	}
}

/**
 * 通知鍵を削除する。expo-secure-store は requireAuthentication の有無で
 * kSecAttrService に `:no-auth` を付けるため、NSE と同じく両方の service を掃除する
 * （片方だけ消すと、古い版が書いた項目が残って解除後も本文が復号できてしまう）。
 */
async function deleteNotifyKeyAccount(account: string): Promise<void> {
	for (const keychainService of ['paracode.notify', 'paracode.notify:no-auth']) {
		try {
			await SecureStore.deleteItemAsync(account, { keychainService, accessGroup: NOTIFY_KEYCHAIN_ACCESS_GROUP });
		} catch (err) {
			console.warn('[platform] failed to delete notify key', err);
		}
	}
}

/** ペアリング解除時にNSE用の共有復号鍵を削除し、そのPCの通知本文を復号できなくする。 */
export async function deleteNotifyKey(pcId: string): Promise<void> {
	await deleteNotifyKeyAccount(notifyKeyAccount(pcId));
}

/**
 * 単一PC時代の鍵（`notifyKey`）を消す。PCごとの鍵を保存し終えたあとに呼ぶ。
 * 残したままだと、そのPCとのペアリングを解除しても古い鍵で通知本文が読めてしまう。
 */
export async function deleteLegacyNotifyKey(): Promise<void> {
	await deleteNotifyKeyAccount(LEGACY_NOTIFY_KEY_ACCOUNT);
}

/** React Native の global WebSocket を使う SocketFactory。 */
export const rnSocketFactory: SocketFactory = (url: string, protocols?: string | string[]): SocketLike => {
	// RN の WebSocket は onopen/onmessage/onclose/onerror を持ち、SocketLike と互換。
	// binaryType は 'arraybuffer' を指定してバイナリを ArrayBuffer で受ける。
	// protocols は認証トークンを載せる Sec-WebSocket-Protocol サブプロトコル（finding #7）。
	const ws = new WebSocket(url, protocols);
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
export async function presentLocalNotification(title: string, subtitle: string | undefined, body: string, data: Record<string, unknown>): Promise<void> {
	await Notifications.scheduleNotificationAsync({
		content: { title, ...(subtitle !== undefined ? { subtitle } : {}), body, data },
		trigger: null, // 即時
	});
}
