/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisSpaceNotesService, ParadisSpaceNoteOp, PARADIS_SPACE_NOTE_MAX_LENGTH, paradisApplySpaceNoteOpAt } from '../../workspaceSwitch/common/paradisSpaceNotes.js';

/**
 * モバイルの `noteGet` / `noteSet` の応答を作る（Orca W2-16。スペースのメモの版の確認）。
 *
 * 応答はどちらも `{ t: 'note', ws, text, updatedAt }`。`updatedAt` はメモの版（書くたびに必ず増える。
 * メモが無ければ 0）で、古いアプリは知らない項目として無視する。
 *
 * `noteSet` の任意項目（どちらも `note.cas.v1` を広告する PC だけが見る。古い PC は無視して `text` で上書きする
 * ので、アプリは `text` にも操作を当てた後の全文を入れて送る）:
 * - `op`: チェックの切り替え・1件の追加（`note.task-ops.v1` からはチェック項目の削除・文言の書き換えも）を、いまの本文に当てる。読んだ後に PC やエージェントが書き足していても
 *   その書き足しを消さない。当てられない（切り替える行がもう無い）ときは書かずに `conflict: true` と最新を返す
 * - `base`: 送る側が読んだときの版。いまの版と違えば書かずに `conflict: true` と最新を返す
 *   （比べて書くまでをこの1回の同期処理で行うので、その間に別の書き込みが割り込む余地は無い）
 * - どちらも無ければ（古いアプリ）今までどおり `text` で上書きする
 */

export interface IParadisMobileNoteReply {
	readonly t: 'note';
	readonly ws: string;
	readonly text: string;
	readonly updatedAt: number;
	readonly conflict?: true;
	/** 行を指す op を当てた、当てる前の本文の行（0 始まり）。remove なら PC が実際に消した項目の位置（`note.task-ops.v1`）。 */
	readonly opLine?: number;
}

/** 追加する1件の上限（本文の上限と同じ。超えるものは本文に入り切らない）。 */
const MAX_APPEND_LENGTH = PARADIS_SPACE_NOTE_MAX_LENGTH;

/** 受け取った `op` を検査して読む。形が違えば undefined（その要求は受け付けない）。 */
export function paradisParseMobileNoteOp(value: unknown): ParadisSpaceNoteOp | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as { kind?: unknown; line?: unknown; lineText?: unknown; entry?: unknown; text?: unknown; baseText?: unknown };
	// baseText（送る側が読んだ本文）は任意。あれば同じ中身の行を位置で見分ける。形が違えば要求ごと断る
	if (candidate.baseText !== undefined && (typeof candidate.baseText !== 'string' || candidate.baseText.length > PARADIS_SPACE_NOTE_MAX_LENGTH)) {
		return undefined;
	}
	const lineTarget = typeof candidate.line === 'number' && Number.isSafeInteger(candidate.line) && candidate.line >= 0
		&& typeof candidate.lineText === 'string' && candidate.lineText.length <= PARADIS_SPACE_NOTE_MAX_LENGTH
		? { line: candidate.line, lineText: candidate.lineText, ...(typeof candidate.baseText === 'string' ? { baseText: candidate.baseText } : {}) }
		: undefined;
	if (candidate.kind === 'toggle' && lineTarget !== undefined) {
		return { kind: 'toggle', ...lineTarget };
	}
	// remove / edit は note.task-ops.v1（それを広告しない古い PC はここに来ず invalid op で断る）。どちらも項目を消す・
	// 書き換えるので、同じ中身の別の項目に当てないよう baseText を必須にする（それを送るアプリだけが使う）
	if (candidate.kind === 'remove' && lineTarget?.baseText !== undefined) {
		return { kind: 'remove', ...lineTarget };
	}
	if (candidate.kind === 'edit' && lineTarget?.baseText !== undefined && typeof candidate.text === 'string' && candidate.text.length <= PARADIS_SPACE_NOTE_MAX_LENGTH) {
		return { kind: 'edit', ...lineTarget, text: candidate.text };
	}
	if (candidate.kind === 'append' && typeof candidate.entry === 'string' && candidate.entry.length <= MAX_APPEND_LENGTH) {
		return { kind: 'append', entry: candidate.entry };
	}
	return undefined;
}

