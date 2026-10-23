/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 繋ぎ直せなかったターミナルの後始末と、理由ごとの件数。
//
// スペースを切り替えて戻ると、そのスペースの保存状態（working set）に残っていたタブを繋ぎ直す。
// タブの端末が離れている間に終わっていると繋がらず、upstream は黙って空のシェルを起こしていた
// （`terminalProcessManager.ts`）。中身の無いタブが、終わった端末の場所に出るだけになる。
//
// ここでは、**終わっていたと確かめられたタブだけ**を閉じて知らせる。確かめ方は2つで、どちらも
// 推測を含まない: 離れている間にプロセスが終わったのを見ていた（`paradisWorkspaceSwitchService` の
// 台帳）、または pty host が「その nonce の端末はどこにも居ない」と答えた（`paradisPtyReadopt.ts` の
// `paradisAnswerForMissingNonce`）。孤児の索引が締め切りで打ち切られただけ、答えが無い、といった
// 回は分からないので、今まで通り新しいシェルで開く（生きた端末のタブを閉じるより安全）。
//
// 閉じ方は、孤児の端末を繋ぎ直せなかったときの畳み方（`paradisTerminalScope.contribution.ts` の
// `reviveOrphanedScopedEditorTerminals`）に揃える。起こしかけたシェルは、準備が済んでから実体ごと
// 終わらせる。
//
// 件数: どの理由で新しいシェルになったかを、切り替え1回ぶんにまとめて送る。pty host の側の
// `pty-host.reconnect-failed` は、fork がわざと繋がなかった分を数えなくなった（`paradisEndedPty.ts`）。

import { raceTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ParadisDiagnosticSeverity, reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisRestartedTerminalOutcome, ParadisRestartedTerminalReason, paradisTakeRestartedTerminalOutcome } from '../common/paradisEndedTerminalRestore.js';
import { IParadisRestartedTerminalLaunch, paradisForgetRestartedTerminal, paradisRegisterRestartedTerminalListener } from '../common/paradisTerminalLaunchPreparers.js';
import { IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';

/** シェルの準備と、切り替えの終わりを待つ上限。過ぎたら閉じずに残す（空のシェルのタブになるだけ）。 */
const PARADIS_ENDED_TERMINAL_CLOSE_WAIT_MS = 10_000;
/** 件数をまとめる間。1回の切り替えで戻るタブを1件の報告にする。 */
const PARADIS_RESTART_REPORT_DELAY_MS = 3_000;
/** 閉じたことを知らせるまでの間。同じ切り替えで閉じたタブを1つの通知にする。 */
const PARADIS_ENDED_NOTICE_DELAY_MS = 1_000;

interface IRestartTally {
	count: number;
	fromSavedSpace: number;
	indexTimedOut: number;
	closed: number;
}

const SEVERITY: Record<ParadisRestartedTerminalReason, ParadisDiagnosticSeverity> = {
	// 終わっていた・わざと繋がなかったは失敗ではない。件数を知るためだけに送る。
	'ended': 'info',
	'ambiguous': 'info',
	'not-found': 'warning',
};

class ParadisEndedTerminalRestoreContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.endedTerminalRestore';

	private readonly tallies = new Map<ParadisRestartedTerminalReason, IRestartTally>();
	private readonly reportScheduler = this._register(new RunOnceScheduler(() => this.flushReport(), PARADIS_RESTART_REPORT_DELAY_MS));
	/** 閉じるのを待っているタブの数。閉じた数を同じ報告に載せるため、これが 0 になるまで送らない。 */
	private pendingCloses = 0;
	private closedSinceNotice = 0;
	private readonly noticeScheduler = this._register(new RunOnceScheduler(() => this.notifyClosed(), PARADIS_ENDED_NOTICE_DELAY_MS));

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(paradisRegisterRestartedTerminalListener(launch => this.onRestartedTerminal(launch)));
		// 窓を閉じる前に溜めた分を送る。待たずに閉じると、その回の件数が消える。
		this._register(lifecycleService.onWillShutdown(() => {
			this.reportScheduler.cancel();
			this.flushReport(true);
		}));
	}

	private onRestartedTerminal(launch: IParadisRestartedTerminalLaunch): void {
		const outcome = paradisTakeRestartedTerminalOutcome(launch.nonce);
		const tally = this.tallyFor(outcome.reason);
		tally.count++;
		if (outcome.workingSet !== undefined) {
			tally.fromSavedSpace++;
			if (outcome.workingSet.indexTimedOut) {
				tally.indexTimedOut++;
			}
		}
		this.reportScheduler.schedule();
		if (this.shouldClose(outcome)) {
			this.pendingCloses++;
			void this.closeEndedTerminal(launch.instanceId).finally(() => {
				this.pendingCloses--;
				this.reportScheduler.schedule();
			});
		}
	}

	/** 閉じてよいのは、スペースの保存状態から戻したタブで、終わっていたと確かめられたものだけ。 */
	private shouldClose(outcome: IParadisRestartedTerminalOutcome): boolean {
		return outcome.reason === 'ended' && outcome.workingSet !== undefined;
	}

	private async closeEndedTerminal(instanceId: number): Promise<void> {
		const instance = this.terminalService.getInstanceFromId(instanceId);
		if (instance === undefined) {
			return;
		}
		try {
			// 起こしかけたシェルの準備を待ってから終わらせる。途中で破棄すると準備の後始末が宙に浮く。
			await raceTimeout(instance.processReady, PARADIS_ENDED_TERMINAL_CLOSE_WAIT_MS);
			// 切り替えの途中でタブを閉じると、適用中の working set とぶつかる。終わってから閉じる。
			if (this.workspaceSwitchService.isSwitching) {
				await raceTimeout(Event.toPromise(this.workspaceSwitchService.onDidSwitchScope), PARADIS_ENDED_TERMINAL_CLOSE_WAIT_MS);
			}
		} catch (error) {
			// 準備に失敗したシェルは upstream が畳む。閉じる相手が居ないだけ。
			this.logService.trace('[paradisEndedTerminalRestore] the replacement shell did not start', error);
		}
		if (instance.isDisposed || this._store.isDisposed) {
			return;
		}
		this.logService.info(`[paradisEndedTerminalRestore] terminal ${instanceId} had ended while its space was away; closing its tab instead of showing an empty shell`);
		paradisForgetRestartedTerminal(instanceId);
		instance.dispose(TerminalExitReason.User);
		this.tallyFor('ended').closed++;
		this.closedSinceNotice++;
		this.noticeScheduler.schedule();
	}

	private notifyClosed(): void {
		const count = this.closedSinceNotice;
		this.closedSinceNotice = 0;
		if (count === 0) {
			return;
		}
		this.notificationService.info(count === 1
			? localize('paradis.endedTerminalRestore.closedOne', "終了していたターミナルを閉じました。")
			: localize('paradis.endedTerminalRestore.closedMany', "終了していたターミナル {0} 個を閉じました。", count));
	}

	private tallyFor(reason: ParadisRestartedTerminalReason): IRestartTally {
		let tally = this.tallies.get(reason);
		if (tally === undefined) {
			tally = { count: 0, fromSavedSpace: 0, indexTimedOut: 0, closed: 0 };
			this.tallies.set(reason, tally);
		}
		return tally;
	}

	private flushReport(force = false): void {
		if (this.pendingCloses > 0 && !force) {
			this.reportScheduler.schedule();
			return;
		}
		const remote = this.environmentService.remoteAuthority !== undefined;
		for (const [reason, tally] of this.tallies) {
			// 理由は operation に入れる（指紋が operation で分かれる。`paradisSentryCommon.ts`）。
			reportParadisDiagnosticError('owned', 'pty-restore', `new-shell:${reason}`, new Error('pty-restore'), {
				safe_reason: reason,
				safe_count: tally.count,
				safe_from_saved_space: tally.fromSavedSpace,
				safe_index_timed_out: tally.indexTimedOut,
				safe_closed: tally.closed,
				safe_remote: remote,
			}, SEVERITY[reason]);
		}
		this.tallies.clear();
	}
}

registerWorkbenchContribution2(ParadisEndedTerminalRestoreContribution.ID, ParadisEndedTerminalRestoreContribution, WorkbenchPhase.BlockRestore);
