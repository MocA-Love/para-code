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
//
// Codex も 0.163.0 から、問い合わせ無しで `state=idle|working|blocked:app=codex` を書く（終わり・端末を外部の
// プログラムに渡すとき・一時停止で app の無い `state=clear`）。2026-10-16 に 0.163.0 を PTY で実測した値:
//   起動・再開   → working の後すぐ idle（依頼の前にも出る）
//   作業中       → working（作業中の発言で応答を打ち切っても、同じターンのまま working が続く）
//   許可待ち     → blocked（kind も msg も無い）。答えると working
//   ターン完了   → idle（題名を作るために、もう一度 working → idle が続くことがある）
//   `/exit`      → clear
// `done` と `kind` が無いので、完了と、許可と質問の区別は取れない。問い合わせが無いので、前面のコマンドが Codex
// （か ssh・WSL など）のときに届いた状態で受け付けを開く。hook も transcript も無いペインの作業中・許可待ちの補助にだけ使う
// （{@link paradisCodexProgramStatusTransition}）。0.162.1 以前は書かないので、この読み取りでは何も変わらない。

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
	/** Codex が書いた状態（`app=codex`。Codex の受け付けで届いた clear にも付ける）。Claude Code の状態には付けない。 */
	readonly app?: 'codex';
}

const PROGRAM_STATES: ReadonlySet<string> = new Set<ParadisProgramState>(['working', 'blocked', 'done', 'idle', 'error', 'clear']);

/** `key=value` を `:` で並べた中身を読む。 */
function programStatusFields(data: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const part of data.split(':')) {
		const equals = part.indexOf('=');
		if (equals > 0) {
			fields.set(part.slice(0, equals), part.slice(equals + 1));
		}
	}
	return fields;
}

/**
 * OSC 7501 の中身（`7501;` の後ろ）を読む。問い合わせなら 'query'、会話そのもの（id 無し）の Claude Code・Codex の
 * 状態ならその状態（Codex は `app: 'codex'` 付き）、それ以外（サブエージェントの行、別のアプリ、知らない状態）は undefined。
 */
export function paradisParseProgramStatus(data: string): IParadisProgramStatus | 'query' | undefined {
	if (data.length > PARADIS_PROGRAM_STATUS_MAX_DATA_LENGTH) {
		return undefined;
	}
	if (data.startsWith('?')) {
		return 'query';
	}
	const fields = programStatusFields(data);
	const state = fields.get('state');
	if (state === undefined || !PROGRAM_STATES.has(state)) {
		return undefined;
	}
	// 終わりの clear は app を付けない（Claude Code が端末の状態を戻すときにまとめて書く。2.1.295 で実測）。
	// app を求めると本物の clear を読めない。clear は状態を消すだけで、受け付けは問い合わせに答えたペインに限る
	if (state === 'clear') {
		return fields.has('id') ? undefined : { state: 'clear' };
	}
	const app = fields.get('app');
	if ((app !== 'claude-code' && app !== 'codex') || fields.has('id')) {
		return undefined;
	}
	const kind = fields.get('kind');
	return { state: state as ParadisProgramState, ...(kind !== undefined && kind.length > 0 ? { kind } : {}), ...(app === 'codex' ? { app } : {}) };
}

/** {@link paradisParseProgramStatus} が読まなかった理由。 */
export type ParadisProgramStatusDropReason =
	/** 4 KiB を超える。 */
	| 'too-long'
	/** `state=` が無い。 */
	| 'no-state'
	/** Para Code の知らない状態（Claude Code の新しい版が足した状態かもしれない）。 */
	| 'unknown-state'
	/** サブエージェントの行（`id=` 付き）。 */
	| 'subagent'
	/** Claude Code・Codex 以外のアプリが書いたもの。 */
	| 'other-app';

/**
 * {@link paradisParseProgramStatus} が undefined を返した中身の、読まなかった理由（Sentry で件数を数えるため）。
 * 読める中身（問い合わせ・状態）なら undefined。`unknownState` は、知らない状態の名前が送ってよい形
 * （小文字の語）のときだけ返す。
 */
