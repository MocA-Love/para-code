// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { observeWindowControlsInset } from '../../modules/para-ipad-input/index.js';
import { isTablet } from '../hooks/useSizeClass.js';

/**
 * iPadOS のウィンドウ操作ボタン（ウィンドウアプリのときに左上へ出る閉じる・最小化・並べるの3点）を
 * 見出しが避けるための余白。
 *
 * OS 標準のナビゲーションバーならボタンを自動で避けるが、このアプリの見出しは自前の帯なので自分で避ける。
 * 余白の値はネイティブ（`modules/para-ipad-input` の `ParaWindowControlsObserver`。
 * `UIView.edgeInsets(for: .safeArea(cornerAdaptation: .horizontal))` と素のセーフエリアの差）が測り、
 * ウィンドウの大きさ・全画面 ⇄ ウィンドウ・ボタンの出方が変わるたびに知らせてくる。全画面・iPhone では 0。
 *
 * **見出しは `useWindowControlsInset()` だけを使う。画面ごとに計算しない。** 左上の隅に来ない部分木
 * （2列の詳細の列など）は `WindowLeadingEdge` で `false` を渡しておくと、その中では 0 になる。
 */

let leadingInset = 0;
const listeners = new Set<() => void>();
let started = false;

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (!started && isTablet) {
		// アプリの寿命のあいだ見張り続ける（見出しは画面ごとに付け外しされるが、値は1つなので）。
		started = true;
		observeWindowControlsInset(inset => {
			const next = Math.max(0, Math.round(inset.leading));
			if (next !== leadingInset) {
				leadingInset = next;
				for (const notify of listeners) {
					notify();
				}
			}
		});
	}
	return () => listeners.delete(listener);
}

function snapshot(): number {
	return leadingInset;
}

/** この部分木の左端がウィンドウの左端に接しているか（既定は接している）。 */
const LeadingEdgeContext = createContext(true);

/**
 * 部分木がウィンドウの左端に接しているかを伝える。2列の詳細の列は、左の列が出ている間は `false`
 * （左上の隅には左の列の見出しが来る）。
 */
export function WindowLeadingEdge({ value, children }: { value: boolean; children: ReactNode }) {
	return <LeadingEdgeContext.Provider value={value}>{children}</LeadingEdgeContext.Provider>;
}

/**
 * 画面の上端に置く見出しの先頭に足す幅（pt）。ウィンドウ操作ボタンが出ていて、この見出しがウィンドウの
 * 左上の隅に来るときだけ正の値。それ以外（iPhone・全画面の iPad・詳細の列）は 0。
 */
export function useWindowControlsInset(): number {
	const atLeadingEdge = useContext(LeadingEdgeContext);
	const inset = useSyncExternalStore(subscribe, snapshot, snapshot);
	return atLeadingEdge ? inset : 0;
}
