// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ParadisMobileCapability } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileCompat.js';
import { appendSpaceNoteEntry, spaceNoteEntry, toggleSpaceNoteTask } from '../../spaceNote.js';
import type { SpaceNoteSetOptions } from '../../store.js';

/**
 * スペースのメモを PC の書き足しを消さずに保存する決め事（Orca W2-16）。React に依存しない純関数で、
 * `spaceNoteSave.test.ts` で固定している。
 *
 * - チェックの切り替えと1件の追加は「何をしたか」（`op`）で送る。PC はいまの本文に当てるので、
 *   開いた後に PC やエージェントが書き足していても消えない
 * - 本文全体の書き換え（編集）は、開いたときの版（`base`）を付けて送る。PC で変わっていれば書かれずに
 *   最新が返り、画面は最新を読み込み直す
 * - PC が `note.cas.v1` を広告していなければ何も付けない（今までどおりの上書き）
 *
 * どの場合も `text` には操作を当てた後の全文を入れて送る（古い PC はそれで上書きする）。
 */

/** PC が noteSet の `base` / `op` と応答の版（`updatedAt`）を扱えることの印。 */
export const NOTE_CAS_CAPABILITY = ParadisMobileCapability.NoteCas;

/** 保存する1回ぶんの変更。`next` は手元で当てた後の全文（楽観更新と古い PC への送信に使う）。 */
export interface SpaceNoteChange {
	readonly next: string;
	readonly op?: SpaceNoteSetOptions['op'];
}

/** `lineIndex` 行目のチェックを切り替える。チェック項目でなければ undefined。 */
export function toggleNoteChange(text: string, lineIndex: number): SpaceNoteChange | undefined {
	const next = toggleSpaceNoteTask(text, lineIndex);
	if (next === undefined) {
		return undefined;
	}
	return { next, op: { kind: 'toggle', line: lineIndex, lineText: text.split('\n')[lineIndex] ?? '' } };
}

/** 末尾に1件足す。中身が空なら undefined。 */
export function appendNoteChange(text: string, label: string, kind: 'task' | 'text'): SpaceNoteChange | undefined {
	const entry = spaceNoteEntry(label, kind);
	const next = appendSpaceNoteEntry(text, label, kind);
	return entry !== undefined && next !== undefined ? { next, op: { kind: 'append', entry } } : undefined;
}

/** 本文全体を書き換える（編集の保存）。 */
export function replaceNoteChange(next: string): SpaceNoteChange {
	return { next };
}

/** noteSet に付ける任意項目。PC が扱えなければ undefined（今までどおりの上書き）。 */
export function spaceNoteSetOptions(change: SpaceNoteChange, base: number | undefined, pcHasCas: boolean): SpaceNoteSetOptions | undefined {
	if (!pcHasCas) {
		return undefined;
	}
	if (change.op !== undefined) {
		return { op: change.op };
	}
	return base !== undefined ? { base } : undefined;
}

/** PC で先に書き換えられていて書かれなかったときの種類。 */
export type SpaceNoteConflictKind = 'op' | 'replace' | 'replaceCopied';

/** 書かれなかった変更に応じた種類。全文の書き換えは、書きかけをクリップボードへ逃がせたかも見る。 */
export function spaceNoteConflictKind(change: SpaceNoteChange, copied: boolean): SpaceNoteConflictKind {
	return change.op !== undefined ? 'op' : copied ? 'replaceCopied' : 'replace';
}

/** 書かれなかったときに出す一文。 */
export function spaceNoteConflictMessage(kind: SpaceNoteConflictKind): string {
	switch (kind) {
		case 'op':
			return 'PC で更新されていました。最新を読み込みました。もう一度操作してください。';
		case 'replace':
			return 'PC で更新されていたため保存していません。最新を読み込みました。';
		case 'replaceCopied':
			return 'PC で更新されていたため保存していません。最新を読み込み、書きかけはクリップボードにコピーしました。';
	}
}
