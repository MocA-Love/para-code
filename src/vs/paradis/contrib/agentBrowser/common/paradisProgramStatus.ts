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
//
// 端末の出力はどのプログラムでも書ける（`cat` したファイル、`git log`、ssh の先の出力）。偽の状態でペインが
// 「許可待ち」や「完了」にならないよう、{@link ParadisProgramStatusGate} で受け付けを絞る:
//  1. 前面のコマンドが Claude Code（または中身を確かめられない ssh・WSL など）のときに来た問い合わせにだけ答え、
//     答えたペインでだけ状態を受ける。clear・前面のコマンドの終わり・長い無音で閉じる
//  2. 状態の変化を 1 秒に数回までに間引き、それより速く変わるペインはしばらく無視する
// ssh・WSL の先では前面のプログラムを確かめられないので、そこで偽の問い合わせと状態を書かれたら 2 の分しか防げない。

import { ParadisAgentStatus } from './paradisAgentBrowser.js';

/** OSC の番号。 */
export const PARADIS_PROGRAM_STATUS_OSC = 7501;

/** 問い合わせへの答え（`ESC ] 7501 ; ? ST`）。Claude Code は `?` で始まる 7501 の返事を「対応している」と読む。 */
export const PARADIS_PROGRAM_STATUS_REPLY = '\x1b]7501;?\x1b\\';

/** これより長い OSC 7501 の中身は読まない（Claude Code が書くのは題名 192 字・文 2048 字を base64 にした程度）。 */
export const PARADIS_PROGRAM_STATUS_MAX_DATA_LENGTH = 4096;

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
	if (data.length > PARADIS_PROGRAM_STATUS_MAX_DATA_LENGTH) {
		return undefined;
	}
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
	// 終わりの clear は app を付けない（Claude Code が端末の状態を戻すときにまとめて書く。2.1.295 で実測）。
	// app を求めると本物の clear を読めない。clear は状態を消すだけで、受け付けは問い合わせに答えたペインに限る
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

/** 前面のコマンドが何か（{@link paradisProgramStatusForeground}）。 */
export type ParadisProgramStatusForeground = 'claude' | 'passthrough';

/** 中身を確かめられない、別の機械やコンテナへ入るコマンド。この先の Claude Code の問い合わせにも答える。 */
const PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set(['ssh', 'autossh', 'mosh', 'et', 'wsl', 'wsl.exe', 'docker', 'podman', 'kubectl', 'gcloud', 'tmux', 'screen', 'zellij']);

function commandName(commandLine: string): string | undefined {
	const first = commandLine.trim().split(/\s+/)[0];
	if (!first) {
		return undefined;
	}
	const base = first.replace(/^.*[\\/]/, '').toLowerCase();
	return base.length > 0 ? base : undefined;
}

/**
 * 問い合わせが来たときの前面のコマンドから、答えてよいかを決める。シェル統合が報告した実行中のコマンド行と、
 * ターミナルのプロセス名（pty の前面のプロセス。出力では変えられない。ネイティブの Claude Code は版の番号になる）
 * を見る。どちらかが Claude Code か、中身を確かめられない ssh・WSL などなら答える。分からなければ答えない。
 *
 * `trustedCommandLine` には、シェル統合の nonce が合ったコマンド行（`isTrusted`）だけを渡すこと。出力に
 * `OSC 633 ; E` を書けば、nonce が合わなくてもコマンド行は上書きされる（信頼できない印が付くだけ）。
 */
export function paradisProgramStatusForeground(trustedCommandLine: string | undefined, processName: string | undefined): ParadisProgramStatusForeground | undefined {
	const names = [trustedCommandLine !== undefined ? commandName(trustedCommandLine) : undefined, processName !== undefined ? commandName(processName) : undefined];
	if (names.some(name => name === 'claude' || name === 'claude.exe' || (name !== undefined && /^\d+\.\d+\.\d+$/.test(name)))) {
		return 'claude';
	}
	if (names.some(name => name !== undefined && PASSTHROUGH_COMMANDS.has(name))) {
		return 'passthrough';
	}
	return undefined;
}

/**
 * シェル統合が報告している実行中のコマンド行のうち、nonce が合ったもの（{@link paradisProgramStatusForeground} へ渡してよいもの）。
 * 合っていない（`isTrusted` が true でない）なら undefined。
 */
