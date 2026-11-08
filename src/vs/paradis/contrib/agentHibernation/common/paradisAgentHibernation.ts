/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 終わって放ってあるエージェントの休止（Orca の Agent sleep、G-03）の判断。
//
// 休止は、完了して見ていないエージェント（Claude Code / Codex）のプロセスだけを止め、シェルとタブは残す。
// 会話は CLI 側に残っているので、タブへ戻ったときに再開の帯（terminalResumeBanner）から同じ会話を続ける。
// ここは判断だけを持つ純関数で、止める・起こすのは electron-browser と shared process が受け持つ。

import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';

/** 休止を使うか（既定オフ・試験的）。 */
export const PARADIS_AGENT_HIBERNATION_ENABLED_SETTING = 'paradis.agentHibernation.enabled';
/** 完了してから休止するまでの分。 */
export const PARADIS_AGENT_HIBERNATION_IDLE_MINUTES_SETTING = 'paradis.agentHibernation.idleMinutes';

export const PARADIS_AGENT_HIBERNATION_DEFAULT_IDLE_MINUTES = 30;
export const PARADIS_AGENT_HIBERNATION_MIN_IDLE_MINUTES = 1;
export const PARADIS_AGENT_HIBERNATION_MAX_IDLE_MINUTES = 1440;

/** 休止の判断をやり直す間隔。 */
export const PARADIS_AGENT_HIBERNATION_TICK_MS = 60_000;
/** 止めるのを断られたペインを、もう一度試すまでの間。 */
export const PARADIS_AGENT_HIBERNATION_RETRY_MS = 10 * 60_000;
/** SIGTERM の後、まだ生きていれば SIGKILL を送るまでの間。 */
export const PARADIS_AGENT_HIBERNATION_KILL_GRACE_MS = 5_000;
/** 止めた所有者からの終わりの hook（SessionEnd）を捨てる間。 */
export const PARADIS_AGENT_HIBERNATION_HOOK_SUPPRESS_MS = 30_000;

/** 設定の分を、使える範囲のミリ秒にする。範囲外や数でないものは既定の 30 分。 */
export function paradisAgentHibernationIdleMs(value: unknown): number {
	const minutes = typeof value === 'number' && Number.isFinite(value)
		&& value >= PARADIS_AGENT_HIBERNATION_MIN_IDLE_MINUTES && value <= PARADIS_AGENT_HIBERNATION_MAX_IDLE_MINUTES
		? value : PARADIS_AGENT_HIBERNATION_DEFAULT_IDLE_MINUTES;
	return Math.round(minutes * 60_000);
}

/** 休止を決めるのに使う、1 つのペインについて分かっていること。 */
export interface IParadisHibernationPaneFacts {
	/** エディタ領域のターミナル（再開の帯はエディタのタブにだけ出る）。 */
	readonly editorArea: boolean;
	/** SSH などの接続先のウィンドウ・ペイン、または接続先の会話。 */
	readonly remote: boolean;
	/** タスクボードが受け持つターミナル。 */
	readonly taskBoard: boolean;
	/** すでに休止している。 */
	readonly hibernated: boolean;
	/** 止めている最中・再開している最中。 */
	readonly busy: boolean;
	/** 今の状態。undefined は状態なし（確認待ちを見た後の idle を含む）。 */
	readonly status: ParadisAgentStatus | undefined;
	/** 鳴らさない確認待ち（流し直した hook・裏の作業の完了で起きては止まる）。 */
	readonly quiet: boolean;
	/** 許可を拒否されて利用者の指示を待っている。 */
	readonly awaitingUser: boolean;
	/** 控えから流し直した確認が画面に出ているかを確かめている途中。 */
	readonly replayedPrompt: boolean;
	/** hook が控えた会話（Claude Code / Codex のものだけ）。 */
	readonly session: { readonly agent: 'claude' | 'codex'; readonly sessionId: string } | undefined;
	/** このウィンドウで見た、最後にターンが終わった時刻。見ていなければ undefined（会話が残っているか分からない）。 */
	readonly completedAt: number | undefined;
	/** いま画面に出ている（エディタのタブとして見えている）。 */
	readonly visible: boolean;
	/** 最後に画面に出ていた時刻。 */
	readonly lastVisibleAt: number | undefined;
	/** 最後にこのターミナルへ入力があった時刻。 */
	readonly lastInputAt: number | undefined;
	/** 送っていない打ちかけの入力がありうる（最後の入力が Enter で終わっていない）。 */
	readonly pendingDraft: boolean;
	/** いまスマホがこのターミナルを開いている。 */
	readonly remoteViewing: boolean;
	/** 最後にスマホが見ていた時刻。 */
	readonly lastRemoteViewAt: number | undefined;
	/** 止めるのを断られて、次に試してよい時刻。 */
	readonly retryAfter: number | undefined;
}

/** 休止しない理由（ログに出す）。 */
export type ParadisHibernationSkipReason =
	| 'not-editor-area' | 'remote' | 'task-board' | 'hibernated' | 'busy'
	| 'working' | 'permission' | 'question' | 'quiet' | 'awaiting-user' | 'replayed-prompt'
	| 'no-session' | 'completion-unknown' | 'visible' | 'remote-viewing' | 'draft' | 'retry-later';

export type ParadisHibernationVerdict =
	| { readonly kind: 'hibernate' }
	| { readonly kind: 'wait'; readonly dueAt: number }
	| { readonly kind: 'skip'; readonly reason: ParadisHibernationSkipReason };

