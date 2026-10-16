/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// OSC 7501（Claude Code の Program Status Protocol）が働かなかったことを Sentry で読めるようにする。
//
// 答えなかった問い合わせ・捨てた状態・shared process へ渡せなかった状態は、これまでログにも残らなかった。
// 問い合わせ 1 回につき `para.programStatus.query`、受け付けが閉じるたびに `para.programStatus.run` の span を
// 1 件送る（エラーにはしない。span の枠は月 500 万件で、エラーの 5,000 件とは別）。
//
// 送るのは決まった語・回数・ミリ秒と、Claude Code の版の番号（`2.1.295` の形のときだけ）。コマンド行、
// プロセスの名前、題名、文は送らない。キー名には Sentry のサーバー側で値を消す語
// （terminal・command・session・token・env など）を含めない。

import { isParadisSentryScrubbedWord, ParadisSpanAttributes, runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisProgramStatusDropReason, ParadisProgramStatusForeground, ParadisProgramStatusProcessKind, paradisClaudeProcessIdentity } from './paradisProgramStatus.js';

/** 受け付けが閉じた理由。 */
export type ParadisProgramStatusRunEnd =
	/** Claude Code が clear を書いた。 */
	| 'clear-status'
	/** シェル統合がコマンドの終わりを報告した（Ctrl+Z の保留も含む）。`command` は Sentry が値ごと消す語なので使わない。 */
	| 'shell-end'
	/** プロセスが終わった。 */
	| 'process-exit'
	/** 前面のプロセスがシェルなどに戻った。 */
	| 'foreground'
	/** 開いている間に新しい問い合わせが来た。 */
	| 'requery'
	/** 問い合わせ無しの Codex の状態で、受け付けを開き直した（前の受け付けの後に数えた件数を送る）。 */
	| 'reopened'
	/** ターミナルが閉じた。 */
	| 'disposed';

/** 前面のプロセスの題名が Claude Code の版の番号なら、それ（ネイティブ版はこう見える）。 */
export function paradisProgramStatusCliVersion(processTitle: string | undefined): string | undefined {
	const identity = paradisClaudeProcessIdentity(processTitle);
	return identity !== undefined && /^\d+\.\d+\.\d+$/.test(identity) ? identity : undefined;
}

/** 問い合わせ 1 回の値。 */
export interface IParadisProgramStatusQuery {
	readonly answered: boolean;
	readonly foreground: ParadisProgramStatusForeground | undefined;
	readonly processKind: ParadisProgramStatusProcessKind;
	/** シェル統合の nonce が合ったコマンド行があったか（中身は送らない）。 */
	readonly cmdlineTrusted: boolean;
	readonly shellIntegration: boolean;
	readonly cliVersion: string | undefined;
}

export function paradisProgramStatusQueryAttributes(query: IParadisProgramStatusQuery): ParadisSpanAttributes {
	return {
		safe_answered: query.answered,
		safe_foreground_kind: query.foreground ?? 'none',
		safe_process_kind: query.processKind,
		safe_cmdline_trusted: query.cmdlineTrusted,
		safe_shell_integration: query.shellIntegration,
		...(query.cliVersion !== undefined ? { safe_cli_version: query.cliVersion } : {}),
	};
}

/**
 * 1 つのターミナルの、受け付けを開いてから閉じるまでの件数。閉じたときに {@link take} で span の値にする。
 * 閉じた後に届いた状態（受け付けを早く閉じすぎた疑い）は、次に閉じたとき、またはターミナルが閉じたときに数える。
 */
export class ParadisProgramStatusRunStats {

	private openedAt: number | undefined;
	/** 一度でも問い合わせに答えたか。答えていないターミナルに届いた状態は、Claude Code 以外の出力なので数えない。 */
	private everOpened = false;
	private cliVersion: string | undefined;
	/** 受け付けを開いた相手。 */
	private app: 'claude-code' | 'codex' | undefined;
	private sent = 0;
	private applied = 0;
	private muted = 0;
	private gateClosed = 0;
	private unknownStates = 0;
	private unknownStateName: string | undefined;
	private tooLong = 0;
	private ignored = 0;
	private unbound = 0;
	private ipcFailures = 0;

	constructor(private readonly now: () => number = Date.now) { }

	/** 受け付けを開いた（問い合わせに答えた、Ctrl+Z の後に開き直した、Codex の状態が届いた）。 */
	opened(cliVersion: string | undefined, app: 'claude-code' | 'codex' = 'claude-code'): void {
		this.openedAt = this.now();
		this.everOpened = true;
		this.app = app;
		this.noteCliVersion(cliVersion);
	}

	noteCliVersion(cliVersion: string | undefined): void {
		if (cliVersion !== undefined) {
			this.cliVersion = cliVersion;
		}
	}

