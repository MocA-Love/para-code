/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐の端末の引き継ぎの記録を、pty ホストから取ってきて Sentry へ送る。窓が開いた後で引き取った
// 端末があれば、再読み込みで表示できることを知らせる。
//
// 記録を数えるのは pty ホストで、Sentry の SDK を持たない（SSH 先では REH ごと持たない）ので、
// 窓が取りに行く（`common/paradisPtyHandover.ts`）。この窓が SSH 先を開いていれば接続先の pty
// ホスト（`paradisPtyHandover.server.ts` のチャネル）、そうでなければこの PC の pty ホストへ聞く。
// 取ると数えた分は消えるので、同じ pty ホストを見ている他の窓と二重には送らない。
//
// pty ホストで出た明示の報告も、同じ記録の `failures` に種類と件数で載って
// くる（`paradisRelayedDiagnostics.ts`）。1種類につき1件、ここから送る。

import { disposableTimeout, IntervalTimer, raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILocalPtyService } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisRelayedFailureReports } from '../../sentry/common/paradisRelayedDiagnostics.js';
import { reportParadisDiagnosticError, runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	IParadisPtyHandoverReport,
	IParadisPtyHandoverService,
	PARADIS_PTY_HANDOVER_CHANNEL,
	paradisIsEmptyPtyHandoverReport,
	paradisPtyHandoverProblem,
	paradisPtyHandoverSpans,
	paradisPtyLateAdoptions,
} from '../common/paradisPtyHandover.js';

/** 取りに行く間隔。出来事は窓の開け閉めと更新のときにしか起きないので、粗くてよい。 */
const PARADIS_HANDOVER_DRAIN_MS = 60_000;
/** 窓が開いてから最初に取りに行くまで。起動時の引き取りの結果を早めに送る。 */
const PARADIS_HANDOVER_FIRST_DRAIN_MS = 15_000;
/** 1回の問い合わせを待つ上限。 */
const PARADIS_HANDOVER_TIMEOUT_MS = 10_000;
/** 窓を閉じるときの問い合わせを待つ上限。閉じるのを長く止めない。 */
const PARADIS_HANDOVER_SHUTDOWN_TIMEOUT_MS = 1_500;
/**
 * 窓を閉じるときに取ったが送れなかった記録。次に開く窓が送る（手元の保存。窓の間で共有）。
 * 閉じる途中で Sentry へ送っても届く保証が無いので、ここで送らずに残す。
 */
const PARADIS_HANDOVER_PENDING_KEY = 'paradis.ptyHandover.pendingReports';
/** 残しておく記録の数の上限。窓が開かないまま閉じるのを繰り返しても膨らまない。 */
const PARADIS_HANDOVER_PENDING_LIMIT = 5;

interface IParadisPendingHandoverReport {
	readonly remote: boolean;
	readonly report: IParadisPtyHandoverReport;
}