export function paradisProgramStatusDropReason(data: string): { readonly reason: ParadisProgramStatusDropReason; readonly unknownState?: string } | undefined {
	if (data.length > PARADIS_PROGRAM_STATUS_MAX_DATA_LENGTH) {
		return { reason: 'too-long' };
	}
	if (paradisParseProgramStatus(data) !== undefined) {
		return undefined;
	}
	const fields = programStatusFields(data);
	const state = fields.get('state');
	if (state === undefined) {
		return { reason: 'no-state' };
	}
	if (!PROGRAM_STATES.has(state)) {
		return { reason: 'unknown-state', ...(/^[a-z_]{1,24}$/.test(state) ? { unknownState: state } : {}) };
	}
	return fields.has('id') ? { reason: 'subagent' } : { reason: 'other-app' };
}

/** IPC で受けた値を確かめて写す（renderer から shared process へ渡すとき）。形が違えば undefined。 */
export function paradisCopyProgramStatus(value: unknown): IParadisProgramStatus | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { state, kind, app } = value as { state?: unknown; kind?: unknown; app?: unknown };
	if (typeof state !== 'string' || !PROGRAM_STATES.has(state)) {
		return undefined;
	}
	const safeKind = typeof kind === 'string' && /^[a-z_-]{1,32}$/.test(kind) ? kind : undefined;
	return { state: state as ParadisProgramState, ...(safeKind !== undefined ? { kind: safeKind } : {}), ...(app === 'codex' ? { app: 'codex' as const } : {}) };
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
 * Codex の OSC の状態で、ペインの状態をどう変えるか（変えないなら undefined、'idle' は状態を消す）。hook が届いた
 * ペインでは呼ばない（{@link paradisProgramStatusApplies}）。Codex の状態には完了も許可・質問の区別も無いので、
 * ほかの出どころを上書きしない補助にとどめる:
 * - blocked は、許可待ち・質問中でなければ許可待ち（permission）にする。質問中は transcript が知らせたものなので残す
 * - 許可待ち・質問中の後の working は、答えて作業に戻った。idle・clear は、断った・取り消した（完了ではない）
 * - それ以外の working と idle・clear は、transcript がターンの始まりと終わりを知らせていない（`transcriptBacked` でない）
 *   ペインでだけ使う。終わりは完了と区別できないので、確認待ち（review）にはせず状態を消す（起動・再開の直後にも
 *   working → idle が来るので、review にすると何もしていないのに「完了」が出る）
 */
