/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルで Claude Code の OSC 7501（Program Status Protocol）に答え、届いた状態を shared process へ渡す。
// Codex（0.163.0 から）は問い合わせ無しで状態を書くので、前面のコマンドが Codex（か ssh・WSL など）なら受け付けを開く。
// shared process は、hook が届いていないペイン（WSL・手で ssh した先など）の状態の補助にだけ使う
// （paradisAgentBrowserService.ts の notePaneProgramStatus）。問い合わせへの答えは pty へ書くので、ssh の
// 先で動く Claude Code にも届く。
//
// 復元したターミナルは、前の出力を流し直す間に古い問い合わせと状態も流れてくる。答えると、もう終わった
// Claude Code の代わりにシェルへ文字が入るので、流し直しが終わるまでは答えも状態も扱わない。
//
// 出力はどのプログラムでも書けるので、前面のコマンドが Claude Code（か ssh・WSL など）のときの問い合わせにだけ答え、
// 答えたターミナルでだけ状態を受ける。速すぎる変化は間引く（paradisProgramStatus.ts の ParadisProgramStatusGate）。

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ProcessPropertyType } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalContribution, IXtermTerminal } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ITerminalContributionContext, registerTerminalContribution } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';
import { ParadisSpanAttributes } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisProgramStatus, PARADIS_PROGRAM_STATUS_OSC, PARADIS_PROGRAM_STATUS_REPLY, ParadisProgramStatusEffect, ParadisProgramStatusTracker, paradisParseProgramStatus, paradisProgramStatusDropReason, paradisProgramStatusForeground, paradisProgramStatusProcessKind, paradisTrustedCommandLine } from '../common/paradisProgramStatus.js';
import { ParadisProgramStatusRunEnd, ParadisProgramStatusRunStats, ParadisProgramStatusSpanThrottle, paradisProgramStatusCliVersion, paradisProgramStatusQueryAttributes, recordParadisProgramStatus } from '../common/paradisProgramStatusDiagnostics.js';

class ParadisProgramStatusContribution extends Disposable implements ITerminalContribution {

	static readonly ID = 'para.programStatus';

	private readonly instance: ITerminalContributionContext['instance'];
	/** 復元したターミナルの、前の出力を流し直している間。 */
	private replaying: boolean;
	private readonly tracker = new ParadisProgramStatusTracker();
	private readonly gate = this.tracker.gate;
	/** 答えなかった問い合わせ・捨てた状態を Sentry で数えるための件数（受け付けが閉じるたびに送る）。 */
	private readonly runStats = new ParadisProgramStatusRunStats();
	/** 問い合わせ・受け付けの終わりの span を、このターミナルから 10 秒に 1 件ずつまでにする。 */
	private readonly querySpans = new ParadisProgramStatusSpanThrottle();
	private readonly runSpans = new ParadisProgramStatusSpanThrottle();
	private readonly commandFinished = this._register(new MutableDisposable());
	private readonly pendingTimer = this._register(new MutableDisposable());
	/**
	 * pty が報告した前面のプロセスの題名。`instance.processName` は名前を付けた端末では更新が止まり（題名の出どころが
	 * API になるため）、Claude Code が終わっても版の番号のまま残るので、プロセスの知らせを自分で受けて持つ。
	 */
	private foregroundProcess: string | undefined;

