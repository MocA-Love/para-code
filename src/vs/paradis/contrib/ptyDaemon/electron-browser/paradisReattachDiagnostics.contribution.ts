/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動したときの繋ぎ直しの結果を Sentry へ送る（span `para.pty-daemon.startup-revive`）。
//
// 常駐からの引き取りそのもの（回ごとの本数・時間・失敗）は `ptyHandover` の span（`paradisPtyHandover.contribution.ts`）
// が送る。こちらは保存した画面からの起こし直しと、それに誰も繋ぎに来なかった本数を、起動時の引き取りの
// 本数と並べて見るためのもの。名前は `ptyHandover` と分けてある（同じ名前だと集計が混ざる）。
//
// 常駐を使っていると、更新や再起動のたびに「常駐から何本引き取れたか」「引き取れず残ったか」
// 「保存した画面から起こし直したのに、誰も繋ぎに来なかったものがあるか」が決まる。これまでは手元の
// ログでしか見えず、他の人の環境で繋ぎ直しが崩れていても分からなかった。数えるのは pty ホスト
// （`node/paradisReattachTally.ts`）で、ここは起動から少し待ってから聞いて送るだけ。
//
// 送るのは数だけ。キーの名前は Sentry が消す語（terminal・session・token など）を避けてある。

import { raceTimeout, timeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ILocalPtyService } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisReattachSpanAttributes } from '../common/paradisReattachDiagnostics.js';

/** 起動してから聞くまで。起こし直した画面へタブが繋ぎに来るのを待つ。 */
const REPORT_DELAY_MS = 60_000;
/** pty ホストが答えないときに諦めるまで。 */
const TALLY_TIMEOUT_MS = 5_000;

class ParadisReattachDiagnosticsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisReattachDiagnostics';

	constructor(
		@ILocalPtyService private readonly _localPtyService: ILocalPtyService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		if (isWindows) {
			return;
		}
		const cancellation = new CancellationTokenSource();
		this._register(toDisposable(() => cancellation.dispose(true)));
		void this._report(cancellation);
	}

	private async _report(cancellation: CancellationTokenSource): Promise<void> {
		try {
			await timeout(REPORT_DELAY_MS, cancellation.token);
			// 古い pty ホスト（常駐が更新をまたいで生かしているもの）にはメソッドが無い。
			const tally = await raceTimeout(this._localPtyService.paradisTakeReattachTally?.(this._workspaceContextService.getWorkspace().id) ?? Promise.resolve(undefined), TALLY_TIMEOUT_MS);
			const attributes = paradisReattachSpanAttributes(tally);
			if (attributes && !cancellation.token.isCancellationRequested) {
				runInParadisSpan('pty-daemon', 'startup-revive', attributes, () => undefined, { forceTransaction: true });
			}
		} catch {
			// 診断のために振る舞いを変えない（キャンセルや pty ホストの再起動を含む）。
		}
	}
}

registerWorkbenchContribution2(ParadisReattachDiagnosticsContribution.ID, ParadisReattachDiagnosticsContribution, WorkbenchPhase.Eventually);
