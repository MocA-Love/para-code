/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisMobileReviewMark, IParadisMobileReviewNote } from './paradisMobileDiffReview.js';

/**
 * モバイルの差分レビューの記録を PC に保存する形（Orca W2-14）。スペースのメモと同じく、ウィンドウの
 * WORKSPACE ストレージに1つのキーで置く。キーはスペース（scm 要求の `ws`）。
 *
 * モバイルは信用しない相手なので、読むときも書くときも形と上限を確かめる（壊れた1件で全部を捨てない）。
 */

export const PARADIS_MOBILE_REVIEW_STORAGE_KEY = 'paradis.mobileRelay.diffReview.v1';

/** 保存するスペースの数の上限。超えたら、いちばん長く触っていないスペースから捨てる。 */
export const PARADIS_MOBILE_REVIEW_MAX_SPACES = 32;
/** 1スペースの確認済みの印の上限。超えたら古く確認したものから捨てる。 */
export const PARADIS_MOBILE_REVIEW_MAX_MARKS = 500;
/** 1回の要求で変えられる印の数。 */
export const PARADIS_MOBILE_REVIEW_MAX_MARKS_PER_REQUEST = 500;
const MAX_PATH_LENGTH = 1_024;
const MAX_KEY_LENGTH = 1_024;
const IDENTITY_PATTERN = /^[0-9a-f]{1,64}$/;
/** 1スペースのメモの上限。 */
export const PARADIS_MOBILE_REVIEW_MAX_NOTES = 100;
/** メモの本文の上限（文字）。 */
export const PARADIS_MOBILE_REVIEW_NOTE_BODY_MAX = 2_000;
/** メモに控える行の中身の上限（文字）。長い行は切り詰めて控える（追いかけるときは切り詰めた長さで比べる）。 */
export const PARADIS_MOBILE_REVIEW_NOTE_LINE_TEXT_MAX = 500;
/** 1回の要求で指定できるメモの数。 */
export const PARADIS_MOBILE_REVIEW_MAX_NOTE_IDS = PARADIS_MOBILE_REVIEW_MAX_NOTES;
const NOTE_ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const MAX_LINE_NUMBER = 10_000_000;
/** 全体の上限（JSON の文字数）。超えたら古いスペースから捨てる。 */
const MAX_STORAGE_LENGTH = 2_000_000;

/** 1スペースぶんの記録。 */
export interface IParadisMobileReviewSpace {
	readonly marks: Readonly<Record<string, IParadisMobileReviewMark>>;
	/** 差分の行へのメモ（Orca W2-28）。書いた順。 */
	readonly notes: readonly IParadisMobileReviewNote[];
	/** 最後に変えた時刻。スペースが多すぎるときに古いものから捨てるのに使う。 */
	readonly updatedAt: number;
	/**
	 * 記録の版。保存するたびに1ずつ増える（{@link paradisNextMobileReviewRevision}）。応答に載せ、アプリは
	 * 手元より新しい版の応答だけを反映する（後から届いた古い応答で巻き戻さないため）。
	 */
	readonly revision: number;
}

export type ParadisMobileReviewStore = ReadonlyMap<string, IParadisMobileReviewSpace>;