	constructor(
		context: ITerminalContributionContext,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.instance = context.instance;
		this.replaying = this.instance.reconnectionProperties !== undefined || this.instance.shellLaunchConfig.attachPersistentProcess !== undefined;
		if (this.replaying) {
			this._register(this.instance.onProcessReplayComplete(() => this.replaying = false));
		}
		// 前面のコマンド（Claude Code か ssh など）が終わったら受け付けを閉じ、残った状態を消す（Claude Code が clear を
		// 書かずに落ちた場合も含む）。Ctrl+Z で止めただけなら `fg` で戻るのを待つ（判断は ParadisProgramStatusTracker）
		const watch = (capability: ICommandDetectionCapability | undefined) => {
			this.commandFinished.value = capability?.onCommandFinished(command => this.apply(this.tracker.commandFinished(command.exitCode), 'shell-end'));
		};
		watch(this.instance.capabilities.get(TerminalCapability.CommandDetection));
		this._register(this.instance.capabilities.onDidAddCommandDetectionCapability(capability => watch(capability)));
		// シェル統合が無いターミナルは、前面のプロセスがシェルへ戻ったら（Claude Code でも ssh などでもなくなったら）閉じる
		this.foregroundProcess = this.instance.processName || undefined;
		// プロセスが終わったら（Claude Code ごと落ちて「Relaunch Terminal」で立て直す場合も）閉じる
		this._register(context.processManager.onProcessExit(() => this.apply(this.tracker.processExited(), 'process-exit')));
		this._register(context.processManager.onDidChangeProperty(property => {
			if (property.type !== ProcessPropertyType.Title) {
				return;
			}
			this.foregroundProcess = typeof property.value === 'string' && property.value.length > 0 ? property.value : undefined;
			const wasOpen = this.gate.isOpen;
			this.apply(this.tracker.foregroundChanged(this.foregroundProcess, this.instance.capabilities.get(TerminalCapability.CommandDetection) !== undefined), 'foreground');
			if (this.gate.isOpen) {
				// Ctrl+Z の後に `fg` で開き直したら、新しい受け付けとして数える
				if (!wasOpen) {
					this.runStats.opened(paradisProgramStatusCliVersion(this.foregroundProcess));
				} else {
					this.runStats.noteCliVersion(paradisProgramStatusCliVersion(this.foregroundProcess));
				}
			}
		}));
	}

	override dispose(): void {
		this.endRun('disposed');
		super.dispose();
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._register(xterm.raw.parser.registerOscHandler(PARADIS_PROGRAM_STATUS_OSC, data => {
			if (this.replaying) {
				return true;
			}
			const parsed = paradisParseProgramStatus(data);
			if (parsed === 'query') {
				// コマンド行は、シェル統合の nonce が合ったときだけ使う（出力の OSC 633 ; E では偽れる）
				const commandDetection = this.instance.capabilities.get(TerminalCapability.CommandDetection);
				const trustedCommandLine = paradisTrustedCommandLine(commandDetection?.currentCommand);
				const answered = this.tracker.query(trustedCommandLine, this.foregroundProcess);
				if (answered) {
					// 前の受け付けの件数（閉じた後に届いた状態を含む）を先に送ってから数え直す
					this.endRun('requery');
					this.runStats.opened(paradisProgramStatusCliVersion(this.foregroundProcess));
					// 端末の返事として pty へ書く（利用者の入力にはしない。DA1 の自動の返事と同じ経路）
					xterm.raw.input(PARADIS_PROGRAM_STATUS_REPLY, false);
				}
				// 答えなかったときは Claude Code がこのターミナルへ状態を送らないので、hook の無いペインの状態が出ない。
				// 何が前面に見えていたかの種類だけを送る（プロセス名・コマンド行は送らない）
				const skipped = this.querySpans.take();
				if (skipped !== undefined) {
					this.record('query', {
						...paradisProgramStatusQueryAttributes({
							answered,
							foreground: paradisProgramStatusForeground(trustedCommandLine, this.foregroundProcess),
							processKind: paradisProgramStatusProcessKind(this.foregroundProcess),
							cmdlineTrusted: trustedCommandLine !== undefined,
							shellIntegration: commandDetection !== undefined,
							cliVersion: paradisProgramStatusCliVersion(this.foregroundProcess),
						}),
						...(skipped > 0 ? { safe_queries_skipped: skipped } : {}),
					});
				}
			} else if (parsed !== undefined) {
				if (parsed.app === 'codex' && !this.gate.isOpen) {
					const trustedCommandLine = paradisTrustedCommandLine(this.instance.capabilities.get(TerminalCapability.CommandDetection)?.currentCommand);
					if (this.tracker.codexStatus(trustedCommandLine, this.foregroundProcess)) {
						this.endRun('reopened');
						this.runStats.opened(undefined, 'codex');
					}
				}
				const wasOpen = this.gate.isOpen;
				// Codex の受け付けで届いた clear は Codex のものとして送る（shared process は Claude Code の clear と扱いを分ける）
				const codexClear = parsed.state === 'clear' && this.gate.app === 'codex';
				if (this.gate.accept(parsed)) {
					this.send(codexClear ? { state: 'clear', app: 'codex' } : parsed);
					if (parsed.state === 'clear') {
						this.endRun('clear-status');
					}
				} else {
					if (!wasOpen) {
						// Claude Code は終わるときにも clear を書く。受け付けを閉じた後の clear は数えない
						if (parsed.state !== 'clear') {
							this.runStats.noteGateClosed();
						}
					} else if (this.gate.pendingDueAt !== undefined) {
						this.runStats.noteMuted();
					}
					this.schedulePending();
				}
			} else if (this.gate.isOpen) {
				const drop = paradisProgramStatusDropReason(data);
				if (drop !== undefined) {
					this.runStats.noteDropped(drop.reason, drop.unknownState);
				}
			}
			return true;
		}));
	}

