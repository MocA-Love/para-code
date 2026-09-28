// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	PARADIS_MOBILE_REVIEW_NOTE_SEARCH_RADIUS,
	paradisLocateReviewNoteLine,
	type IParadisMobileReviewNote,
} from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileDiffReview.js';
import type { DiffRow } from '../../components/diffParser.js';

/**
 * 差分の行へのメモ（Orca W2-28）の判定。React に依存しない純関数で、`reviewNotes.test.ts` で固定している。
 * 行の追いかけ方（書いたときの行の中身で探す）は PC と同じ関数を使う。
 */

export type ReviewNote = IParadisMobileReviewNote;

/** PC がメモに控える行の中身の長さ（PC の `PARADIS_MOBILE_REVIEW_NOTE_LINE_TEXT_MAX` と同じ）。 */
const LINE_TEXT_MAX = 500;
/** メモの本文の上限（PC と同じ）。 */
export const REVIEW_NOTE_BODY_MAX = 2_000;

/** PC から届いたメモの一覧を読む。形の違う1件は飛ばす。 */
export function parseReviewNotes(value: unknown): ReviewNote[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const notes: ReviewNote[] = [];
	for (const raw of value) {
		const note = raw as Partial<Record<keyof ReviewNote, unknown>> | null;
		if (note === null || typeof note !== 'object' || typeof note.id !== 'string' || typeof note.path !== 'string' || typeof note.line !== 'number'
			|| typeof note.lineText !== 'string' || typeof note.body !== 'string' || typeof note.createdAt !== 'number' || typeof note.updatedAt !== 'number') {
			continue;
		}
		notes.push({
			id: note.id, path: note.path, line: note.line, lineText: note.lineText, body: note.body, createdAt: note.createdAt, updatedAt: note.updatedAt,
			...(typeof note.sentAt === 'number' ? { sentAt: note.sentAt } : {}),
		});
	}
	return notes;
}

/** その行にメモを付けられるか（削除行と見出しには付けない。新しい側の行番号が無いため。Orca と同じ）。 */
export function canAnnotateRow(row: DiffRow): row is DiffRow & { newNo: number } {
	return row.kind !== 'del' && row.kind !== 'hunk' && row.newNo !== undefined;
}

/** メモを付ける行の控え（PC へ送る `line` と `lineText`）。 */
export function noteAnchorOf(row: DiffRow & { newNo: number }): { readonly line: number; readonly lineText: string } {
	return { line: row.newNo, lineText: row.text.slice(0, LINE_TEXT_MAX) };
}

/** 差分の行とメモを並べたもの（メモは付いた行のすぐ下に出す）。 */
export type DiffLineItem =
	| { readonly kind: 'row'; readonly row: DiffRow; readonly index: number }
	| { readonly kind: 'note'; readonly note: ReviewNote };

export interface PlacedNotes {
	readonly items: readonly DiffLineItem[];
	/** 差分の中に行が見つからないメモ（直されて行が変わった、または差分から外れた）。 */
	readonly stale: readonly ReviewNote[];
}

/**
 * このファイルのメモを差分の行の下へ置く。書いたときの行番号の中身が同じならそこ、違えば前後から同じ中身の行を
 * 探す（PC と同じ {@link paradisLocateReviewNoteLine}）。見つからなければ `stale` に入れる。
 */
export function placeReviewNotes(rows: readonly DiffRow[], notes: readonly ReviewNote[], path: string): PlacedNotes {
	const rowIndexByLine = new Map<number, number>();
	rows.forEach((row, index) => {
		if (canAnnotateRow(row)) {
			rowIndexByLine.set(row.newNo, index);
		}
	});
	const textAt = (line: number) => {
		const index = rowIndexByLine.get(line);
		return index !== undefined ? rows[index]?.text.slice(0, LINE_TEXT_MAX) : undefined;
	};
	const byRow = new Map<number, ReviewNote[]>();
	const stale: ReviewNote[] = [];
	for (const note of notes) {
		if (note.path !== path) {
			continue;
		}
		const line = paradisLocateReviewNoteLine(textAt, note.line, note.lineText);
		const index = line !== undefined ? rowIndexByLine.get(line) : undefined;
		if (index === undefined) {
			stale.push(note);
		} else {
			byRow.set(index, [...(byRow.get(index) ?? []), note]);
		}
	}
	const items: DiffLineItem[] = [];
	rows.forEach((row, index) => {
		items.push({ kind: 'row', row, index });
		for (const note of byRow.get(index) ?? []) {
			items.push({ kind: 'note', note });
		}
	});
	return { items, stale };
}

/** 行を探す範囲（PC と同じ）。表示の説明に使う。 */
export const REVIEW_NOTE_SEARCH_RADIUS = PARADIS_MOBILE_REVIEW_NOTE_SEARCH_RADIUS;

/** 送り先の候補（そのスペースのエージェントのターミナル）。 */
export interface ReviewSendTarget {
	readonly terminalKey: string;
	readonly title: string;
	readonly status: string | undefined;
	/** いま送れるか（作業中・確認待ちでない）。最終の判定は PC が送る直前に行う。 */
	readonly ready: boolean;
}

const BUSY_STATUSES = new Set(['working', 'permission', 'question']);

export function reviewSendTargets(terminals: readonly { readonly terminalKey: string; readonly title: string; readonly ws?: string; readonly agent?: boolean; readonly agentStatus?: string }[], wsId: string | undefined): ReviewSendTarget[] {
	return terminals
		.filter(terminal => wsId !== undefined && terminal.ws === wsId && terminal.agent === true)
		.map(terminal => ({ terminalKey: terminal.terminalKey, title: terminal.title, status: terminal.agentStatus, ready: !BUSY_STATUSES.has(terminal.agentStatus ?? '') }));
}

/** 送り先の状態の一言。 */
export function sendTargetStatusLabel(target: ReviewSendTarget): string {
	switch (target.status) {
		case 'working':
			return '作業中';
		case 'permission':
			return '許可を待っています';
		case 'question':
			return '質問に答えを待っています';
		case 'review':
			return '完了（入力を待っています）';
		default:
			return '入力を待っています';
	}
}

/** 送っていないメモ（送る候補。既定で選んでおく）。 */
export function unsentNoteIds(notes: readonly ReviewNote[]): string[] {
	return notes.filter(note => note.sentAt === undefined).map(note => note.id);
}

/** ファイルごとのメモの数（ファイルの一覧に出す）。 */
export function noteCountsByPath(notes: readonly ReviewNote[]): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const note of notes) {
		counts.set(note.path, (counts.get(note.path) ?? 0) + 1);
	}
	return counts;
}

/** PC の送信の失敗を一文にする（PC が理由の文を付けていればそれを使う）。 */
export function sendFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 0 ? message : 'メモを送れませんでした';
}
