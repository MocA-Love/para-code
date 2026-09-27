// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { beforeEach, describe, expect, test, vi } from 'vitest';

const storage = new Map<string, string>();
const setItem = vi.fn(async (key: string, value: string) => { storage.set(key, value); });
let release: () => void = () => { };

vi.mock('../../platform.js', () => ({
	secureKeyStore: {
		getItem: async (key: string) => {
			// 読み込みの途中で画面が値を変える場合を再現するため、`release()` まで返さない。
			await new Promise<void>(resolve => { release = resolve; });
			return storage.get(key) ?? null;
		},
		setItem: (key: string, value: string) => setItem(key, value),
		deleteItem: async (key: string) => { storage.delete(key); },
	},
}));

async function loadStore() {
	vi.resetModules();
	const module = await import('./pcListViewStore.js');
	return module;
}

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

describe('PC の画面の表示条件のストア', () => {
	beforeEach(() => {
		storage.clear();
		setItem.mockClear();
	});

	test('保存した条件を次の起動で読み戻し、検索語は残さない', async () => {
		const first = await loadStore();
		first.ensurePcListViewLoaded();
		await flush();
		release();
		await flush();
		const store = first.usePcListView.getState();
		store.setGroup('state');
		store.setFilter('pc1', { states: ['waiting'], spaces: ['w1'], query: 'fix' });
		store.setSearching('pc1', true);
		store.toggleSection('pc1', 'space:w2');

		const second = await loadStore();
		second.ensurePcListViewLoaded();
		await flush();
		release();
		await flush();
		const { saved, transient, loaded } = second.usePcListView.getState();
		expect({ saved, transient, loaded }).toEqual({
			saved: { group: 'state', byPc: { pc1: { states: ['waiting'], spaces: ['w1'], collapsed: ['space:w2'] } } },
			transient: {},
			loaded: true,
		});
	});

	test('検索語だけの変更は保存しない。検索欄を閉じると検索語も消える', async () => {
		const { ensurePcListViewLoaded, usePcListView } = await loadStore();
		ensurePcListViewLoaded();
		await flush();
		release();
		await flush();
		const store = usePcListView.getState();
		store.setSearching('pc1', true);
		store.setFilter('pc1', { states: [], spaces: [], query: 'a' });
		store.setFilter('pc1', { states: [], spaces: [], query: 'ab' });
		expect(setItem).not.toHaveBeenCalled();
		expect(usePcListView.getState().transient.pc1).toEqual({ query: 'ab', searching: true });
		store.setSearching('pc1', false);
		expect(usePcListView.getState().transient.pc1).toEqual({ query: '', searching: false });
	});

	test('読み込みの前に変えた分は、読み込んだ値に重ねて保存し直す', async () => {
		storage.set('pcListView', JSON.stringify({ group: 'none', byPc: { pc2: { states: ['idle'], spaces: [], collapsed: [] } } }));
		const { ensurePcListViewLoaded, usePcListView } = await loadStore();
		ensurePcListViewLoaded();
		await flush();
		usePcListView.getState().toggleSection('pc1', 'pinned');
		expect(setItem).not.toHaveBeenCalled();
		release();
		await flush();
		const expected = { group: 'none', byPc: { pc2: { states: ['idle'], spaces: [], collapsed: [] }, pc1: { states: [], spaces: [], collapsed: ['pinned'] } } };
		expect(usePcListView.getState().saved).toEqual(expected);
		expect(JSON.parse(storage.get('pcListView') ?? 'null')).toEqual(expected);
	});

	test('ペアリングを解除した PC の分を消す', async () => {
		const { ensurePcListViewLoaded, usePcListView } = await loadStore();
		ensurePcListViewLoaded();
		await flush();
		release();
		await flush();
		const store = usePcListView.getState();
		store.setFilter('pc1', { states: ['working'], spaces: [], query: 'x' });
		store.forgetPc('pc1');
		expect({ saved: usePcListView.getState().saved, transient: usePcListView.getState().transient }).toEqual({ saved: { group: 'space', byPc: {} }, transient: {} });
	});
});