	/** shared process へ状態を渡した（clear は数えない）。 */
	noteSent(): void {
		this.sent++;
	}

	/** shared process がペインの状態を書き換えた。 */
	noteApplied(): void {
		this.applied++;
	}

	/** 1 秒に送れる回数を超えて、無視する間に届いた。 */
	noteMuted(): void {
		this.muted++;
	}

	/** 受け付けが閉じた後に届いた。 */
	noteGateClosed(): void {
		if (this.everOpened) {
			this.gateClosed++;
		}
	}

	/** 受け付けが開いている間に、読まなかった中身が届いた。 */
	noteDropped(reason: ParadisProgramStatusDropReason, unknownState: string | undefined): void {
		switch (reason) {
			case 'unknown-state':
			case 'no-state':
				this.unknownStates++;
				// Sentry が値ごと消す語を含む名前は送らない（件数だけ残す）
				if (unknownState !== undefined && !isParadisSentryScrubbedWord(unknownState)) {
					this.unknownStateName ??= unknownState;
				}
				break;
			case 'too-long':
				this.tooLong++;
				break;
			default:
				this.ignored++;
		}
	}

	/** ペインの識別子が無く、送らずに捨てた。 */
	noteUnbound(): void {
		this.unbound++;
	}

	/** shared process への IPC が失敗した。 */
	noteIpcFailure(): void {
		this.ipcFailures++;
	}

	/** 開いているか、何か数えたか（送るものがあるか）。 */
	get hasData(): boolean {
		return this.openedAt !== undefined || this.sent + this.applied + this.muted + this.gateClosed + this.unknownStates + this.tooLong + this.ignored + this.unbound + this.ipcFailures > 0;
	}

	/** 閉じたときの値。開いておらず何も数えていなければ undefined。数えた値は戻す。 */
	take(endedBy: ParadisProgramStatusRunEnd): ParadisSpanAttributes | undefined {
		if (!this.hasData) {
			return undefined;
		}
		const attributes: ParadisSpanAttributes = {
			safe_ended_by: endedBy,
			...(this.openedAt !== undefined ? { safe_open_ms: Math.max(0, this.now() - this.openedAt) } : {}),
			safe_states_sent: this.sent,
			safe_states_applied: this.applied,
			safe_states_muted: this.muted,
			safe_states_after_close: this.gateClosed,
			safe_unknown_states: this.unknownStates,
			...(this.unknownStateName !== undefined ? { safe_unknown_state_name: this.unknownStateName } : {}),
			safe_too_long: this.tooLong,
			safe_ignored: this.ignored,
			safe_unbound_drops: this.unbound,
			safe_ipc_failures: this.ipcFailures,
			...(this.cliVersion !== undefined ? { safe_cli_version: this.cliVersion } : {}),
			...(this.app !== undefined ? { safe_app: this.app } : {}),
		};
		this.openedAt = undefined;
		this.sent = this.applied = this.muted = this.gateClosed = this.unknownStates = this.tooLong = this.ignored = this.unbound = this.ipcFailures = 0;
		this.unknownStateName = undefined;
		return attributes;
	}
}

/** 1 つのターミナルから送る span の間隔。OSC 7501 は前面のどのプログラムでも書けるので、問い合わせを含むログを `cat` しただけで数千件になりうる。 */
export const PARADIS_PROGRAM_STATUS_SPAN_INTERVAL_MS = 10_000;

/**
 * 1 つのターミナルから送る span を {@link PARADIS_PROGRAM_STATUS_SPAN_INTERVAL_MS} に 1 件までに間引く。
 * 間引いた数は次に送る span に載せる。
 */
export class ParadisProgramStatusSpanThrottle {

	private lastAt: number | undefined;
	private skipped = 0;

	constructor(private readonly now: () => number = Date.now, private readonly intervalMs = PARADIS_PROGRAM_STATUS_SPAN_INTERVAL_MS) { }

	/** 送ってよければ前回から間引いた数、間引くなら undefined。`force` はターミナルを閉じるときの最後の 1 件。 */
	take(force = false): number | undefined {
		const now = this.now();
		if (!force && this.lastAt !== undefined && now - this.lastAt < this.intervalMs) {
			this.skipped++;
			return undefined;
		}
		this.lastAt = now;
		const skipped = this.skipped;
		this.skipped = 0;
		return skipped;
	}
}

/** 時間のかからない独立の transaction として送る（値は作るときに全部渡す。renderer では await の後に足すと失われるため）。 */
export function recordParadisProgramStatus(operation: 'query' | 'run', attributes: ParadisSpanAttributes): void {
	// スペースの切り替えなど、ほかの span の同期の区間で呼ばれても子に吸われず、自分の名前で届くようにする
	runInParadisSpan('programStatus', operation, attributes, () => { }, { forceTransaction: true });
}
