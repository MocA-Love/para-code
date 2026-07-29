// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Keychain のアクセシビリティ（いつ読めるか）の扱い。
 *
 * ペアリング情報と長期鍵は当初 `WHEN_UNLOCKED_THIS_DEVICE_ONLY` で保存していた。しかしアプリは
 * サイレント通知やバックグラウンド更新で**端末がロックされたまま起こされる**ことがあり、その
 * 起動では読み出しが `errSecInteractionNotAllowed`（"User interaction is not allowed."）で失敗して
 * 接続できない（Sentry: PARA-CODE-MOBILE-2）。NSE と共有する通知鍵が既にそうしているのと同じく、
 * 「初回ロック解除後は常に読める」水準へ揃える。
 *
 * このファイルは判断とアルゴリズムだけを持ち、expo-secure-store には触らない（テストのため）。
 */

/** 保存時に指定するアクセシビリティ。expo-secure-store の定数へは platform.ts で対応付ける。 */
export type KeychainAccessible = 'afterFirstUnlock' | 'whenUnlocked';

/** Keychain への最小の入出力。platform.ts が expo-secure-store で実装する。 */
export interface KeychainMigrationPort {
	read(key: string): Promise<string | null>;
	write(key: string, value: string, accessible: KeychainAccessible): Promise<void>;
	remove(key: string): Promise<void>;
}

/**
 * 移行済みを示す番人。これ自体も移行後のアクセシビリティで書くので、ロック中でも読める。
 * 値には意味を持たせない（存在するかどうかだけを見る）。
 */
export const KEYCHAIN_ACCESSIBLE_MARKER_KEY = 'para.keychainAccessible.v2';

/**
 * 起動をブロックする項目だけを移行する。
 *
 * ここに無い項目（表示設定など）は読めなくても個別に握り潰されて既定値で続行するので、
 * 後述の作り直しに伴うリスクを負ってまで移行しない。**新しく書かれる項目は移行の対象外でも
 * 最初から移行後のアクセシビリティになる**（platform.ts の既定値を変えてあるため）。
 */
export const KEYCHAIN_STARTUP_KEYS: readonly string[] = ['para.identity', 'para.credentials', 'para.operationRun'];

/**
 * ロック中で読めなかったことを表す失敗。
 *
 * **これを `null` に潰してはいけない。** `loadOrCreateIdentity()` は `null` を「まだ鍵が無い」と
 * 解釈して新しい鍵を生成し、既存のペアリングを黙って捨てる。「読めなかった」と「保存されていない」
 * は必ず区別する。
 */
export class KeychainLockedError extends Error {
	constructor(key: string, override readonly cause: unknown) {
		super(`Keychain item '${key}' is not readable while the device is locked`);
		this.name = 'KeychainLockedError';
	}
}

/** iOS の errSecInteractionNotAllowed（-25308）由来かを、メッセージ連鎖から判定する。 */
export function isKeychainLockedError(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		const message = current instanceof Error ? current.message : typeof current === 'string' ? current : '';
		if (/interaction is not allowed|-25308|errSecInteractionNotAllowed/i.test(message)) {
			return true;
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}

/**
 * 既存の Keychain 項目を、ロック中でも読めるアクセシビリティで作り直す。
 *
 * `setItemAsync` で上書きしてもアクセシビリティは変わらない: expo-secure-store の iOS 実装は
 * `SecItemAdd` が `errSecDuplicateItem` を返すと `SecItemUpdate` で `kSecValueData` だけを
 * 差し替えるため、`kSecAttrAccessible` は最初に書いたときのまま残る。よって一度消して書き直す
 * しかない。消してから書けなかった場合は、手元にある値を元のアクセシビリティで書き戻して原状へ
 * 復帰させ、番人を立てずに次回起動でやり直す。
 */
export async function migrateKeychainAccessibility(
	port: KeychainMigrationPort,
	keys: readonly string[] = KEYCHAIN_STARTUP_KEYS,
	markerKey: string = KEYCHAIN_ACCESSIBLE_MARKER_KEY,
): Promise<'already-migrated' | 'migrated'> {
	if (await port.read(markerKey) !== null) {
		return 'already-migrated';
	}
	for (const key of keys) {
		const value = await port.read(key);
		if (value === null) {
			continue;
		}
		await port.remove(key);
		try {
			await port.write(key, value, 'afterFirstUnlock');
		} catch (error) {
			await port.write(key, value, 'whenUnlocked');
			throw error;
		}
	}
	await port.write(markerKey, '1', 'afterFirstUnlock');
	return 'migrated';
}