const EMPTY_SPACE: IParadisMobileReviewSpace = { marks: {}, notes: [], updatedAt: 0, revision: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTime(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 相対パスとして受け付けるか（空・長すぎる・NUL を含む・絶対パスは拒む）。 */
export function paradisIsReviewPath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH && !value.includes('\0') && !value.startsWith('/');
}

function parseMark(value: unknown): IParadisMobileReviewMark | undefined {
	if (!isRecord(value) || typeof value.identity !== 'string' || !IDENTITY_PATTERN.test(value.identity)) {
		return undefined;
	}
	const reviewedAt = validTime(value.reviewedAt);
	return reviewedAt !== undefined ? { identity: value.identity, reviewedAt } : undefined;
}

function parseMarks(value: unknown): Record<string, IParadisMobileReviewMark> {
	const marks: Record<string, IParadisMobileReviewMark> = {};
	if (!isRecord(value)) {
		return marks;
	}
	let count = 0;
	for (const [path, raw] of Object.entries(value)) {
		const mark = paradisIsReviewPath(path) ? parseMark(raw) : undefined;
		if (mark !== undefined && count < PARADIS_MOBILE_REVIEW_MAX_MARKS) {
			marks[path] = mark;
			count++;
		}
	}
	return marks;
}

/** メモの本文として受け付けるか（前後の空白を除いて空でない・長すぎない）。 */
export function paradisIsReviewNoteBody(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= PARADIS_MOBILE_REVIEW_NOTE_BODY_MAX;
}

export function paradisIsReviewNoteLine(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINE_NUMBER;
}

export function paradisIsReviewNoteId(value: unknown): value is string {
	return typeof value === 'string' && NOTE_ID_PATTERN.test(value);
}

function parseNote(value: unknown): IParadisMobileReviewNote | undefined {
	if (!isRecord(value) || !paradisIsReviewNoteId(value.id) || !paradisIsReviewPath(value.path) || !paradisIsReviewNoteLine(value.line)
		|| typeof value.lineText !== 'string' || value.lineText.length > PARADIS_MOBILE_REVIEW_NOTE_LINE_TEXT_MAX || !paradisIsReviewNoteBody(value.body)) {
		return undefined;
	}
	const createdAt = validTime(value.createdAt);
	const updatedAt = validTime(value.updatedAt);
	const sentAt = value.sentAt === undefined ? undefined : validTime(value.sentAt);
	if (createdAt === undefined || updatedAt === undefined || (value.sentAt !== undefined && sentAt === undefined)) {
		return undefined;
	}
	return { id: value.id, path: value.path, line: value.line, lineText: value.lineText, body: value.body, createdAt, updatedAt, ...(sentAt !== undefined ? { sentAt } : {}) };
}

function parseNotes(value: unknown): IParadisMobileReviewNote[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const notes: IParadisMobileReviewNote[] = [];
	for (const candidate of value) {
		const note = parseNote(candidate);
		if (note !== undefined && notes.length < PARADIS_MOBILE_REVIEW_MAX_NOTES && !notes.some(existing => existing.id === note.id)) {
			notes.push(note);
		}
	}
	return notes;
}

/** 保存された全体を読む。読めない値は空として扱う（スペース単位・印単位で壊れたものだけ飛ばす）。 */
export function paradisParseMobileReviewStore(raw: string | undefined): Map<string, IParadisMobileReviewSpace> {
	const store = new Map<string, IParadisMobileReviewSpace>();
	if (raw === undefined || raw.length > MAX_STORAGE_LENGTH) {
		return store;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return store;
	}
	if (!isRecord(value)) {
		return store;
	}
	for (const [ws, entry] of Object.entries(value)) {
		if (store.size >= PARADIS_MOBILE_REVIEW_MAX_SPACES) {
			break;
		}
		if (ws.length === 0 || ws.length > MAX_KEY_LENGTH || !isRecord(entry)) {
			continue;
		}
		const revision = entry.revision;
		store.set(ws, {
			marks: parseMarks(entry.marks),
			notes: parseNotes(entry.notes),
			updatedAt: validTime(entry.updatedAt) ?? 0,
			revision: typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
		});
	}
	return store;
}

/**
 * スペースの記録を古いものから半分ほど削る。削る順は、送信済みのメモ（送った時刻の古い順）→ 確認済みの印
 * （確認した時刻の古い順）→ 送っていないメモ（書き直した時刻の古い順）。残りが無くなるなら undefined。
 */
export function paradisTrimMobileReviewSpace(space: IParadisMobileReviewSpace): IParadisMobileReviewSpace | undefined {
	type Item = { readonly rank: number; readonly time: number; readonly note?: string; readonly mark?: string };
	const items: Item[] = [
		...space.notes.map(note => note.sentAt !== undefined ? { rank: 0, time: note.sentAt, note: note.id } : { rank: 2, time: note.updatedAt, note: note.id }),
		...Object.entries(space.marks).map(([path, mark]) => ({ rank: 1, time: mark.reviewedAt, mark: path })),
	].sort((a, b) => a.rank - b.rank || a.time - b.time);
	if (items.length <= 1) {
		return undefined;
	}
	const dropped = items.slice(0, Math.ceil(items.length / 2));
	const droppedNotes = new Set(dropped.flatMap(item => item.note !== undefined ? [item.note] : []));
	const droppedMarks = new Set(dropped.flatMap(item => item.mark !== undefined ? [item.mark] : []));
	return {
		marks: Object.fromEntries(Object.entries(space.marks).filter(([path]) => !droppedMarks.has(path))),
		notes: space.notes.filter(note => !droppedNotes.has(note.id)),
		updatedAt: space.updatedAt,
		revision: space.revision,
	};
}

/**
 * 上限に収まるよう JSON にする。スペースの数を超えたら最も長く触っていないスペースから捨てる。大きさを超えたら、
 * スペースを丸ごと捨てる前に、最も長く触っていないスペースの古い記録から削る（{@link paradisTrimMobileReviewSpace}）。
 */
export function paradisSerializeMobileReviewStore(store: ParadisMobileReviewStore): string {
	const spaces = [...store].filter(([, space]) => Object.keys(space.marks).length > 0 || space.notes.length > 0)
		.sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
		.slice(0, PARADIS_MOBILE_REVIEW_MAX_SPACES);
	let serialized = JSON.stringify(Object.fromEntries(spaces));
	while (serialized.length > MAX_STORAGE_LENGTH && spaces.length > 0) {
		const last = spaces[spaces.length - 1];
		const trimmed = last !== undefined ? paradisTrimMobileReviewSpace(last[1]) : undefined;
		if (last !== undefined && trimmed !== undefined) {
			spaces[spaces.length - 1] = [last[0], trimmed];
		} else {
			spaces.pop();
		}
		serialized = JSON.stringify(Object.fromEntries(spaces));
	}
	return serialized;
}

export function paradisMobileReviewSpace(store: ParadisMobileReviewStore, ws: string): IParadisMobileReviewSpace {
	return store.get(ws) ?? EMPTY_SPACE;
}

/** 保存する記録に、いま保存されているものの次の版を付ける。 */
export function paradisNextMobileReviewRevision(stored: IParadisMobileReviewSpace, next: IParadisMobileReviewSpace): IParadisMobileReviewSpace {
	return { ...next, revision: stored.revision + 1 };
}

/** 印を1件変える要求。`identity` が null なら外す。 */
export interface IParadisMobileReviewMarkChange {
	readonly path: string;
	readonly identity: string | null;
}

/** `reviewSet` の `marks` を読む。形が違えば undefined（要求ごと受け付けない）。 */
export function paradisParseMobileReviewMarkChanges(value: unknown): IParadisMobileReviewMarkChange[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > PARADIS_MOBILE_REVIEW_MAX_MARKS_PER_REQUEST) {
		return undefined;
	}
	const changes: IParadisMobileReviewMarkChange[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate) || !paradisIsReviewPath(candidate.path)) {
			return undefined;
		}
		if (candidate.identity === null) {
			changes.push({ path: candidate.path, identity: null });
		} else if (typeof candidate.identity === 'string' && IDENTITY_PATTERN.test(candidate.identity)) {
			changes.push({ path: candidate.path, identity: candidate.identity });
		} else {
			return undefined;
		}
	}
	return changes;
}

