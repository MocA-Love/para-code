// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';

/**
 * ファイルタブの検索条件。
 *
 * 検索欄は**ヘッダーの帯**（常設のヘッダー層）に、結果の一覧は**本文**にある。2つは別の
 * ツリーに描かれるので、条件はここで持って両方から読む。以前は欄も一覧も `FilesPanel` の
 * 中にあり、欄が本文の先頭に居たため「下まで読むと欄が画面外に居る」「開閉にアニメーションが
 * 無い」という2つの問題があった。
 *
 * **帯に置いたものは「ユーザーが閉じたとき」以外にもアンマウントされる**（別のタブへ移ると
 * その画面が自分の仕様を層へ登録するため）。だから欄の後始末を欄のアンマウントに紐づけては
 * いけない——タブを行き来しただけで入力が消える。条件を捨てるのは {@link FilesSearchStore.close}
 * だけが行い、フォーカスも {@link FilesSearchStore.open} が要求したときだけ当てる。
 *
 * **開いているかどうかもここが持つ**（画面のローカルstateにしない）。ヘッダーの帯は常設の
 * ヘッダー層が描くので、開閉を画面のstateに置くと「画面が変わる描画」と「ヘッダーが変わる
 * 描画」が2回に分かれ、`LayoutAnimation` の予約が前者に食われてアニメーションが消える
 * （予約は中身に関係なく次の1描画に消費される）。ここへ置けば画面と層が同じ描画で変わる。
 */

/** 何を探すか。`name` は相対パスの部分一致、`text` は全文（PC側 ripgrep）。 */
export type FilesSearchMode = 'name' | 'text';

interface FilesSearchStore {
	/** 検索欄（ヘッダーの帯）が出ているか。 */
	readonly visible: boolean;
	readonly query: string;
	readonly mode: FilesSearchMode;
	/** 欄へフォーカスを当てる要求。欄が1回だけ消費する。 */
	readonly focusRequested: boolean;
	/**
	 * 入力欄の中身を消した回数。欄は uncontrolled（`defaultValue`）なので、外から
	 * `query` を空にしても表示中の文字は消えない。この数が増えたら欄が自分で `clear()` する。
	 */
	readonly clearedAt: number;
	setQuery(query: string): void;
	setMode(mode: FilesSearchMode): void;
	/** ユーザーが検索を開いた。条件を白紙にしてフォーカスを要求する。 */
	open(): void;
	/** ユーザーが検索を閉じた（✕・虫めがねの再タップ）。条件を捨てる。 */
	close(): void;
	/** 虫めがねのタップ。**必ずアニメーションの予約と同じ関数の中で呼ぶこと。** */
	toggle(): void;
	/** 文脈が変わったので条件だけ捨てる（ワークスペース切り替え・ディレクトリ移動）。 */
	clear(): void;
	consumeFocus(): void;
}

export const useFilesSearch = create<FilesSearchStore>()((set, get) => ({
	visible: false,
	query: '',
	mode: 'name',
	focusRequested: false,
	clearedAt: 0,
	setQuery(query) {
		set({ query });
	},
	setMode(mode) {
		set(state => (state.mode === mode ? state : { mode }));
	},
	open() {
		set(state => ({ visible: true, query: '', focusRequested: true, clearedAt: state.clearedAt + 1 }));
	},
	close() {
		get().clear();
		set({ visible: false, focusRequested: false });
	},
	toggle() {
		if (get().visible) {
			get().close();
			return;
		}
		get().open();
	},
	clear() {
		set(state => (state.query === '' ? state : { query: '', clearedAt: state.clearedAt + 1 }));
	},
	consumeFocus() {
		set(state => (state.focusRequested ? { focusRequested: false } : state));
	},
}));

/**
 * 一致した範囲を切り出す。**PC側と同じ規則にする**——ずれると「色が付かない一致」や
 * 「色が付いた非一致」が出て、ハイライトが嘘になる。
 *
 * `smartCase` は全文検索のときだけ true にする。PC側は
 *  - ファイル名検索: `query.toLowerCase()` を `path.toLowerCase()` に当てる＝**常に大小無視**
 *  - 全文検索: ripgrep の `--smart-case`＝クエリに大文字があるときだけ区別
 * という非対称になっている（`paradisMobileSearch.ts`）。
 */
export function matchRanges(text: string, query: string, smartCase: boolean): readonly { readonly start: number; readonly end: number }[] {
	const needle = query.trim();
	if (needle.length === 0) {
		return [];
	}
	const caseInsensitive = !smartCase || needle === needle.toLowerCase();
	const haystack = caseInsensitive ? text.toLowerCase() : text;
	const target = caseInsensitive ? needle.toLowerCase() : needle;
	const ranges: { start: number; end: number }[] = [];
	let from = 0;
	// 上限を置くのは、極端に短いクエリ（1文字）が長い行に大量に当たったときに
	// <Text> の子を数百個作らないため。溢れたぶんは色が付かないだけで実害は無い。
	while (ranges.length < 40) {
		const at = haystack.indexOf(target, from);
		if (at < 0) {
			break;
		}
		ranges.push({ start: at, end: at + target.length });
		from = at + target.length;
	}
	return ranges;
}
