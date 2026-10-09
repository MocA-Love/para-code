/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルで Claude Code の OSC 7501（Program Status Protocol）に答え、届いた状態を shared process へ渡す。
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
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisProgramStatus, PARADIS_PROGRAM_STATUS_OSC, PARADIS_PROGRAM_STATUS_REPLY, ParadisProgramStatusGate, paradisParseProgramStatus, paradisProgramStatusClosesOnForeground, paradisProgramStatusForeground, paradisTrustedCommandLine } from '../common/paradisProgramStatus.js';

class ParadisProgramStatusContribution extends Disposable implements ITerminalContribution {

	static readonly ID = 'para.programStatus';

	private readonly instance: ITerminalContributionContext['instance'];
	/** 復元したターミナルの、前の出力を流し直している間。 */
	private replaying: boolean;
	private readonly gate = new ParadisProgramStatusGate();
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
		// 前面のコマンド（Claude Code か ssh など）が終わったら受け付けを閉じ、残った状態を消す
		// （Claude Code が clear を書かずに落ちた場合も含む）
		const watch = (capability: ICommandDetectionCapability | undefined) => {
			this.commandFinished.value = capability?.onCommandFinished(() => {
				if (this.gate.close()) {
					this.send({ state: 'clear' });
				}
			});
		};
		watch(this.instance.capabilities.get(TerminalCapability.CommandDetection));
		this._register(this.instance.capabilities.onDidAddCommandDetectionCapability(capability => watch(capability)));
		// シェル統合が無いターミナルは、前面のプロセスがシェルへ戻ったら（Claude Code でも ssh などでもなくなったら）閉じる
		this.foregroundProcess = this.instance.processName || undefined;
		// プロセスが終わったら（Claude Code ごと落ちて「Relaunch Terminal」で立て直す場合も）閉じる
		this._register(context.processManager.onProcessExit(() => {
			if (this.gate.close()) {
				this.send({ state: 'clear' });
			}
		}));
		this._register(context.processManager.onDidChangeProperty(property => {
			if (property.type !== ProcessPropertyType.Title) {
				return;
			}
			this.foregroundProcess = typeof property.value === 'string' && property.value.length > 0 ? property.value : undefined;
			if (paradisProgramStatusClosesOnForeground(this.instance.capabilities.get(TerminalCapability.CommandDetection) !== undefined, this.foregroundProcess)
				&& this.gate.close()) {
				this.send({ state: 'clear' });
			}
		}));
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._register(xterm.raw.parser.registerOscHandler(PARADIS_PROGRAM_STATUS_OSC, data => {
			if (this.replaying) {
				return true;
			}
			const parsed = paradisParseProgramStatus(data);
			if (parsed === 'query') {
				// コマンド行は、シェル統合の nonce が合ったときだけ使う（出力の OSC 633 ; E では偽れる）
				const trustedCommandLine = paradisTrustedCommandLine(this.instance.capabilities.get(TerminalCapability.CommandDetection)?.currentCommand);
				if (this.gate.query(paradisProgramStatusForeground(trustedCommandLine, this.foregroundProcess))) {
					// 端末の返事として pty へ書く（利用者の入力にはしない。DA1 の自動の返事と同じ経路）
					xterm.raw.input(PARADIS_PROGRAM_STATUS_REPLY, false);
				}
			} else if (parsed !== undefined) {
				if (this.gate.accept(parsed)) {
					this.send(parsed);
				} else {
					this.schedulePending();
				}
			}
			return true;
		}));
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
			return;
		}
		this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call<boolean>('notePaneProgramStatus', [token, status])
			.catch(error => {
				this.logService.warn('[paradisProgramStatus] could not pass the Claude Code status to the shared process', error);
			});
	}
}

registerTerminalContribution(ParadisProgramStatusContribution.ID, ParadisProgramStatusContribution);