/** 印を変えたスペースを返す。上限を超えたら古く確認したものから捨てる。 */
export function paradisApplyMobileReviewMarkChanges(space: IParadisMobileReviewSpace, changes: readonly IParadisMobileReviewMarkChange[], now: number): IParadisMobileReviewSpace {
	const marks: Record<string, IParadisMobileReviewMark> = { ...space.marks };
	for (const change of changes) {
		if (change.identity === null) {
			delete marks[change.path];
		} else {
			marks[change.path] = { identity: change.identity, reviewedAt: now };
		}
	}
	const entries = Object.entries(marks);
	const kept = entries.length <= PARADIS_MOBILE_REVIEW_MAX_MARKS
		? marks
		: Object.fromEntries(entries.sort(([, a], [, b]) => b.reviewedAt - a.reviewedAt).slice(0, PARADIS_MOBILE_REVIEW_MAX_MARKS));
	return { ...space, marks: kept, updatedAt: now };
}

/**
 * いまの変更の一覧に無いパスの印を外す（コミット・破棄されたファイル）。変わらなければ同じものを返す。
 * `changedPaths` は status のパス（リネームは新しい側）。
 */
export function paradisPruneMobileReviewSpace(space: IParadisMobileReviewSpace, changedPaths: ReadonlySet<string>): IParadisMobileReviewSpace {
	const entries = Object.entries(space.marks);
	const kept = entries.filter(([path]) => changedPaths.has(path));
	return kept.length === entries.length ? space : { ...space, marks: Object.fromEntries(kept) };
}

