/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code を終了するときに、この PC の pty ホストへ「終了中」の印を立てる（Q136）。
//
// 終了でもウィンドウはターミナルを 1 本ずつ閉じるので、何もしないと「閉じたときに裏のプロセスを
// 止める」（W2-32）が働いてしまう。常駐ターミナルでは常駐がアプリより長く生きるので確実に働く。
// 設定の説明は「Para Code の終了では働きません」なので、そちらに動きを合わせる。
//
// 立てるのは、閉じる処理の前段（`onBeforeShutdown`）で終了の理由が QUIT のとき。ここは
// `terminalService` がターミナルを閉じ始める前に待たれる場所（`paradisPrepareTerminalShutdown`）で、
// 返事を待ってから進むので、pty ホストには閉じる依頼より先に印が届く。この段はまだ取り消せる
// ので、取り消されたら下ろす。
//
// SSH 先のターミナルは対象外。接続先の pty ホストは他のクライアントとも共有していて、1 つの
// クライアントの終了で全員の片付けを止めることになるため。

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILocalPtyService } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { paradisRegisterTerminalShutdownPolicy } from '../../../../workbench/contrib/terminal/browser/paradisTerminalShutdownPolicy.js';
import { ILifecycleService, ShutdownReason } from '../../../../workbench/services/lifecycle/common/lifecycle.js';

class ParadisTerminalCloseCleanupQuit extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.terminalCloseCleanupQuit';

	/**
	 * 印の返事を待つ上限。閉じる処理の直列パス上なので、pty ホストが詰まっていても閉じられるように
	 * する。間に合わなかったときは今までどおり止める側に倒れる（終了は止めない）。
	 */
	private static readonly MARK_TIMEOUT_MS = 2_000;

	/** このウィンドウが印を立てたか。取り消されたときに下ろすのは、立てたウィンドウだけ。 */
	private marked = false;

	constructor(
		@ILocalPtyService private readonly localPtyService: ILocalPtyService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(paradisRegisterTerminalShutdownPolicy({
			name: 'close-cleanup-quit',
			prepare: reason => this.prepare(reason),
			// 残すかどうかには答えない（印を立てるためだけにここを借りている）。
			shouldKeepProcessesAlive: () => false,
			shouldKeepProcessAlive: () => false,
			warn: message => this.logService.warn(`[paradisTerminalCloseCleanupQuit] ${message}`),
		}));
		this._register(lifecycleService.onShutdownVeto(() => {
			if (this.marked) {
				this.marked = false;
				void this.setQuitting(false);
			}
		}));
	}

	private async prepare(reason: ShutdownReason): Promise<void> {
		if (reason !== ShutdownReason.QUIT) {
			return;
		}
		this.marked = true;
		await this.setQuitting(true);
	}

	private async setQuitting(quitting: boolean): Promise<void> {
		try {
			const answered = await raceTimeout(this.localPtyService.paradisSetAppQuitting(quitting).then(() => true), ParadisTerminalCloseCleanupQuit.MARK_TIMEOUT_MS);
			if (answered !== true) {
				this.logService.warn(`[paradisTerminalCloseCleanupQuit] the pty host did not take the quitting mark (${quitting}) in time`);
			}
		} catch (error) {
			this.logService.warn('[paradisTerminalCloseCleanupQuit] could not set the quitting mark', error);
		}
	}
}

registerWorkbenchContribution2(ParadisTerminalCloseCleanupQuit.ID, ParadisTerminalCloseCleanupQuit, WorkbenchPhase.AfterRestored);
