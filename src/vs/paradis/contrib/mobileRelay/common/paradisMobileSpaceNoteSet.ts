/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisSpaceNotesService, ParadisSpaceNoteOp, PARADIS_SPACE_NOTE_MAX_LENGTH, paradisApplySpaceNoteOp } from '../../workspaceSwitch/common/paradisSpaceNotes.js';

/**
 * モバイルの `noteGet` / `noteSet` の応答を作る（Orca W2-16。スペースのメモの版の確認）。
 *
 * 応答はどちらも `{ t: 'note', ws, text, updatedAt }`。`updatedAt` はメモの版（書くたびに必ず増える。
 * メモが無ければ 0）で、古いアプリは知らない項目として無視する。
 *
 * `noteSet` の任意項目（どちらも `note.cas.v1` を広告する PC だけが見る。古い PC は無視して `text` で上書きする
 * ので、アプリは `text` にも操作を当てた後の全文を入れて送る）:
 * - `op`: チェックの切り替え・1件の追加を、いまの本文に当てる。読んだ後に PC やエージェントが書き足していても
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
}

/** 追加する1件の上限（本文の上限と同じ。超えるものは本文に入り切らない）。 */
const MAX_APPEND_LENGTH = PARADIS_SPACE_NOTE_MAX_LENGTH;

/** 受け取った `op` を検査して読む。形が違えば undefined（その要求は受け付けない）。 */
export function paradisParseMobileNoteOp(value: unknown): ParadisSpaceNoteOp | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as { kind?: unknown; line?: unknown; lineText?: unknown; entry?: unknown };
	if (candidate.kind === 'toggle' && typeof candidate.line === 'number' && Number.isSafeInteger(candidate.line) && candidate.line >= 0
		&& typeof candidate.lineText === 'string' && candidate.lineText.length <= PARADIS_SPACE_NOTE_MAX_LENGTH) {
		return { kind: 'toggle', line: candidate.line, lineText: candidate.lineText };
	}
	if (candidate.kind === 'append' && typeof candidate.entry === 'string' && candidate.entry.length <= MAX_APPEND_LENGTH) {
		return { kind: 'append', entry: candidate.entry };
	}
	return undefined;
}

function noteReply(notes: IParadisSpaceNotesService, ws: string, conflict = false): IParadisMobileNoteReply {
	const entry = notes.readEntry(ws);
	return { t: 'note', ws, text: entry?.text ?? '', updatedAt: entry?.updatedAt ?? 0, ...(conflict ? { conflict: true as const } : {}) };
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
		const next = paradisApplySpaceNoteOp(notes.read(ws), op);
		if (next === undefined || next.length > PARADIS_SPACE_NOTE_MAX_LENGTH) {
			return noteReply(notes, ws, true);
		}
		notes.write(ws, next);
		return noteReply(notes, ws);
	}
	if (message.base !== undefined) {
		if (typeof message.base !== 'number' || !Number.isFinite(message.base)) {
			return { error: 'invalid base' };
		}
		if ((notes.readEntry(ws)?.updatedAt ?? 0) !== message.base) {
			return noteReply(notes, ws, true);
		}
	}
	notes.write(ws, message.text);
	return noteReply(notes, ws);
}