export function paradisTrustedCommandLine(current: { readonly command?: string; readonly isTrusted?: boolean } | undefined): string | undefined {
	return current?.isTrusted === true ? current.command : undefined;
}

/** 答えた後、状態が来なくなってからも受け付けを開けておく長さ。 */
export const PARADIS_PROGRAM_STATUS_WINDOW_MS = 12 * 60 * 60 * 1000;
/** 1 秒に受ける状態の変化の上限。Claude Code の実際の変化は 1 ターンに数回。 */
export const PARADIS_PROGRAM_STATUS_MAX_CHANGES_PER_SECOND = 4;
/** 上限を超えたペインの状態を無視する長さ。 */
export const PARADIS_PROGRAM_STATUS_MUTE_MS = 60_000;

/**
 * 1 つのターミナルの OSC 7501 の受け付け。問い合わせに答えたときだけ開き、clear・{@link close}・
 * {@link PARADIS_PROGRAM_STATUS_WINDOW_MS} の無音で閉じる。開いている間の状態は、同じ状態の繰り返しを除き、
 * 1 秒に {@link PARADIS_PROGRAM_STATUS_MAX_CHANGES_PER_SECOND} 回まで通す。超えたら
 * {@link PARADIS_PROGRAM_STATUS_MUTE_MS} の間は何も通さない。
 */
export class ParadisProgramStatusGate {

	private openUntil: number | undefined;
	private mutedUntil = 0;
	private lastKey: string | undefined;
	private readonly changes: number[] = [];
	/** 間引きで捨てた最後の状態。無視が明けたら 1 回だけ渡す（working → done が速く続いても working で止まらない）。 */
	private pending: IParadisProgramStatus | undefined;

	constructor(private readonly now: () => number = Date.now) { }

	get isOpen(): boolean {
		return this.openUntil !== undefined && this.now() <= this.openUntil;
	}

	/** 問い合わせが来た。答えてよければ受け付けを開いて true。 */
	query(foreground: ParadisProgramStatusForeground | undefined): boolean {
		if (foreground === undefined) {
			return false;
		}
		this.openUntil = this.now() + PARADIS_PROGRAM_STATUS_WINDOW_MS;
		this.lastKey = undefined;
		this.pending = undefined;
		return true;
	}

	/** 間引きで捨てた状態があれば、それを渡してよくなる時刻。 */
	get pendingDueAt(): number | undefined {
		return this.pending !== undefined ? this.mutedUntil : undefined;
	}

	/** 無視が明けた後に呼ぶ。捨てた最後の状態を、まだ受け付けが開いていれば 1 回だけ返す。 */
	releasePending(): IParadisProgramStatus | undefined {
		const pending = this.pending;
		if (pending === undefined || this.now() < this.mutedUntil) {
			return undefined;
		}
		this.pending = undefined;
		return this.accept(pending) ? pending : undefined;
	}

	/** 状態が来た。shared process へ渡すなら true。 */
	accept(status: IParadisProgramStatus): boolean {
		const now = this.now();
		if (this.openUntil === undefined || now > this.openUntil) {
			this.openUntil = undefined;
			return false;
		}
		if (status.state === 'clear') {
			this.openUntil = undefined;
			this.lastKey = undefined;
			this.pending = undefined;
			return true;
		}
		if (now < this.mutedUntil) {
			this.pending = status;
			return false;
		}
		const key = `${status.state}:${status.kind ?? ''}`;
		if (key === this.lastKey) {
			this.openUntil = now + PARADIS_PROGRAM_STATUS_WINDOW_MS;
			return false;
		}
		while (this.changes.length > 0 && now - this.changes[0] >= 1000) {
			this.changes.shift();
		}
		if (this.changes.length >= PARADIS_PROGRAM_STATUS_MAX_CHANGES_PER_SECOND) {
			this.mutedUntil = now + PARADIS_PROGRAM_STATUS_MUTE_MS;
			this.changes.length = 0;
			this.pending = status;
			return false;
		}
		this.changes.push(now);
		this.lastKey = key;
		this.openUntil = now + PARADIS_PROGRAM_STATUS_WINDOW_MS;
		return true;
	}

	/** 前面のコマンドが終わった。開いていたら true（呼び出し側は状態を消す）。 */
	close(): boolean {
		const wasOpen = this.isOpen;
		this.openUntil = undefined;
		this.lastKey = undefined;
		this.pending = undefined;
		return wasOpen;
	}
}
