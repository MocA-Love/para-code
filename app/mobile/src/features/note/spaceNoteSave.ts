// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ParadisMobileCapability } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileCompat.js';
import { appendSpaceNoteEntry, removeSpaceNoteTask, replaceSpaceNoteTaskText, restoreSpaceNoteLines, spaceNoteEntry, spaceNoteTaskBlock, toggleSpaceNoteTask } from '../../spaceNote.js';
import type { SpaceNoteSetOptions } from '../../store.js';

/**
 * スペースのメモを PC の書き足しを消さずに保存する決め事（Orca W2-16）。React に依存しない純関数で、
 * `spaceNoteSave.test.ts` で固定している。
 *
 * - チェックの切り替えと1件の追加は「何をしたか」（`op`）で送る。PC はいまの本文に当てるので、
 *   開いた後に PC やエージェントが書き足していても消えない。行を指す操作には読んだ本文（`baseText`）も付け、
 *   PC は行単位の差分で位置を対応づける（同じ中身の項目が複数あっても取り違えない。古い PC は読み飛ばす）
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
	/**
	 * 全文の書き換えを当てた本文の版（`next` を作った元の本文を読んだときの版）。付けたらこれを `base` に使う
	 * （送る直前の版を付けると、その間に別の操作が進めた版で古い全文が通り、その操作を消してしまう）。
	 */
	readonly base?: number;
	/**
	 * 「元に戻す」の全文の書き換え。書かれなかったときに全文をクリップボードへ入れない（書きかけではないので）。
	 * 出す文言も「元に戻せませんでした」にする。
	 */
	readonly restore?: true;
}

/** `lineIndex` 行目のチェックを切り替える。チェック項目でなければ undefined。 */
export function toggleNoteChange(text: string, lineIndex: number): SpaceNoteChange | undefined {
	const next = toggleSpaceNoteTask(text, lineIndex);
	if (next === undefined) {
		return undefined;
	}
	return { next, op: { kind: 'toggle', line: lineIndex, lineText: text.split('\n')[lineIndex] ?? '', baseText: text } };
}

/** 末尾に1件足す。中身が空なら undefined。 */
export function appendNoteChange(text: string, label: string, kind: 'task' | 'text'): SpaceNoteChange | undefined {
	const entry = spaceNoteEntry(label, kind);
	const next = appendSpaceNoteEntry(text, label, kind);
	return entry !== undefined && next !== undefined ? { next, op: { kind: 'append', entry } } : undefined;
}

/** PC が noteSet の `op` の `remove` / `edit` を扱えることの印。無い PC には「編集」「削除」を出さない。 */
export const NOTE_TASK_OPS_CAPABILITY = ParadisMobileCapability.NoteTaskOps;

/** `lineIndex` 行目のチェック項目を継続行ごと消す。`removed` は「元に戻す」で挿し直す行。チェック項目でなければ undefined。 */
export function removeNoteChange(text: string, lineIndex: number): (SpaceNoteChange & { readonly removed: readonly string[] }) | undefined {
	const removed = spaceNoteTaskBlock(text, lineIndex);
	const next = removeSpaceNoteTask(text, lineIndex);
	if (removed === undefined || next === undefined) {
		return undefined;
	}
	return { next, op: { kind: 'remove', line: lineIndex, lineText: text.split('\n')[lineIndex] ?? '', baseText: text }, removed };
}

/** `lineIndex` 行目のチェック項目の文言を書き換える。空・変わらない・チェック項目でなければ undefined。 */
export function editNoteChange(text: string, lineIndex: number, label: string): SpaceNoteChange | undefined {
	const next = replaceSpaceNoteTaskText(text, lineIndex, label);
	if (next === undefined) {
		return undefined;
	}
	return { next, op: { kind: 'edit', line: lineIndex, lineText: text.split('\n')[lineIndex] ?? '', text: label, baseText: text } };
}

/**
 * 消した項目を元の位置へ挿し直す（「元に戻す」）。PC には挿し直す操作が無いので、いまの本文に挿し直した全文を
 * 版（`base`）付きで送る。消した後に PC で書き換えられていれば書かれずに最新が返る（黙って上書きしない）。
 */
export function restoreNoteChange(text: string, lineIndex: number, removed: readonly string[], base: number | undefined): SpaceNoteChange {
	return { next: restoreSpaceNoteLines(text, lineIndex, removed), restore: true, ...(base !== undefined ? { base } : {}) };
}

/**
 * 「元に戻す」で挿し直す行。`removedText` は消した直後の PC の本文、`removedAt` は PC が実際に消した位置（応答の
 * `opLine`。無い PC では手元の行）。その後に本文が変わっていれば、消した位置の直前の行を今の本文で探して、その次に挿す
 * （直前の行が見つからなければ同じ行番号。先頭なら先頭）。
 */
export function restoreLineIndex(removedText: string, removedAt: number, latestText: string): number {
	const latest = latestText.length > 0 ? latestText.split('\n') : [];
	if (removedText === latestText || removedAt <= 0) {
		return Math.min(Math.max(removedAt, 0), latest.length);
	}
	const before = removedText.split('\n')[removedAt - 1];
	if (before !== undefined) {
		let nearest: number | undefined;
		for (let index = 0; index < latest.length; index++) {
			if (latest[index] === before && (nearest === undefined || Math.abs(index - (removedAt - 1)) < Math.abs(nearest - (removedAt - 1)))) {
				nearest = index;
			}
		}
		if (nearest !== undefined) {
			return nearest + 1;
		}
	}
	return Math.min(removedAt, latest.length);
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
	const version = change.base ?? base;
	return version !== undefined ? { base: version } : undefined;
}

/**
 * 版を比べられる PC なのに、全文の書き換えに付ける版が無い（再接続の直後で読み直しを待っている・スペースを変えた直後など）。
 * このときは送らずに「PC で更新されていた」と同じ扱いにする（版なしで送ると無条件に上書きされ、PC の変更を消す）。
 */
export function spaceNoteMissingBase(change: SpaceNoteChange, base: number | undefined, pcHasCas: boolean): boolean {
	return pcHasCas && change.op === undefined && (change.base ?? base) === undefined;
}

/** PC で先に書き換えられていて書かれなかったときの種類。 */
export type SpaceNoteConflictKind = 'op' | 'replace' | 'replaceCopied' | 'restore';

/** 書かれなかった全文の書き換えを、クリップボードへ逃がすか（書きかけだけ。操作と「元に戻す」は逃がさない）。 */
export function spaceNoteKeepsDraft(change: SpaceNoteChange): boolean {
	return change.op === undefined && change.restore !== true;
}

/** 書かれなかった変更に応じた種類。全文の書き換えは、書きかけをクリップボードへ逃がせたかも見る。 */
export function spaceNoteConflictKind(change: SpaceNoteChange, copied: boolean): SpaceNoteConflictKind {
	return change.op !== undefined ? 'op' : change.restore === true ? 'restore' : copied ? 'replaceCopied' : 'replace';
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
		case 'restore':
			return 'メモが変わったため元に戻せませんでした。最新を読み込みました。';
	}
}
