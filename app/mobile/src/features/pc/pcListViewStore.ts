// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { secureKeyStore } from '../../platform.js';
import type { PcListFilter, PcListGroup } from './pcList.js';
import {
	DEFAULT_PC_LIST_VIEW,
	parsePcListView,
	pcListViewOf,
	sameItems,
	withCollapsedKey,
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

/**
 * PC ごとのその場の状態（保存しない）。iPad の2列 ⇄ 1列で `PcScreen` が作り直されても残し、
 * PC の画面から離れたら（器 `app/pc/[pcId]/_layout.tsx` が外れたら）消す（`holdPc`）。
 */
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
	/** 絞り込み（状態とスペース）を変えて保存する。検索語は `setQuery`。 */
	setFilter(pcId: string, filter: Pick<PcListFilter, 'states' | 'spaces'>): void;
	/** 検索語を変える（メモリにだけ置く。1文字ごとに Keychain へ書かない）。 */
	setQuery(pcId: string, query: string): void;
	/** 検索欄を開く／閉じる。閉じるときは検索語も消す。 */
	setSearching(pcId: string, searching: boolean): void;
	toggleSection(pcId: string, key: string): void;
	/**
	 * PC の画面を開いている間持つ。返した関数で手放し、その PC を持つ画面が1つも無くなったら
	 * 検索の状態を消す（同じ PC の画面が2枚積まれていても、上を閉じただけでは下の検索を消さない）。
	 */
	holdPc(pcId: string): () => void;
	/** ペアリングを解除した PC の分を消す。 */
	forgetPc(pcId: string): void;
}

/** PC ごとの、いま開いている画面の数（`holdPc`）。 */
const holders = new Map<string, number>();

let pendingEdits: Edit[] = [];
let loadStarted = false;
/**
 * 保存値を読めたか。読めていない間（Keychain がまだ開いていない起動直後など）は、変更を保存せずに
 * 積んでおき、次の変更のときに読み直す。読めないまま既定値で保存すると、保存済みの条件を上書きしてしまう。
 */
let persistReady = false;
/** 読み込みに失敗した後、変更が無くても読み直すまでの間（Keychain が開くのを待つ）。 */
export const PC_LIST_VIEW_LOAD_RETRY_MS = 30_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

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
		if (persistReady) {
			save(next);
		} else {
			pendingEdits.push(edit);
			// 前の読み込みが失敗していれば読み直す（読めたら積んだ変更を重ねて保存する）。
			ensurePcListViewLoaded();
		}
	};
	const setTransient = (pcId: string, edit: (current: PcListTransient) => PcListTransient) => {
		const current = get().transient[pcId] ?? EMPTY_PC_LIST_TRANSIENT;
		set({ transient: { ...get().transient, [pcId]: edit(current) } });
	};
	const dropTransient = (pcId: string) => {
		if (get().transient[pcId] !== undefined) {
			const transient = { ...get().transient };
			delete transient[pcId];
			set({ transient });
		}
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
			const view = pcListViewOf(get().saved, pcId);
			if (!sameItems(view.states, filter.states) || !sameItems(view.spaces, filter.spaces)) {
				apply(saved => withPcListView(saved, pcId, current => ({ ...current, states: filter.states, spaces: filter.spaces })));
			}
		},
		setQuery(pcId, query) {
			if ((get().transient[pcId]?.query ?? '') !== query) {
				setTransient(pcId, current => ({ ...current, query }));
			}
		},
		setSearching(pcId, searching) {
			setTransient(pcId, current => ({ query: searching ? current.query : '', searching }));
		},
		toggleSection(pcId, key) {
			// 切り替えた後の状態（畳む・開く）を変更として持つ。「切り替える」のまま積むと、読み込みの前に押した分を
			// 読み込んだ値へ重ねたときに、見えていたのと逆になることがある。
			const collapse = !pcListViewOf(get().saved, pcId).collapsed.includes(key);
			apply(saved => withPcListView(saved, pcId, view => ({ ...view, collapsed: withCollapsedKey(view.collapsed, key, collapse) })));
		},
		holdPc(pcId) {
			holders.set(pcId, (holders.get(pcId) ?? 0) + 1);
			let released = false;
			return () => {
				if (released) {
					return;
				}
				released = true;
				const left = (holders.get(pcId) ?? 1) - 1;
				if (left > 0) {
					holders.set(pcId, left);
					return;
				}
				holders.delete(pcId);
				dropTransient(pcId);
			};
		},
		forgetPc(pcId) {
			apply(saved => withoutPc(saved, pcId));
			dropTransient(pcId);
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
		.then(stored => {
			persistReady = true;
			const edits = pendingEdits;
			pendingEdits = [];
			const next = edits.reduce((saved, edit) => edit(saved), stored);
			usePcListView.setState({ saved: next, loaded: true });
			if (edits.length > 0) {
				save(next);
			}
		}, (err: unknown) => {
			// 読めなかった: 画面は既定値のまま進める（loaded）が、保存はしない。次の変更か、少し待ってから読み直す。
			console.warn('[pcListView] failed to load', err);
			loadStarted = false;
			usePcListView.setState({ loaded: true });
			if (retryTimer === undefined) {
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					ensurePcListViewLoaded();
				}, PC_LIST_VIEW_LOAD_RETRY_MS);
			}
		});
}
