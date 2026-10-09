/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code の Program Status Protocol（OSC 7501、2.1.295 から）の読み取り。
//
// Claude Code は起動時に `ESC ] 7501 ; ? ST` で端末に問い合わせ、答えが返ったときだけ、作業の状態を
// `ESC ] 7501 ; state=<状態>:app=claude-code[:id=…][:kind=…][:progress=…][:title=<base64>][:msg=<base64>] ST`
// で書く（答えなければ何も書かない）。2.1.295 を PTY で実測した値（2026-10-09）:
//   起動       → state=idle
//   作業中     → state=working（道具の説明が付くと msg）
//   許可待ち   → state=blocked:kind=permission:msg=「approve Bash: …」
//   質問中     → state=blocked:kind=question:msg=「answer: …」（AskUserQuestion）
//   ターン完了 → state=done
//   終了       → state=clear（id 無しは全部を消す）
// CLI のコードでは、ほかに state=error（失敗で終わった）、kind=auth（認証が要る）、kind 無しの blocked
// （ダイアログが開いている）がある。`id` の付いた行はサブエージェントや背景の作業の状態で、会話そのもの
// （id 無し）とは別に並ぶ。
//
// Para Code は hook が届かないペイン（WSL、手で ssh した先、hook のトンネルが無い接続先など）の状態の
// 補助にだけ使う。hook が届いたペインは hook のまま（{@link paradisProgramStatusApplies}）。

import { ParadisAgentStatus } from './paradisAgentBrowser.js';

/** OSC の番号。 */
export const PARADIS_PROGRAM_STATUS_OSC = 7501;

/** 問い合わせへの答え（`ESC ] 7501 ; ? ST`）。Claude Code は `?` で始まる 7501 の返事を「対応している」と読む。 */
export const PARADIS_PROGRAM_STATUS_REPLY = '\x1b]7501;?\x1b\\';

/** Claude Code が書く状態のうち、Para Code が読むもの。 */
export type ParadisProgramState = 'working' | 'blocked' | 'done' | 'idle' | 'error' | 'clear';

export interface IParadisProgramStatus {
	readonly state: ParadisProgramState;
	/** blocked の理由（permission / question / auth）。 */
	readonly kind?: string;
}

const PROGRAM_STATES: ReadonlySet<string> = new Set<ParadisProgramState>(['working', 'blocked', 'done', 'idle', 'error', 'clear']);

/**
 * OSC 7501 の中身（`7501;` の後ろ）を読む。問い合わせなら 'query'、会話そのもの（id 無し）の Claude Code の
 * 状態ならその状態、それ以外（サブエージェントの行、別のアプリ、知らない状態）は undefined。
 */
export function paradisParseProgramStatus(data: string): IParadisProgramStatus | 'query' | undefined {
	if (data.startsWith('?')) {
		return 'query';
	}
	const fields = new Map<string, string>();
	for (const part of data.split(':')) {
		const equals = part.indexOf('=');
		if (equals > 0) {
			fields.set(part.slice(0, equals), part.slice(equals + 1));
		}
	}
	const state = fields.get('state');
	if (state === undefined || !PROGRAM_STATES.has(state)) {
		return undefined;
	}
	// 終わりの clear は app を付けない（Claude Code が端末の状態を戻すときにまとめて書く）
	if (state === 'clear') {
		return fields.has('id') ? undefined : { state: 'clear' };
	}
	if (fields.get('app') !== 'claude-code' || fields.has('id')) {
		return undefined;
	}
	const kind = fields.get('kind');
	return { state: state as ParadisProgramState, ...(kind !== undefined && kind.length > 0 ? { kind } : {}) };
}

/** IPC で受けた値を確かめて写す（renderer から shared process へ渡すとき）。形が違えば undefined。 */
export function paradisCopyProgramStatus(value: unknown): IParadisProgramStatus | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { state, kind } = value as { state?: unknown; kind?: unknown };
	if (typeof state !== 'string' || !PROGRAM_STATES.has(state)) {
		return undefined;
	}
	const safeKind = typeof kind === 'string' && /^[a-z_-]{1,32}$/.test(kind) ? kind : undefined;
	return { state: state as ParadisProgramState, ...(safeKind !== undefined ? { kind: safeKind } : {}) };
}

/**
 * OSC の状態を Para Code のペインの状態へ写す。'idle' は状態を消す（hook の idle と同じ）。
 * blocked は質問だけを question にし、ほか（許可・認証・ダイアログ）は利用者の操作を待つ permission にする。
 * done と error は、hook の Stop・StopFailure と同じく review にする。
 */
export function paradisProgramStatusToAgentStatus(status: IParadisProgramStatus): ParadisAgentStatus | 'idle' {
	switch (status.state) {
		case 'working':
			return 'working';
		case 'blocked':
			return status.kind === 'question' ? 'question' : 'permission';
		case 'done':
		case 'error':
			return 'review';
		case 'idle':
		case 'clear':
			return 'idle';
	}
}

/**
 * OSC の状態をペインの状態に使ってよいか。そのペインに hook が一度でも届いていれば使わない（hook が
 * 正本。両方を使うと同じ遷移を二度数え、届く順の差で状態が行き来する）。
 */
export function paradisProgramStatusApplies(hookReported: boolean): boolean {
	return !hookReported;
}
