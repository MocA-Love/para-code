// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	KEYCHAIN_ACCESSIBLE_MARKER_KEY,
	type KeychainAccessible,
	type KeychainMigrationPort,
	isKeychainLockedError,
	migrateKeychainAccessibility,
} from './keychainAccessibility.js';

interface StoredItem {
	readonly value: string;
	readonly accessible: KeychainAccessible;
}

/**
 * Keychain の当該挙動だけを写したfake。書き込みが「消してから足す」であることが
 * 復旧経路の検証に効くので、`write` は既存項目を置き換える。
 */
class FakeKeychain implements KeychainMigrationPort {
	readonly items = new Map<string, StoredItem>();
	failWriteFor: string | undefined;
	readonly writes: string[] = [];

	constructor(initial: Record<string, StoredItem> = {}) {
		for (const [key, item] of Object.entries(initial)) {
			this.items.set(key, item);
		}
	}

	async read(key: string): Promise<string | null> {
		return this.items.get(key)?.value ?? null;
	}

	async write(key: string, value: string, accessible: KeychainAccessible): Promise<void> {
		this.writes.push(`${key}:${accessible}`);
		if (this.failWriteFor === key && accessible === 'afterFirstUnlock') {
			throw new Error('keychain write failed');
		}
		this.items.set(key, { value, accessible });
	}

	async remove(key: string): Promise<void> {
		this.items.delete(key);
	}
}

describe('migrateKeychainAccessibility', () => {
	it('rebuilds startup items so they are readable while locked, then marks it done', async () => {
		const keychain = new FakeKeychain({
			'para.identity': { value: 'id', accessible: 'whenUnlocked' },
			'para.credentials': { value: 'creds', accessible: 'whenUnlocked' },
		});

		const result = await migrateKeychainAccessibility(keychain, ['para.identity', 'para.credentials', 'para.operationRun']);

		expect(result).toBe('migrated');
		expect([...keychain.items].map(([key, item]) => [key, item.value, item.accessible])).toEqual([
			['para.identity', 'id', 'afterFirstUnlock'],
			['para.credentials', 'creds', 'afterFirstUnlock'],
			[KEYCHAIN_ACCESSIBLE_MARKER_KEY, '1', 'afterFirstUnlock'],
		]);
	});

	it('does nothing once the marker is present', async () => {
		const keychain = new FakeKeychain({
			[KEYCHAIN_ACCESSIBLE_MARKER_KEY]: { value: '1', accessible: 'afterFirstUnlock' },
			'para.identity': { value: 'id', accessible: 'whenUnlocked' },
		});

		const result = await migrateKeychainAccessibility(keychain, ['para.identity']);

		expect(result).toBe('already-migrated');
		expect(keychain.writes).toEqual([]);
	});

	it('restores the value and leaves the marker unset when the rewrite fails', async () => {
		// 消してから書けないと項目ごと失われる。手元の値を書き戻し、番人を立てずに次回やり直す。
		const keychain = new FakeKeychain({ 'para.credentials': { value: 'creds', accessible: 'whenUnlocked' } });
		keychain.failWriteFor = 'para.credentials';

		await expect(migrateKeychainAccessibility(keychain, ['para.credentials'])).rejects.toThrow('keychain write failed');

		expect(keychain.items.get('para.credentials')).toEqual({ value: 'creds', accessible: 'whenUnlocked' });
		expect(keychain.items.has(KEYCHAIN_ACCESSIBLE_MARKER_KEY)).toBe(false);
	});
});

describe('isKeychainLockedError', () => {
	it('recognises the locked-device failure through the cause chain', () => {
		// 実地(Sentry PARA-CODE-MOBILE-2)で届いた形。
		const reported = new Error("Calling the 'getValueWithKeyAsync' function has failed", {
			cause: new Error('User interaction is not allowed.'),
		});

		expect(isKeychainLockedError(reported)).toBe(true);
		expect(isKeychainLockedError(new Error('errSecInteractionNotAllowed'))).toBe(true);
		expect(isKeychainLockedError(new Error('some other keychain failure'))).toBe(false);
		expect(isKeychainLockedError(undefined)).toBe(false);
	});

	it('does not spin on a self-referencing cause chain', () => {
		const looped = new Error('outer') as Error & { cause?: unknown };
		looped.cause = looped;

		expect(isKeychainLockedError(looped)).toBe(false);
	});
});
