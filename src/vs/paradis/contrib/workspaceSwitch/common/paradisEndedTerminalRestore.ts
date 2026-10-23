/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 繋ぎ直せなかったターミナルが「なぜ」繋がらなかったかを、新しいシェルを起こす直前まで運ぶ。
//
// 繋ぎ直しは3か所に分かれている。スペースの保存状態から戻すタブの解決（`paradisTerminalEditorRevive.ts`）、
// pty host への番号の問い合わせ（`localTerminalBackend.ts` / `remoteTerminalBackend.ts` の
// `attachToRevivedProcess`）、失敗したので新しいシェルを起こす分岐（`terminalProcessManager.ts` →
// `paradisPrepareRestartedTerminalLaunch`）。3つは同じ端末の nonce で繋がるので、前の2つが分かった
// ことをここへ書き、最後の1つで読む。
//
// 読む側（`browser/paradisEndedTerminalRestore.contribution.ts`）は、終わっていたと確かめられた
// 端末のタブを空のシェルにせず閉じ、理由ごとの件数を送る。
//
// 書いたまま読まれない記録（繋ぎ直しに成功した等）は時間で捨てる。

import { PARADIS_ENDED_PTY_ID } from '../../../../platform/terminal/common/paradisEndedPty.js';
import { PARADIS_UNRESOLVABLE_PTY_ID, paradisTerminalIdentityNonce } from '../../../../platform/terminal/common/terminal.js';

/** 記録を残しておく時間。繋ぎ直しの往復と新しいシェルの準備が収まれば足りる。 */
const PARADIS_RESTORE_NOTE_TTL_MS = 2 * 60_000;
/** 記録の数の上限。読まれないまま溜まり続けないように。 */
const PARADIS_RESTORE_NOTE_LIMIT = 500;

/**
 * 新しいシェルになった理由。
 * - `ended`: 端末はもう終わっていた（pty host がそう答えた、または離れている間に終わったのを見ていた）
 * - `ambiguous`: 取り違えを避けるため、わざと繋がなかった
 * - `not-found`: 繋ごうとしたが見つからなかった（終わったとは言い切れない）
 */
export type ParadisRestartedTerminalReason = 'ended' | 'ambiguous' | 'not-found';

/** スペースの保存状態から戻したタブだったときの手がかり。 */
export interface IParadisWorkingSetReviveNote {
	readonly stateKey: string;
	/** 孤児の索引の問い合わせが締め切りで打ち切られていたか。 */
	readonly indexTimedOut: boolean;
	/** 離れている間に終わったのを見ていたので、pty host に聞かずに終わったと決めたか。 */
	readonly endedWhileAway?: boolean;
	/** 正体が決まらないので、わざと繋がないと決めたか。 */
	readonly ambiguous?: boolean;
}

export interface IParadisRestartedTerminalOutcome {
	readonly reason: ParadisRestartedTerminalReason;
	/** スペースの保存状態から戻したタブなら、その手がかり。 */
	readonly workingSet: IParadisWorkingSetReviveNote | undefined;
}

interface INote<T> {
	readonly value: T;
	readonly at: number;
}

const answers = new Map<string, INote<number | undefined>>();
const workingSetRevives = new Map<string, INote<IParadisWorkingSetReviveNote>>();

function remember<T>(notes: Map<string, INote<T>>, nonce: string, value: T, now: number): void {
	notes.delete(nonce);
	notes.set(nonce, { value, at: now });
	for (const [key, note] of notes) {
		if (notes.size <= PARADIS_RESTORE_NOTE_LIMIT && now - note.at <= PARADIS_RESTORE_NOTE_TTL_MS) {
			break;
		}
		notes.delete(key);
	}
}

function take<T>(notes: Map<string, INote<T>>, nonce: string, now: number): T | undefined {
	const note = notes.get(nonce);
	notes.delete(nonce);
	return note !== undefined && now - note.at <= PARADIS_RESTORE_NOTE_TTL_MS ? note.value : undefined;
}

/**
 * pty host が `getRevivedPtyNewId` に返した答えを控える。答えはそのまま返すので、呼び出しを包むだけでよい。
 */
export function paradisNoteRevivedPtyAnswer(nonce: string | undefined, answer: number | undefined, now = Date.now()): number | undefined {
	const identity = paradisTerminalIdentityNonce(nonce);
	if (identity !== undefined) {
		remember(answers, identity, answer, now);
	}
	return answer;
}

/** スペースの保存状態から戻すタブを、どの nonce で繋ぎに行くかを控える。 */
export function paradisNoteWorkingSetRevive(nonce: string | undefined, note: IParadisWorkingSetReviveNote, now = Date.now()): void {
	const identity = paradisTerminalIdentityNonce(nonce);
	if (identity !== undefined) {
		remember(workingSetRevives, identity, note, now);
	}
}

/**
 * 新しいシェルを起こす直前に呼ぶ。控えてあった答えを読んで消し、理由を決める。
 *
 * `ended` にするのは、pty host が「終わっている」と言い切ったか、離れている間に終わったのを
 * 見ていたときだけ。索引の打ち切りや、答えが無い（古い pty host・問い合わせ前に失敗）ときは
 * `not-found` で、タブは今まで通り新しいシェルで開く。
 */
export function paradisTakeRestartedTerminalOutcome(nonce: string | undefined, now = Date.now()): IParadisRestartedTerminalOutcome {
	const identity = paradisTerminalIdentityNonce(nonce);
	if (identity === undefined) {
		return { reason: 'not-found', workingSet: undefined };
	}
	const hasAnswer = answers.has(identity);
	const answer = take(answers, identity, now);
	const workingSet = take(workingSetRevives, identity, now);
	if (workingSet?.endedWhileAway || (hasAnswer && answer === PARADIS_ENDED_PTY_ID)) {
		return { reason: 'ended', workingSet };
	}
	if (workingSet?.ambiguous || (hasAnswer && answer === PARADIS_UNRESOLVABLE_PTY_ID)) {
		return { reason: 'ambiguous', workingSet };
	}
	return { reason: 'not-found', workingSet };
}

/** テスト用。 */
export function paradisResetEndedTerminalRestoreNotes(): void {
	answers.clear();
	workingSetRevives.clear();
}
