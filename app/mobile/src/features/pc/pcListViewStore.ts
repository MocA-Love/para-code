// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { secureKeyStore } from '../../platform.js';
import type { PcListFilter, PcListGroup } from './pcList.js';
import {
	DEFAULT_PC_LIST_VIEW,
	parsePcListView,
	pcListViewOf,
	sameItems,
	toggleCollapsedKey,
	withPcListView,
	withoutPc,
	type PcListViewSaved,
} from './pcListView.js';

/**
 * PC の画面の一覧の表示条件を、画面（`PcScreen`）の外に持つストア。
 *
 * 画面の外に置く理由は2つ。アプリを終了しても残すため（`saved` を secureKeyStore に JSON で保存）と、
 * iPad の2列 ⇄ 1列の切り替えで `PcScreen` が作り直されても、検索語・畳んだ段・絞り込みを失わないため
 * （`transient` はメモリにだけ置く）。何を残し何を残さないかは `pcListView.ts` の冒頭。
 *
 * 読み込みは最初に使われたときに1回だけ（`sessionViewStore.ts` と同じ）。読み込みの前に
 * 変えられた場合は、読み込んだ値にその変更を重ねて保存し直す。
 */

const STORAGE_KEY = 'pcListView';

type Edit = (saved: PcListViewSaved) => PcListViewSaved;

/** アプリを終了したら消える、PC ごとのその場の状態。 */
export interface PcListTransient {
	readonly query: string;
	readonly searching: boolean;
}

export const EMPTY_PC_LIST_TRANSIENT: PcListTransient = { query: '', searching: false };

interface PcListViewStore {
	readonly saved: PcListViewSaved;
	readonly loaded: boolean;
	readonly transient: Readonly<Record<string, PcListTransient>>;
	setGroup(group: PcListGroup): void;
	/** 絞り込みを変える。状態とスペースは保存し、検索語はメモリにだけ置く。 */
	setFilter(pcId: string, filter: PcListFilter): void;
	/** 検索欄を開く／閉じる。閉じるときは検索語も消す。 */
	setSearching(pcId: string, searching: boolean): void;
	toggleSection(pcId: string, key: string): void;
	/** ペアリングを解除した PC の分を消す。 */
	forgetPc(pcId: string): void;
}

let pendingEdits: Edit[] = [];
let loadStarted = false;

function save(saved: PcListViewSaved): void {
	secureKeyStore.setItem(STORAGE_KEY, JSON.stringify(saved)).catch((err: unknown) => {
		console.warn('[pcListView] failed to save', err);
	});
}

export const usePcListView = create<PcListViewStore>()((set, get) => {
	const apply = (edit: Edit) => {
		const before = get().saved;
		const next = edit(before);
		if (next === before) {
			return;
		}
		set({ saved: next });
		if (get().loaded) {
			save(next);
		} else {
			pendingEdits.push(edit);
		}
	};
	const setTransient = (pcId: string, edit: (current: PcListTransient) => PcListTransient) => {
		const current = get().transient[pcId] ?? EMPTY_PC_LIST_TRANSIENT;
		set({ transient: { ...get().transient, [pcId]: edit(current) } });
	};
	return {
		saved: DEFAULT_PC_LIST_VIEW,
		loaded: false,
		transient: {},
		setGroup(group) {
			if (get().saved.group === group) {
				return;
			}
			apply(saved => ({ ...saved, group }));
		},
		setFilter(pcId, filter) {
			// 検索語だけが変わったときは保存しない（1文字ごとに Keychain へ書かない）。
			const view = pcListViewOf(get().saved, pcId);
			if (!sameItems(view.states, filter.states) || !sameItems(view.spaces, filter.spaces)) {
				apply(saved => withPcListView(saved, pcId, current => ({ ...current, states: filter.states, spaces: filter.spaces })));
			}
			if ((get().transient[pcId]?.query ?? '') !== filter.query) {
				setTransient(pcId, current => ({ ...current, query: filter.query }));
			}
		},
		setSearching(pcId, searching) {
			setTransient(pcId, current => ({ query: searching ? current.query : '', searching }));
		},
		toggleSection(pcId, key) {
			apply(saved => withPcListView(saved, pcId, view => ({ ...view, collapsed: toggleCollapsedKey(view.collapsed, key) })));
		},
		forgetPc(pcId) {
			apply(saved => withoutPc(saved, pcId));
			if (get().transient[pcId] !== undefined) {
				const transient = { ...get().transient };
				delete transient[pcId];
				set({ transient });
			}
		},
	};
});

/** 保存値を1回だけ読み込む。何度呼んでもよい。 */
export function ensurePcListViewLoaded(): void {
	if (loadStarted) {
		return;
	}
	loadStarted = true;
	secureKeyStore.getItem(STORAGE_KEY)
		.then(raw => {
			try {
				return parsePcListView(raw !== null ? JSON.parse(raw) as unknown : undefined);
			} catch {
				return DEFAULT_PC_LIST_VIEW;
			}
		})
		.catch((err: unknown): PcListViewSaved => {
			console.warn('[pcListView] failed to load', err);
			return DEFAULT_PC_LIST_VIEW;
		})
		.then(stored => {
			const edits = pendingEdits;
			pendingEdits = [];
			const next = edits.reduce((saved, edit) => edit(saved), stored);
			usePcListView.setState({ saved: next, loaded: true });
			if (edits.length > 0) {
				save(next);
			}
		});
}