export function paradisCodexProgramStatusTransition(previous: ParadisAgentStatus | undefined, state: ParadisProgramState, transcriptBacked: boolean): ParadisAgentStatus | 'idle' | undefined {
	const waiting = previous === 'permission' || previous === 'question';
	switch (state) {
		case 'blocked':
			return waiting ? undefined : 'permission';
		case 'working':
			return waiting || (!transcriptBacked && previous !== 'working') ? 'working' : undefined;
		case 'idle':
		case 'clear':
			return waiting || (!transcriptBacked && previous === 'working') ? 'idle' : undefined;
		case 'done':
		case 'error':
			// Codex は書かない（書くようになっても、どのターンの完了かを確かめられないので使わない）
			return undefined;
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

function isCodexName(name: string | undefined): boolean {
	return name !== undefined && /^codex(?:\.exe|\.cmd)?$/.test(name);
}

/**
 * 問い合わせ無しで届いた Codex の状態で、受け付けを開いてよいか。シェル統合の nonce が合ったコマンド行か
 * ターミナルのプロセス名が Codex か、中身を確かめられない ssh・WSL などなら開く（npm 版の Codex はプロセス名が
 * `node` になるので、コマンド行で見分ける）。`trustedCommandLine` の約束は {@link paradisProgramStatusForeground} と同じ。
 */
export function paradisCodexProgramStatusForeground(trustedCommandLine: string | undefined, processName: string | undefined): boolean {
	const names = [trustedCommandLine !== undefined ? commandName(trustedCommandLine) : undefined, processName !== undefined ? commandName(processName) : undefined];
	return names.some(name => isCodexName(name) || (name !== undefined && PASSTHROUGH_COMMANDS.has(name)));
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

/** 前面に戻ってきたら、Claude Code が終わったと見なすシェル。npm 版の Claude Code の `node` は含めない。 */
const KNOWN_SHELLS: ReadonlySet<string> = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'fish', 'nu', 'xonsh', 'elvish', 'pwsh', 'powershell', 'cmd']);

/**
 * 前面のプロセス名（pty が報告する題名。`/path/to/claude --resume` のような形でも来る）が変わったときに、
 * 受け付けを閉じるか。既知のシェルに戻ったら、シェル統合の有無によらず閉じる（Claude Code が落ちて
 * 「Relaunch Terminal」で同じターミナルに新しいシェルが立つと、シェル統合のコマンドの終わりが来ない）。
 * シェル統合が無いターミナルは、Claude Code でも Codex でも ssh などでもなくなったら閉じる。
 */
export function paradisProgramStatusClosesOnForeground(hasShellIntegration: boolean, processTitle: string | undefined): boolean {
	const name = processTitle !== undefined ? commandName(processTitle)?.replace(/^-/, '').replace(/\.exe$/, '') : undefined;
	if (name !== undefined && KNOWN_SHELLS.has(name)) {
		return true;
	}
	return !hasShellIntegration && paradisProgramStatusForeground(undefined, processTitle) === undefined && !isCodexName(name);
}

/**
 * 前面のプロセスの題名が Claude Code そのもの（`claude` か、ネイティブ版の版の番号）なら、その名前。Ctrl+Z で止めた
 * Claude Code が `fg` で戻ったと見なす印に使う（2.1.295 は `fg` の後に問い合わせ直さない。PTY で実測）。
 * npm 版の `node` のように、ほかのプログラムと区別できない名前は undefined。
 */
export function paradisClaudeProcessIdentity(processTitle: string | undefined): string | undefined {
	const name = processTitle !== undefined ? commandName(processTitle) : undefined;
	return name !== undefined && (name === 'claude' || name === 'claude.exe' || /^\d+\.\d+\.\d+$/.test(name)) ? name : undefined;
}

/** 前面のプロセスの種類（Sentry で、問い合わせに答えなかった理由を数えるため。プロセスの名前そのものは送らない）。 */
export type ParadisProgramStatusProcessKind = 'claude' | 'passthrough' | 'node' | 'shell' | 'other' | 'none';

/** 前面のプロセスの題名を {@link ParadisProgramStatusProcessKind} に畳む。`node` は npm 版の Claude Code がこう見える。 */
export function paradisProgramStatusProcessKind(processTitle: string | undefined): ParadisProgramStatusProcessKind {
	const name = processTitle !== undefined ? commandName(processTitle)?.replace(/^-/, '').replace(/\.exe$/, '') : undefined;
	if (name === undefined) {
		return 'none';
	}
	if (paradisClaudeProcessIdentity(processTitle) !== undefined) {
		return 'claude';
	}
	if (PASSTHROUGH_COMMANDS.has(name)) {
		return 'passthrough';
	}
	if (name === 'node') {
		return 'node';
	}
	return KNOWN_SHELLS.has(name) ? 'shell' : 'other';
}

/** シェル統合が報告したコマンドの終わりが、Ctrl+Z で止めたもの（128 + SIGTSTP。macOS は 18、Linux は 20）か。 */
export function paradisIsSuspendedExitCode(exitCode: number | undefined): boolean {
	return exitCode === 146 || exitCode === 148;
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
	/** Ctrl+Z で止めた Claude Code（題名）。同じ題名が前面に戻ったら、問い合わせ無しで受け付けを開き直す。 */
	private held: { readonly identity: string; readonly until: number } | undefined;
	private _app: 'claude-code' | 'codex' | undefined;

	constructor(private readonly now: () => number = Date.now) { }

	get isOpen(): boolean {
		return this.openUntil !== undefined && this.now() <= this.openUntil;
	}

	/** 最後に受け付けを開いた相手（閉じた後も残す。閉じたときに送る clear を、どちらの状態か分けるため）。 */
	get app(): 'claude-code' | 'codex' | undefined {
		return this._app;
	}

	/** 問い合わせが来た。答えてよければ受け付けを Claude Code 用に開いて true。 */
	query(foreground: ParadisProgramStatusForeground | undefined): boolean {
		if (foreground === undefined) {
			return false;
		}
		this.open('claude-code');
		return true;
	}

	/**
	 * 問い合わせ無しで Codex の状態が届いた。受け付けが開いていなくて、前面が Codex か ssh などなら（`foreground`）、
	 * Codex 用に開いて true。Claude Code 用に開いている間は開き直さない（Claude Code の受け付けは clear で閉じる）。
	 */
	openForCodex(foreground: boolean): boolean {
		if (!foreground || this.isOpen) {
			return false;
		}
		this.open('codex');
		return true;
	}

	private open(app: 'claude-code' | 'codex'): void {
		this.openUntil = this.now() + PARADIS_PROGRAM_STATUS_WINDOW_MS;
		this.lastKey = undefined;
		this.pending = undefined;
		this.held = undefined;
		this._app = app;
	}

	/**
	 * 前面から Claude Code が外れたが、Ctrl+Z で止めただけかもしれない。開いていれば閉じて、`identity` の題名が
	 * 戻るのを待つ（{@link resume}）。閉じたら true（呼び出し側は状態を消す）。
	 */
	suspend(identity: string): boolean {
		if (!this.isOpen) {
			return false;
		}
		this.openUntil = undefined;
		this.lastKey = undefined;
		this.pending = undefined;
		this.held = { identity, until: this.now() + PARADIS_PROGRAM_STATUS_WINDOW_MS };
		return true;
	}

	/** 止めた Claude Code と同じ題名が前面に戻った。待っていれば受け付けを開き直して true。 */
	resume(identity: string): boolean {
		const held = this.held;
		if (held === undefined || held.identity !== identity || this.now() > held.until) {
			return false;
		}
		this.held = undefined;
		this.openUntil = this.now() + PARADIS_PROGRAM_STATUS_WINDOW_MS;
		this.lastKey = undefined;
		this._app = 'claude-code';
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
		// 開いた相手と違うアプリの状態は通さない（app の無い clear はどちらでも通す）
		if (status.state !== 'clear' && (status.app ?? 'claude-code') !== this._app) {
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
		this.held = undefined;
		return wasOpen;
	}
}

/** {@link ParadisProgramStatusTracker.receive} の結果。 */
export interface IParadisProgramStatusReceipt {
	/** 問い合わせ無しの Codex の状態で、受け付けを Codex 用に開いた。 */
	readonly reopened: boolean;
	/** 状態を受ける直前に受け付けが開いていたか（開き直した分を含む）。 */
	readonly wasOpen: boolean;
	/** shared process へ渡す状態。渡さないなら undefined。Codex の受け付けで届いた clear には `app: 'codex'` を付ける。 */
	readonly send: IParadisProgramStatus | undefined;
}

/** 受け付けの変化を受けて、呼び出し側がすること。'clear' は shared process へ状態を消す知らせを送る。 */
export type ParadisProgramStatusEffect = 'clear' | undefined;

/**
 * 1 つのターミナルの OSC 7501 の受け付けと、Ctrl+Z の保留の判断（入出力を持たない。contribution が呼ぶ）。
 *
 * - 受け付けが開いている間に Claude Code が前面から外れたら（シェルの題名に戻る・SIGTSTP で終わったコマンド）、
 *   開いたときの Claude Code の題名で保留にする。同じ題名が前面に戻ったら開き直す（2.1.295 は `fg` の後に問い合わせ直さない）
 * - 保留の間に打ったコマンド（`git status` など）が終わっても、保留は消さない。保留を消すのは、プロセスの終了・
 *   12 時間の経過・新しい問い合わせだけ
 * - 受け付けが開いている間に、ほかの終わり方（0 などの終了コード）でコマンドが終われば閉じる
 */
export class ParadisProgramStatusTracker {

	/** 受け付けを開いた Claude Code の題名。答えた時点の題名がまだシェルのことがあるので、開いている間に埋める。 */
	private openedBy: string | undefined;

	constructor(readonly gate: ParadisProgramStatusGate = new ParadisProgramStatusGate()) { }

	/** 問い合わせが来た。答えるなら true。 */
	query(trustedCommandLine: string | undefined, processTitle: string | undefined): boolean {
		if (!this.gate.query(paradisProgramStatusForeground(trustedCommandLine, processTitle))) {
			return false;
		}
		this.openedBy = paradisClaudeProcessIdentity(processTitle);
		return true;
	}

	/** 問い合わせ無しで Codex の状態が届いた。受け付けを Codex 用に開いたら true。 */
	codexStatus(trustedCommandLine: string | undefined, processTitle: string | undefined): boolean {
		if (!this.gate.openForCodex(paradisCodexProgramStatusForeground(trustedCommandLine, processTitle))) {
			return false;
		}
		this.openedBy = undefined;
		return true;
	}

	/**
	 * 状態が届いた。Codex の状態なら、受け付けを確かめる前に Codex 用に開けるかを見る（問い合わせが無いので、
	 * 先に開かないと最初の状態を捨てる）。clear は受け付けで閉じる前に相手を読み、Codex のものなら印を付けて渡す。
	 */
	receive(status: IParadisProgramStatus, trustedCommandLine: string | undefined, processTitle: string | undefined): IParadisProgramStatusReceipt {
		const reopened = status.app === 'codex' && !this.gate.isOpen && this.codexStatus(trustedCommandLine, processTitle);
		const wasOpen = this.gate.isOpen;
		const codexClear = status.state === 'clear' && this.gate.app === 'codex';
		if (!this.gate.accept(status)) {
			return { reopened, wasOpen, send: undefined };
		}
		return { reopened, wasOpen, send: codexClear ? { state: 'clear', app: 'codex' } : status };
	}

	/** pty の前面のプロセスの題名が変わった。 */
	foregroundChanged(processTitle: string | undefined, hasShellIntegration: boolean): ParadisProgramStatusEffect {
		const identity = paradisClaudeProcessIdentity(processTitle);
		if (this.gate.isOpen) {
			if (this.openedBy === undefined && identity !== undefined && this.gate.app === 'claude-code') {
				this.openedBy = identity;
			}
			// シェルへ戻ったのは、終わったのか Ctrl+Z で止めたのか分からない。止めた場合に備えて保留にする
			if (paradisProgramStatusClosesOnForeground(hasShellIntegration, processTitle)) {
				return this.leave(true);
			}
			return undefined;
		}
		if (identity !== undefined && identity === this.openedBy) {
			this.gate.resume(identity);
		}
		return undefined;
	}

	/** シェル統合がコマンドの終わりを報告した。受け付けが閉じて保留だけがある間は何もしない。 */
	commandFinished(exitCode: number | undefined): ParadisProgramStatusEffect {
		if (!this.gate.isOpen) {
			return undefined;
		}
		return this.leave(paradisIsSuspendedExitCode(exitCode));
	}

	/** プロセスが終わった（「Relaunch Terminal」で立て直す場合も）。保留も消す。 */
	processExited(): ParadisProgramStatusEffect {
		this.openedBy = undefined;
		return this.gate.close() ? 'clear' : undefined;
	}

	private leave(maybeSuspended: boolean): ParadisProgramStatusEffect {
		if (maybeSuspended && this.openedBy !== undefined) {
			return this.gate.suspend(this.openedBy) ? 'clear' : undefined;
		}
		this.openedBy = undefined;
		return this.gate.close() ? 'clear' : undefined;
	}
}