/**
 * 確認済みのファイルをステージした後、印の識別をステージ後の識別へ付け替える（ステージすると状態と行数の側が
 * 変わり、識別が変わるため）。`restaged` はパスごとの「ステージ前の識別 → ステージ後の識別」。
 * ステージ前の識別と一致する印だけを付け替える（その間に誰かが印を変えていれば触らない）。
 */
export function paradisRemapMobileReviewMarks(space: IParadisMobileReviewSpace, restaged: ReadonlyMap<string, { readonly before: string; readonly after: string }>): IParadisMobileReviewSpace {
	let changed = false;
	const marks: Record<string, IParadisMobileReviewMark> = { ...space.marks };
	for (const [path, { before, after }] of restaged) {
		const mark = marks[path];
		if (mark !== undefined && mark.identity === before && before !== after) {
			marks[path] = { identity: after, reviewedAt: mark.reviewedAt };
			changed = true;
		}
	}
	return changed ? { ...space, marks } : space;
}

/** メモを1件足す。上限に達していれば undefined。 */
export function paradisAddMobileReviewNote(space: IParadisMobileReviewSpace, note: { readonly id: string; readonly path: string; readonly line: number; readonly lineText: string; readonly body: string }, now: number): IParadisMobileReviewSpace | undefined {
	if (space.notes.length >= PARADIS_MOBILE_REVIEW_MAX_NOTES) {
		return undefined;
	}
	const added: IParadisMobileReviewNote = {
		id: note.id,
		path: note.path,
		line: note.line,
		lineText: note.lineText.slice(0, PARADIS_MOBILE_REVIEW_NOTE_LINE_TEXT_MAX),
		body: note.body.trim(),
		createdAt: now,
		updatedAt: now,
	};
	return { ...space, notes: [...space.notes, added], updatedAt: now };
}

/** メモの本文を書き換える。送信済みのものを書き換えたら、もう一度送れるよう未送信に戻す。見つからなければ undefined。 */
export function paradisEditMobileReviewNote(space: IParadisMobileReviewSpace, id: string, body: string, now: number): IParadisMobileReviewSpace | undefined {
	const index = space.notes.findIndex(note => note.id === id);
	const note = space.notes[index];
	if (note === undefined) {
		return undefined;
	}
	const { sentAt: _sentAt, ...unsent } = note;
	const notes = [...space.notes];
	notes[index] = { ...unsent, body: body.trim(), updatedAt: now };
	return { ...space, notes, updatedAt: now };
}

/** 指定したメモを消す。 */
export function paradisDeleteMobileReviewNotes(space: IParadisMobileReviewSpace, ids: ReadonlySet<string>, now: number): IParadisMobileReviewSpace {
	return { ...space, notes: space.notes.filter(note => !ids.has(note.id)), updatedAt: now };
}

/** 指定したメモに送った時刻を付ける。 */
export function paradisMarkMobileReviewNotesSent(space: IParadisMobileReviewSpace, ids: ReadonlySet<string>, now: number): IParadisMobileReviewSpace {
	return { ...space, notes: space.notes.map(note => ids.has(note.id) ? { ...note, sentAt: now } : note), updatedAt: now };
}

/** `ids` の配列を読む。形が違えば undefined。 */
export function paradisParseMobileReviewNoteIds(value: unknown): Set<string> | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > PARADIS_MOBILE_REVIEW_MAX_NOTE_IDS || !value.every(paradisIsReviewNoteId)) {
		return undefined;
	}
	return new Set(value);
}
