// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext, useContext } from 'react';
import { create } from 'zustand';

/**
 * iPad の2列の右側（詳細の列＝ `app/pc/[pcId]/_layout.tsx` の中の Stack）の様子。
 *
 * 詳細の列の根（`app/pc/[pcId]/index.tsx`）が、自分の列に何か開いているかと、列を根まで戻す手段を
 * ここへ置く。左の列（PC の画面）はこれを見て「隠すボタンを出すか」を決め、行を押したときに
 * 「開いていたものを閉じてから新しいセッションを開く」（Orca と同じく、詳細の列は積み増さず入れ替える）。
 *
 * **PC の画面は2枚以上積まれることがある**（通知のタップで別の PC のセッションへ入る、通知の一覧から
 * 入り直す、など）。そのため詳細の列は器（`_layout.tsx`）ごとに1件ずつ持ち、最後の1件を前面とみなす。
 * 置いた順だけでは決めない: 器が作り直されずに前面へ戻る場合（Expo Router の singular による並べ替えなど。
 * いまの器の Stack では起こさないようにしている。`app/pc/_layout.tsx`）には根の attach が走り直さないので、
 * 器は前面に来るたびに `bringToFront` で自分を末尾へ移す。
 * 上の画面が外れると1つ前が前面に戻る（中身の「開いているか」は各自が持ち続けるので、下の画面は積まれる前の
 * 状態のまま戻る）。
 */
export interface DetailColumnEntry {
	/** 器（`_layout.tsx`）ごとの印。器と根・セッションの画面は `DetailColumnKeyContext` で同じ値を共有する。 */
	readonly key: string;
	readonly pcId: string;
	/** 詳細の列に何か開いているか（根の「エージェントが開かれていません」より上に画面があるか）。 */
	readonly open: boolean;
	/** 詳細の列を根まで戻す（何も開いていなければ何もしない）。 */
	readonly popToTop: () => void;
}

interface DetailColumnStore {
	/** 最後が前面。2列でないときは空。 */
	readonly entries: readonly DetailColumnEntry[];
	/** 詳細の列を置く（前面に置く）。戻り値で外す。 */
	attach(key: string, pcId: string, popToTop: () => void): () => void;
	/** その器が前面に来た（無ければ何もしない）。 */
	bringToFront(key: string): void;
	setOpen(key: string, open: boolean): void;
}

export const useDetailColumn = create<DetailColumnStore>()((set, get) => ({
	entries: [],
	attach(key, pcId, popToTop) {
		const entry: DetailColumnEntry = { key, pcId, open: false, popToTop };
		set(state => ({ entries: [...state.entries.filter(item => item.key !== key), entry] }));
		return () => {
			// 同じ印で置き直された後なら、新しい方は外さない。
			if (get().entries.some(item => item.key === key && item.popToTop === popToTop)) {
				set(state => ({ entries: state.entries.filter(item => item.key !== key) }));
			}
		};
	},
	bringToFront(key) {
		const entries = get().entries;
		const entry = entries.find(item => item.key === key);
		if (entry !== undefined && entries[entries.length - 1] !== entry) {
			set({ entries: [...entries.filter(item => item !== entry), entry] });
		}
	},
	setOpen(key, open) {
		const current = get().entries.find(item => item.key === key);
		if (current !== undefined && current.open !== open) {
			set(state => ({ entries: state.entries.map(item => (item.key === key ? { ...item, open } : item)) }));
		}
	},
}));

/** 器（`_layout.tsx`）が配下の根・セッションの画面へ渡す、自分の詳細の列の印。 */
export const DetailColumnKeyContext = createContext<string | undefined>(undefined);

/** いまいる器の詳細の列の印（器の外では undefined）。 */
export function useDetailColumnKey(): string | undefined {
	return useContext(DetailColumnKeyContext);
}

/** その器の詳細の列に何か開いているか（2列でない・器の外なら false）。 */
export function useDetailColumnOpen(key: string | undefined): boolean {
	return useDetailColumn(s => key !== undefined && s.entries.some(item => item.key === key && item.open));
}

/**
 * 2列で前面の詳細の列がその PC のものなら、開いているものを閉じて根へ戻す（このあと新しいセッションを積む）。
 * 1列（iPhone、狭い iPad）や、前面が別の PC なら何もしない（従来どおり押し進める）。
 */
export function resetDetailColumnFor(pcId: string): void {
	const entries = useDetailColumn.getState().entries;
	const front = entries[entries.length - 1];
	if (front !== undefined && front.pcId === pcId) {
		front.popToTop();
	}
}
