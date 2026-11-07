/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PC の差分エディタの行に付けるメモ（G-01、Orca の「Annotate AI Diff」）。保存の形・送る依頼文・行の付け替えを
// 純関数にしたもの。上限と行の追いかけはスマホの差分のメモ（W2-28）と同じ値・同じ関数を使う。
// 保存はスマホのものとは別のキー（別の部品の保存キーを触らない）。

import { PARADIS_MOBILE_REVIEW_MAX_NOTES, PARADIS_MOBILE_REVIEW_NOTE_BODY_MAX, PARADIS_MOBILE_REVIEW_NOTE_LINE_TEXT_MAX } from '../../mobileRelay/common/paradisMobileReviewStore.js';

export const PARADIS_DIFF_REVIEW_NOTES_STORAGE_KEY = 'paradis.diffReviewNotes.v1';
/** スペースごとのメモの上限。 */
export const PARADIS_DIFF_REVIEW_MAX_NOTES = PARADIS_MOBILE_REVIEW_MAX_NOTES;
export const PARADIS_DIFF_REVIEW_NOTE_BODY_MAX = PARADIS_MOBILE_REVIEW_NOTE_BODY_MAX;
export const PARADIS_DIFF_REVIEW_NOTE_LINE_TEXT_MAX = PARADIS_MOBILE_REVIEW_NOTE_LINE_TEXT_MAX;
/** 保存するスペースの数の上限（古いものから捨てる）。 */
export const PARADIS_DIFF_REVIEW_MAX_SPACES = 32;

/** 差分の行へのメモ 1 件。 */
export interface IParadisDiffReviewNote {
	readonly id: string;
	/** スペースのルートからのパス（`/` 区切り）。 */
	readonly path: string;
	/** 書いたときの新しい側の行番号（1 から）。 */
	readonly line: number;
	/** 書いたときのその行の中身。行が上下に動いても中身で追いかける。 */
	readonly lineText: string;
	readonly body: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** エージェントへ送った時刻。送った後も「送信済み」として残す。 */
	readonly sentAt?: number;
}

/** スペース（stateKey）→ そのスペースのメモ。 */
export type ParadisDiffReviewNotesStore = ReadonlyMap<string, readonly IParadisDiffReviewNote[]>;

function isNote(value: unknown): value is IParadisDiffReviewNote {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const note = value as Record<string, unknown>;
	return typeof note.id === 'string' && note.id.length > 0 && note.id.length <= 64
		&& typeof note.path === 'string' && note.path.length > 0 && note.path.length <= 4096
		&& typeof note.line === 'number' && Number.isInteger(note.line) && note.line >= 1
		&& typeof note.lineText === 'string' && note.lineText.length <= PARADIS_DIFF_REVIEW_NOTE_LINE_TEXT_MAX
		&& typeof note.body === 'string' && note.body.trim().length > 0 && note.body.length <= PARADIS_DIFF_REVIEW_NOTE_BODY_MAX
		&& typeof note.createdAt === 'number' && typeof note.updatedAt === 'number'
		&& (note.sentAt === undefined || typeof note.sentAt === 'number');
}

/** 保存された文字列を読む。壊れた項目は捨てる。 */
export function paradisParseDiffReviewNotes(raw: string | undefined): Map<string, IParadisDiffReviewNote[]> {
	const result = new Map<string, IParadisDiffReviewNote[]>();
	if (!raw) {
		return result;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return result;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return result;
	}
	for (const [stateKey, notes] of Object.entries(parsed as Record<string, unknown>)) {
		if (!Array.isArray(notes)) {
			continue;
		}
		const valid = notes.filter(isNote).slice(0, PARADIS_DIFF_REVIEW_MAX_NOTES);
		if (valid.length > 0) {
			result.set(stateKey, valid);
		}
	}
	return result;
}

/** 保存する文字列にする。空のスペースは書かず、スペースの数は最近触ったものから上限まで残す。 */
export function paradisSerializeDiffReviewNotes(store: ParadisDiffReviewNotesStore): string {
	const latest = (notes: readonly IParadisDiffReviewNote[]) => Math.max(0, ...notes.map(note => note.updatedAt));
	const entries = [...store].filter(([, notes]) => notes.length > 0)
		.sort((a, b) => latest(b[1]) - latest(a[1]))
		.slice(0, PARADIS_DIFF_REVIEW_MAX_SPACES);
	return JSON.stringify(Object.fromEntries(entries));
}

/** 送るメモ 1 件と、今の行（見つからなければ undefined）。 */
export interface IParadisDiffReviewNoteToSend {
	readonly note: IParadisDiffReviewNote;
	readonly currentLine: number | undefined;
}

/**
 * エージェントへ送る文。Orca と同じ形（`File:` / `Line:` / `User comment:`）にする。コメントは JSON の文字列として
 * 書く（`"` と改行がエスケープされ、1 件が必ず 3 行に収まる）。行が見つからなくなったメモは、書いたときの行番号に
 * そう書き添える。
 */
export function paradisBuildDiffReviewNotesPrompt(notes: readonly IParadisDiffReviewNoteToSend[]): string {
	return notes.map(({ note, currentLine }) => [
		`File: ${note.path}`,
		currentLine !== undefined ? `Line: ${currentLine}` : `Line: ${note.line} (the line changed after this note was written)`,
		`User comment: ${JSON.stringify(note.body.trim())}`,
	].join('\n')).join('\n');
}

/** 送った後、読んだときの版（`updatedAt`）のままのメモにだけ送信済みの印を付ける（送る間に書き直されたものには付けない）。 */
export function paradisMarkDiffReviewNotesSent(notes: readonly IParadisDiffReviewNote[], readVersions: ReadonlyMap<string, number>, now: number): IParadisDiffReviewNote[] {
	return notes.map(note => readVersions.get(note.id) === note.updatedAt ? { ...note, sentAt: now } : note);
}

/**
 * スペースのルートのパスからの相対パス。スペースの外なら undefined。修正側は `git:` の URI（ステージ済みの差分）の
 * こともあるので、URI の仕組みは見ずにパスで比べる。手元の Windows・macOS は大文字小文字を区別しない。
 */
export function paradisDiffReviewRelativePath(rootPath: string, filePath: string, ignoreCase: boolean): string | undefined {
	const root = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
	const same = ignoreCase ? filePath.toLowerCase().startsWith(root.toLowerCase()) : filePath.startsWith(root);
	return same && filePath.length > root.length ? filePath.slice(root.length) : undefined;
}
