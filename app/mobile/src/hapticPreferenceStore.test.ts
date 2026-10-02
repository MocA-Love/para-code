// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { HAPTICS_ENABLED_KEY, createHapticPreferenceStore, type HapticPreferenceStorage } from './hapticPreferenceStore.js';

/** 読み書きの完了を手で進められる保存先。 */
function manualStorage(initial: string | null) {
	const values = new Map<string, string>(initial === null ? [] : [[HAPTICS_ENABLED_KEY, initial]]);
	const pendingReads: (() => void)[] = [];
	let failWrites = false;
	const storage: HapticPreferenceStorage = {
		getItem: key => new Promise(resolve => {
			const snapshot = values.get(key) ?? null;
			pendingReads.push(() => resolve(snapshot));
		}),
		setItem: async (key, value) => {
			if (failWrites) {
				throw new Error('locked');
			}
			values.set(key, value);
		},
	};
	return {
		storage,
		values,
		finishReads: () => pendingReads.splice(0).forEach(finish => finish()),
		failWrites: (fail: boolean) => { failWrites = fail; },
	};
}

describe('createHapticPreferenceStore', () => {
	it('loads the stored value and defaults to on', async () => {
		const off = manualStorage('0');
		const unset = manualStorage(null);
		const offStore = createHapticPreferenceStore(off.storage);
		const unsetStore = createHapticPreferenceStore(unset.storage);
		const loading = [offStore.getState().load(), unsetStore.getState().load()];
		off.finishReads();
		unset.finishReads();
		await Promise.all(loading);
		expect([offStore.getState().enabled, unsetStore.getState().enabled]).toEqual([false, true]);
	});

	it('keeps a switch made while the stored value was still loading', async () => {
		const fake = manualStorage('1');
		const store = createHapticPreferenceStore(fake.storage);
		const loading = store.getState().load();
		await store.getState().setEnabled(false);
		fake.finishReads();
		await loading;
		expect({ enabled: store.getState().enabled, stored: fake.values.get(HAPTICS_ENABLED_KEY) }).toEqual({ enabled: false, stored: '0' });
	});

	it('rolls back a failed save only when nothing changed after it', async () => {
		const fake = manualStorage('1');
		const store = createHapticPreferenceStore(fake.storage);
		fake.failWrites(true);
		const failed = store.getState().setEnabled(false).catch(() => 'rejected');
		expect([await failed, store.getState().enabled]).toEqual(['rejected', true]);
	});
});