	/** 受け付けを閉じた・保留にしたら、残った状態を消す。 */
	private apply(effect: ParadisProgramStatusEffect, endedBy: ParadisProgramStatusRunEnd): void {
		if (effect === 'clear') {
			this.send({ state: 'clear', ...(this.gate.app === 'codex' ? { app: 'codex' as const } : {}) });
			this.endRun(endedBy);
		}
	}

	/**
	 * 受け付けが閉じた。開いていた間の件数を 1 件の span で送る。間引くときは件数を持ち越し、次に送る span
	 * （ターミナルを閉じたときは必ず送る）にまとめる。
	 */
	private endRun(endedBy: ParadisProgramStatusRunEnd): void {
		const disposed = endedBy === 'disposed';
		// 閉じるときは、間引いたまま送れなかった問い合わせの数もここに載せる（次の問い合わせの span はもう来ない）
		const queriesSkipped = disposed ? this.querySpans.take(true) ?? 0 : 0;
		if (!this.runStats.hasData && queriesSkipped === 0) {
			return;
		}
		const skipped = this.runSpans.take(disposed);
		if (skipped === undefined) {
			return;
		}
		this.record('run', {
			...(this.runStats.take(endedBy) ?? { safe_ended_by: endedBy }),
			...(skipped > 0 ? { safe_runs_skipped: skipped } : {}),
			...(queriesSkipped > 0 ? { safe_queries_skipped: queriesSkipped } : {}),
		});
	}

	private record(operation: 'query' | 'run', attributes: ParadisSpanAttributes): void {
		try {
			recordParadisProgramStatus(operation, attributes);
		} catch {
			// 診断は観測している動きを変えない
		}
	}

	/** 間引きで捨てた最後の状態を、無視が明けたら 1 回だけ渡す。 */
	private schedulePending(): void {
		const dueAt = this.gate.pendingDueAt;
		if (dueAt === undefined || this.pendingTimer.value !== undefined) {
			return;
		}
		const handle = setTimeout(() => {
			this.pendingTimer.clear();
			const pending = this.gate.releasePending();
			if (pending !== undefined) {
				this.send(pending);
			} else if (this.gate.pendingDueAt !== undefined) {
				// タイマーが明ける時刻より早く起きた（時計の粒度）。捨てた状態が残っているので、もう一度予約する
				this.schedulePending();
			}
		}, Math.max(0, dueAt - Date.now()));
		this.pendingTimer.value = toDisposable(() => clearTimeout(handle));
	}

	private send(status: IParadisProgramStatus): void {
		const token = this.paneTokenService.getTokenForInstance(this.instance.instanceId);
		if (token === undefined) {
			if (status.state !== 'clear') {
				this.runStats.noteUnbound();
			}
			return;
		}
		const counted = status.state !== 'clear';
		if (counted) {
			this.runStats.noteSent();
		}
		this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call<boolean>('notePaneProgramStatus', [token, status])
			.then(applied => {
				if (counted && applied) {
					this.runStats.noteApplied();
				}
			}, error => {
				this.runStats.noteIpcFailure();
				this.logService.warn('[paradisProgramStatus] could not pass the agent status to the shared process', error);
			});
	}
}

registerTerminalContribution(ParadisProgramStatusContribution.ID, ParadisProgramStatusContribution);
