// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';

/**
 * iPad の2列の右側（詳細の列＝ `app/pc/[pcId]/_layout.tsx` の中の Stack）の様子。
 *
 * 詳細の列の根（`app/pc/[pcId]/index.tsx`）が、自分が前面か（＝何も開いていないか）と、列を根まで戻す手段を
 * ここへ置く。左の列（PC の画面）はこれを見て「隠すボタンを出すか」を決め、行を押したときに
 * 「開いていたものを閉じてから新しいセッションを開く」（Orca と同じく、詳細の列は積み増さず入れ替える）。
 */
interface DetailColumnStore {
	/** 詳細の列を持っている PC（2列でないときは undefined）。 */
	readonly pcId: string | undefined;
	/** 詳細の列に何か開いているか（根の「エージェントが開かれていません」より上に画面があるか）。 */
	readonly open: boolean;
	/** 詳細の列を根まで戻す（何も開いていなければ何もしない）。 */
	readonly popToTop: (() => void) | undefined;
	attach(pcId: string, popToTop: () => void): () => void;
	setOpen(pcId: string, open: boolean): void;
}

export const useDetailColumn = create<DetailColumnStore>()((set, get) => ({
	pcId: undefined,
	open: false,
	popToTop: undefined,
	attach(pcId, popToTop) {
		set({ pcId, popToTop });
		return () => {
			if (get().popToTop === popToTop) {
				set({ pcId: undefined, popToTop: undefined, open: false });
			}
		};
	},
	setOpen(pcId, open) {
		if (get().pcId === pcId && get().open !== open) {
			set({ open });
		}
	},
}));

/**
 * 2列でその PC の詳細の列が出ているなら、開いているものを閉じて根へ戻す（このあと新しいセッションを積む）。
 * 1列（iPhone、狭い iPad）や別の PC なら何もしない（従来どおり押し進める）。
 */
export function resetDetailColumnFor(pcId: string): void {
	const { pcId: owner, popToTop } = useDetailColumn.getState();
	if (owner === pcId) {
		popToTop?.();
	}
}
