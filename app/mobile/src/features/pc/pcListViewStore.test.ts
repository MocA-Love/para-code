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
		store.setFilter('pc1', { states: ['waiting'], spaces: ['w1'] });
		store.setSearching('pc1', true);
		store.setQuery('pc1', 'fix');
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
		store.setQuery('pc1', 'a');
		store.setQuery('pc1', 'ab');
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

	test('検索は PC の画面を離れたら消え、同じ PC の画面が残っている間は消えない', async () => {
		const { ensurePcListViewLoaded, usePcListView } = await loadStore();
		ensurePcListViewLoaded();
		await flush();
		release();
		await flush();
		const store = usePcListView.getState();
		const releaseFirst = store.holdPc('pc1');
		const releaseOther = store.holdPc('pc2');
		store.setSearching('pc1', true);
		store.setQuery('pc1', 'relay');
		store.setSearching('pc2', true);
		store.setQuery('pc2', 'docs');
		store.setFilter('pc1', { states: ['waiting'], spaces: [] });
		// 同じ PC の画面がもう1枚積まれて、上だけを閉じた（2列 ⇄ 1列の作り直しも器は外れないので同じく残る）。
		const releaseSecond = store.holdPc('pc1');
		releaseSecond();
		expect(usePcListView.getState().transient.pc1).toEqual({ query: 'relay', searching: true });
		// 最後の画面を閉じた。二重に手放しても数えすぎない。
		releaseFirst();
		releaseFirst();
		expect(usePcListView.getState().transient).toEqual({ pc2: { query: 'docs', searching: true } });
		// 保存する絞り込みは残る。
		expect(usePcListView.getState().saved.byPc.pc1?.states).toEqual(['waiting']);
		releaseOther();
		expect(usePcListView.getState().transient).toEqual({});
	});

	test('ペアリングを解除した PC の分を消す', async () => {
		const { ensurePcListViewLoaded, usePcListView } = await loadStore();
		ensurePcListViewLoaded();
		await flush();
		release();
		await flush();
		const store = usePcListView.getState();
		store.setFilter('pc1', { states: ['working'], spaces: [] });
		store.setQuery('pc1', 'x');
		store.forgetPc('pc1');
		expect({ saved: usePcListView.getState().saved, transient: usePcListView.getState().transient }).toEqual({ saved: { group: 'space', byPc: {} }, transient: {} });
	});
});