class ParadisPtyHandoverReporter extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.ptyHandoverReporter';

	private draining = false;

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ILocalPtyService private readonly localPtyService: ILocalPtyService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		// 最初の取りに行きより前に閉じた窓が残した分を、この窓が送る。
		this._register(disposableTimeout(() => this.sendPending(), PARADIS_HANDOVER_FIRST_DRAIN_MS));
		// 閉じる前に、まだ取っていない分を取って残す。取らないまま閉じると、接続先のサーバーが
		// 終わったとき（別の版のサーバーへ繋ぎ替わったとき等）に誰にも送られずに消える。
		this._register(lifecycleService.onWillShutdown(event => event.join(this.keepForNextWindow(), {
			id: 'join.paradisPtyHandover',
			label: localize('paradis.ptyHandover.keepOnShutdown', "ターミナルの引き継ぎの記録を保存しています"),
		})));
		const interval = this._register(new IntervalTimer());
		this._register(disposableTimeout(() => {
			void this.drain();
			interval.cancelAndSet(() => void this.drain(), PARADIS_HANDOVER_DRAIN_MS, mainWindow);
		}, PARADIS_HANDOVER_FIRST_DRAIN_MS));
	}

	private get remote(): boolean {
		return this.environmentService.remoteAuthority !== undefined;
	}

	private async take(): Promise<IParadisPtyHandoverReport | undefined> {
		if (this.remote) {
			const connection = this.remoteAgentService.getConnection();
			if (!connection) {
				return undefined;
			}
			return ProxyChannel.toService<IParadisPtyHandoverService>(connection.getChannel(PARADIS_PTY_HANDOVER_CHANNEL)).takeReport();
		}
		return this.localPtyService.paradisTakeHandoverReport?.();
	}

	private async drain(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			const report = await raceTimeout(this.take(), PARADIS_HANDOVER_TIMEOUT_MS);
			if (report && !paradisIsEmptyPtyHandoverReport(report)) {
				this.send(report, this.remote);
			}
		} catch (error) {
			// 古い REH（チャネルが無い）や、古い常駐の pty ホスト（メソッドが無い）。送るものが無いだけ。
			this.logService.trace('[paradisPtyHandover] could not take the handover report', error);
		} finally {
			this.draining = false;
		}
	}

	private async keepForNextWindow(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			const report = await raceTimeout(this.take(), PARADIS_HANDOVER_SHUTDOWN_TIMEOUT_MS);
			if (!report || paradisIsEmptyPtyHandoverReport(report)) {
				return;
			}
			const pending = [...this.readPending(), { remote: this.remote, report }].slice(-PARADIS_HANDOVER_PENDING_LIMIT);
			this.storageService.store(PARADIS_HANDOVER_PENDING_KEY, JSON.stringify(pending), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (error) {
			this.logService.trace('[paradisPtyHandover] could not keep the handover report for the next window', error);
		} finally {
			this.draining = false;
		}
	}

	private readPending(): IParadisPendingHandoverReport[] {
		const raw = this.storageService.get(PARADIS_HANDOVER_PENDING_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter((entry): entry is IParadisPendingHandoverReport =>
				typeof entry === 'object' && entry !== null
				&& typeof (entry as Partial<IParadisPendingHandoverReport>).remote === 'boolean'
				&& typeof (entry as Partial<IParadisPendingHandoverReport>).report === 'object'
				&& (entry as Partial<IParadisPendingHandoverReport>).report !== null);
		} catch {
			return [];
		}
	}

	private sendPending(): void {
		const pending = this.readPending();
		if (pending.length === 0) {
			return;
		}
		// 先に消す。送る途中で落ちても、同じ記録を二度は送らない。
		this.storageService.remove(PARADIS_HANDOVER_PENDING_KEY, StorageScope.APPLICATION);
		for (const entry of pending) {
			try {
				this.send(entry.report, entry.remote, true);
			} catch (error) {
				this.logService.trace('[paradisPtyHandover] could not send a handover report a closed window left', error);
			}
		}
	}

	/** @param fromClosedWindow 閉じた窓が残した記録か。引き継いだ端末の知らせは、その窓にしか意味が無いので出さない。 */
	private send(report: IParadisPtyHandoverReport, remote: boolean, fromClosedWindow = false): void {
		for (const span of paradisPtyHandoverSpans(report, remote)) {
			// 時間は属性で送る（数えたのは pty ホストで、ここでは一瞬で終わる）。
			runInParadisSpan('ptyHandover', span.operation, span.attributes, () => undefined, { forceTransaction: true });
		}
		const problem = paradisPtyHandoverProblem(report);
		if (problem) {
			// renderer ではメッセージの経路（`captureParadisDiagnosticMessage`）が繋がっていない
			// （main だけ）。例外の経路で送り、理由は `safe_` の追加情報に載せる（例外そのものは捨てられる）。
			reportParadisDiagnosticError('owned', 'ptyHandover', problem.operation, new Error('ptyHandover'), problem.data, 'warning');
		}
		for (const failure of paradisRelayedFailureReports(report.failures, { remote, hostOs: report.platform })) {
			reportParadisDiagnosticError('owned', failure.feature, failure.operation, failure.error, failure.data, failure.severity);
		}
		const late = fromClosedWindow ? 0 : paradisPtyLateAdoptions(report);
		if (late > 0) {
			this.logService.info(`[paradisPtyHandover] took over ${late} terminal(s) another pty host had been holding; they show up after a reload`);
			this.notificationService.prompt(Severity.Info,
				this.remote
					? localize('paradis.ptyHandover.lateRemote', "接続先で前の版のサーバーが握っていたターミナル {0} 個を、動いたまま引き継ぎました。ウィンドウを再読み込みすると表示されます。", late)
					: localize('paradis.ptyHandover.lateLocal', "別の Para Code が握っていたターミナル {0} 個を、動いたまま引き継ぎました。ウィンドウを再読み込みすると表示されます。", late),
				[
					{ label: localize('paradis.ptyHandover.notNow', "今はしない"), run: () => { } },
					{ label: localize('paradis.ptyHandover.reload', "再読み込み"), run: () => void this.hostService.reload() },
				]);
		}
	}
}

registerWorkbenchContribution2(ParadisPtyHandoverReporter.ID, ParadisPtyHandoverReporter, WorkbenchPhase.Eventually);