/**
 * 休止してよいか。慎重な側に倒す: 分からないもの・利用者が関わっているかもしれないものは止めない。
 * 時間は、完了・最後に見た・最後の入力・スマホが最後に見た、のうち最も遅いものから数える。
 */
export function paradisHibernationVerdict(facts: IParadisHibernationPaneFacts, now: number, idleMs: number): ParadisHibernationVerdict {
	const skip = (reason: ParadisHibernationSkipReason): ParadisHibernationVerdict => ({ kind: 'skip', reason });
	if (!facts.editorArea) {
		return skip('not-editor-area');
	}
	if (facts.remote) {
		return skip('remote');
	}
	if (facts.taskBoard) {
		return skip('task-board');
	}
	if (facts.hibernated) {
		return skip('hibernated');
	}
	if (facts.busy) {
		return skip('busy');
	}
	if (facts.status === 'working' || facts.status === 'permission' || facts.status === 'question') {
		return skip(facts.status);
	}
	if (facts.quiet) {
		return skip('quiet');
	}
	if (facts.awaitingUser) {
		return skip('awaiting-user');
	}
	if (facts.replayedPrompt) {
		return skip('replayed-prompt');
	}
	if (facts.session === undefined) {
		return skip('no-session');
	}
	if (facts.completedAt === undefined) {
		return skip('completion-unknown');
	}
	if (facts.visible) {
		return skip('visible');
	}
	if (facts.remoteViewing) {
		return skip('remote-viewing');
	}
	if (facts.pendingDraft) {
		return skip('draft');
	}
	if (facts.retryAfter !== undefined && now < facts.retryAfter) {
		return skip('retry-later');
	}
	const since = Math.max(...[facts.completedAt, facts.lastVisibleAt, facts.lastInputAt, facts.lastRemoteViewAt]
		.map(value => typeof value === 'number' && Number.isFinite(value) ? value : 0));
	const dueAt = since + idleMs;
	return now >= dueAt ? { kind: 'hibernate' } : { kind: 'wait', dueAt };
}

/**
 * ターミナルへの入力 1 回分で、打ちかけの入力が残りうるかを更新する。
 * エスケープで始まる入力（端末の自動応答・フォーカスの知らせ・矢印キー）は文字として数えない。
 * Enter で終わる入力は送ったものとみなす。それ以外（文字・Backspace・Ctrl+C など）は打ちかけとみなす。
 */
export function paradisNextPendingDraft(previous: boolean, data: string): boolean {
	if (data.length === 0 || data.startsWith('\x1b')) {
		return previous;
	}
	return !/[\r\n]$/.test(data);
}

/** 入力が利用者の打鍵か（端末の自動応答・フォーカスの知らせは数えない）。 */
export function paradisIsUserTypedInput(data: string): boolean {
	return data.length > 0 && !/^\x1b\[(?:I|O|\d+;\d+R|\?[\d;]*c|>[\d;]*c)$/.test(data);
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'ash', 'pwsh', 'powershell', 'nu', 'xonsh']);

/**
 * 起動行の実行ファイルがシェルか。エージェントの配下にシェルが居るのは、Bash ツールのコマンドや裏で
 * 動かしているコマンド（`run_in_background`・Codex の exec の続き）が生きているということで、
 * エージェントを止めるとそれも止まる。
 */
export function paradisIsShellCommandLine(commandLine: string): boolean {
	const first = commandLine.trim().split(/\s+/, 1)[0] ?? '';
	const base = first.replace(/^-/, '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
	return SHELL_NAMES.has(base);
}

/** 起動行に、権限の確認を省く指定があるか（再開も同じにする）。 */
export function paradisCommandLineBypassesPermissions(commandLine: string): boolean {
	return /(?:^|\s)(?:--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo)(?:\s|=|$)/.test(commandLine)
		|| /(?:^|\s)--permission-mode(?:\s+|=)bypassPermissions(?:\s|$)/.test(commandLine);
}

/** shared process が止めるのを断った理由（ログに出す）。 */
export type ParadisHibernationRefusal =
	| 'not-eligible' | 'remote' | 'no-session' | 'session-changed' | 'status-changed' | 'awaiting-user'
	| 'no-owner' | 'owner-not-alive' | 'daemon-hosted' | 'outside-pane' | 'background-shell'
	| 'no-snapshot' | 'kill-failed';

/** `hibernatePane` の結果。 */
export type ParadisHibernationResult =
	| { readonly ok: true; readonly bypass: boolean; readonly killed: boolean }
	| { readonly ok: false; readonly reason: ParadisHibernationRefusal };

const REFUSALS: ReadonlySet<string> = new Set<ParadisHibernationRefusal>([
	'not-eligible', 'remote', 'no-session', 'session-changed', 'status-changed', 'awaiting-user',
	'no-owner', 'owner-not-alive', 'daemon-hosted', 'outside-pane', 'background-shell', 'no-snapshot', 'kill-failed',
]);

/** チャネル越しに受けた値を結果として読む。形が違えば断られた扱い。 */
export function paradisParseHibernationResult(value: unknown): ParadisHibernationResult {
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>;
		if (record.ok === true) {
			return { ok: true, bypass: record.bypass === true, killed: record.killed === true };
		}
		if (record.ok === false && typeof record.reason === 'string' && REFUSALS.has(record.reason)) {
			return { ok: false, reason: record.reason as ParadisHibernationRefusal };
		}
	}
	return { ok: false, reason: 'not-eligible' };
}