/** 本文が長すぎるときの応答（黙って末尾を切らない）。 */
const TOO_LONG_ERROR = `メモが長すぎるため保存しませんでした（${PARADIS_SPACE_NOTE_MAX_LENGTH} 文字まで）`;

/**
 * 書いて応答を返す。PC が受け付けなかった（メモのあるスペースの数が上限に達しているなど）ときは、書けたように見せずに
 * `{ error }` を返す。空の本文はメモを消す書き込みなので、残っていないことが正しい。
 */
function writeAndReply(notes: IParadisSpaceNotesService, ws: string, text: string): IParadisMobileNoteReply | { readonly error: string } {
	notes.write(ws, text);
	if (text.trim().length > 0 && notes.read(ws) !== text) {
		return { error: 'このスペースのメモを PC に保存できませんでした（メモのあるスペースの数が上限に達しています）' };
	}
	return noteReply(notes, ws);
}

function noteReply(notes: IParadisSpaceNotesService, ws: string, conflict = false, opLine?: number): IParadisMobileNoteReply {
	const entry = notes.readEntry(ws);
	return { t: 'note', ws, text: entry?.text ?? '', updatedAt: entry?.updatedAt ?? 0, ...(conflict ? { conflict: true as const } : {}), ...(opLine !== undefined ? { opLine } : {}) };
}

/** `noteGet` の応答。 */
export function paradisMobileNoteGet(notes: IParadisSpaceNotesService, ws: string): IParadisMobileNoteReply {
	return noteReply(notes, ws);
}

/**
 * `noteSet` を処理して応答を返す。形が違えば `{ error }`。
 * 読んでから書くまでを await を挟まずに行う（レンダラーは1本のスレッドなので、これで比べて書くまでが一続きになる）。
 */
export function paradisMobileNoteSet(notes: IParadisSpaceNotesService, ws: string, message: { readonly text?: unknown; readonly base?: unknown; readonly op?: unknown }): IParadisMobileNoteReply | { readonly error: string } {
	if (typeof message.text !== 'string') {
		return { error: 'text is required' };
	}
	if (message.op !== undefined) {
		const op = paradisParseMobileNoteOp(message.op);
		if (op === undefined) {
			return { error: 'invalid op' };
		}
		const current = notes.read(ws);
		const applied = paradisApplySpaceNoteOpAt(current, op);
		if (applied === undefined || applied.text.length > PARADIS_SPACE_NOTE_MAX_LENGTH) {
			return noteReply(notes, ws, true);
		}
		// 変わらない操作（同じ文言への書き換え）は書かずに最新を返す（版を進めない。失敗でもない）
		if (applied.text === current) {
			return noteReply(notes, ws, false, applied.line);
		}
		const written = writeAndReply(notes, ws, applied.text);
		return (written as { readonly error?: string }).error !== undefined || applied.line === undefined ? written : { ...(written as IParadisMobileNoteReply), opLine: applied.line };
	}
	// 上限を超えた本文は、PC が末尾を切って書いてしまう（版を比べた書き込みでも）。切らずに断る
	// （`op` の書き込みは、当てた後が上限を超えれば上で `conflict` を返している）
	if (message.text.length > PARADIS_SPACE_NOTE_MAX_LENGTH) {
		return { error: TOO_LONG_ERROR };
	}
	if (message.base !== undefined) {
		if (typeof message.base !== 'number' || !Number.isFinite(message.base)) {
			return { error: 'invalid base' };
		}
		if ((notes.readEntry(ws)?.updatedAt ?? 0) !== message.base) {
			return noteReply(notes, ws, true);
		}
	}
	return writeAndReply(notes, ws, message.text);
}
