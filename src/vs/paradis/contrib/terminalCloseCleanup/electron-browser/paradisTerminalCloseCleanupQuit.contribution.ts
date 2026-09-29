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
// 立てるのは、閉じる処理の前段（`onBeforeShutdown`）でアプリの終了が決まるとき（QUIT と、macOS
// 以外で最後のウィンドウを閉じる CLOSE）。ここは `terminalService` がターミナルを閉じ始める前に
// 待たれる場所（`paradisPrepareTerminalShutdown`）で、返事を待ってから進むので、pty ホストには
// 閉じる依頼より先に印が届く。この段はまだ取り消せるので、取り消されたら下ろす。
//
// 起動したときにも下ろす。pty ホスト一式を常駐にする旧方式（`paradis.terminal.daemon.enabled`）では
// pty ホストがアプリの再起動をまたいで生きるので、前の終了で立てた印が残っている。
//
// 既知の穴（印が効いている 2 分の間だけ）: 取り消しは取り消したウィンドウにしか届かない。
// 複数のウィンドウがあるときに別のウィンドウが終了を取り消しても、こちらのウィンドウは知らない
// まま印を立て（前段の役は 1 つずつ順に待つので、取り消しより後に立つこともある）、下ろさない。
// その間にタブで閉じたターミナルは、裏のプロセスを止めない（今までの Para Code と同じ動き）。
// 印は 2 分で切れ、次に起動したウィンドウも下ろす。
//
// SSH 先のターミナルは対象外。接続先の pty ホストは他のクライアントとも共有していて、1 つの
// クライアントの終了で全員の片付けを止めることになるため。

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ILocalPtyService } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisRegisterTerminalShutdownPolicy } from '../../../../workbench/contrib/terminal/browser/paradisTerminalShutdownPolicy.js';
import { ILifecycleService, ShutdownReason } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisShutdownQuitsApp } from '../common/paradisTerminalCloseCleanupQuit.js';

export class ParadisTerminalCloseCleanupQuit extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.terminalCloseCleanupQuit';

	/**
	 * 返事を待つ上限。閉じる処理の直列パス上なので、pty ホストが詰まっていても閉じられるように
	 * する。間に合わなかったときは今までどおり止める側に倒れる（終了は止めない）。
	 */
	private static readonly MARK_TIMEOUT_MS = 2_000;

	/** このウィンドウが印を立てたか。取り消されたときに下ろすのは、立てたウィンドウだけ。 */
	private marked = false;

	constructor(
		@ILocalPtyService private readonly localPtyService: ILocalPtyService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ITerminalService terminalService: ITerminalService,
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
		// 前の終了で立った印を下ろす（冒頭参照）。この時点で pty ホストへまだ繋がっていなければ
		// 届かない（`_optionalProxy`）ので、ターミナルの復元が終わった後にもう一度送る。
		// その間にこのウィンドウが終了を始めていたら送らない（立てたばかりの印を消してしまう）。
		void this.clearStaleMark();
		void terminalService.whenConnected.then(() => this.clearStaleMark(), () => this.clearStaleMark());
	}

	private async clearStaleMark(): Promise<void> {
		if (!this.marked && !this._store.isDisposed) {
			await this.setQuitting(false);
		}
	}

	private async prepare(reason: ShutdownReason): Promise<void> {
		const isClose = reason === ShutdownReason.CLOSE;
		const windowCount = isClose && !isMacintosh ? await this.countWindows() : undefined;
		if (!paradisShutdownQuitsApp({ isQuit: reason === ShutdownReason.QUIT, isClose, windowCount, isMacintosh })) {
			return;
		}
		this.marked = true;
		await this.setQuitting(true);
	}

	/** 開いているウィンドウの数。分からなければ undefined（アプリの終了とは見なさない）。 */
	private async countWindows(): Promise<number | undefined> {
		try {
			return await raceTimeout(this.nativeHostService.getWindowCount(), ParadisTerminalCloseCleanupQuit.MARK_TIMEOUT_MS);
		} catch {
			return undefined;
		}
	}

	private async setQuitting(quitting: boolean): Promise<void> {
		try {
			const answered = await raceTimeout(this.localPtyService.paradisSetAppQuitting(quitting).then(() => true), ParadisTerminalCloseCleanupQuit.MARK_TIMEOUT_MS);
			if (answered !== true) {
				this.logService.warn(`[paradisTerminalCloseCleanupQuit] the pty host did not take the quitting mark (${quitting}) in time`);
			}
		} catch (error) {
			// 印を知らない pty ホスト（別の版の常駐など）もここへ来る。印が無ければ今までどおり止めるだけ。
			this.logService.trace('[paradisTerminalCloseCleanupQuit] could not set the quitting mark', error);
		}
	}
}

registerWorkbenchContribution2(ParadisTerminalCloseCleanupQuit.ID, ParadisTerminalCloseCleanupQuit, WorkbenchPhase.AfterRestored);
