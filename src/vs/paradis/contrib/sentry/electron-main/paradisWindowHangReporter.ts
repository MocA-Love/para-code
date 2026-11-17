/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// window が固まったとき upstream（windowImpl.ts）が取ったスタックを Sentry へ送る。
// upstream は UnresponsiveSampleError を main の errorHandler へ渡すだけで、main の ErrorTelemetry（app.ts）は
// ログに書くだけなので、固まりは Sentry に 1 件も届いていなかった。errorHandler の listener は
// setUnexpectedErrorHandler と違って後から足しても upstream の処理を置き換えない。

import { Event } from '../../../../base/common/event.js';
import { errorHandler } from '../../../../base/common/errors.js';
import { DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICodeWindow } from '../../../../platform/window/electron-main/window.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import { getParadisUnresponsiveSample } from '../../../../platform/windows/common/paradisUnresponsiveSample.js';
import { ParadisHangReportBudget, paradisHangStackKey, paradisWindowHangSafeExtra } from '../common/paradisHangTelemetry.js';
import { markParadisErrorGroupKey, reportParadisDiagnosticError } from '../common/paradisSentryDiagnostics.js';

/** upstream の UnresponsiveError の name（windowImpl.ts）。 */
const UNRESPONSIVE_SAMPLE_ERROR = 'UnresponsiveSampleError';

/**
 * main の errorHandler に listener を足し、UnresponsiveSampleError だけを Sentry へ送る。
 * 送るのは upstream が取ったスタックのうち out/vs の行だけ（toParadisSentrySafeError。ホームのパスは伏せる）。
 */
export function paradisRegisterWindowHangReporter(windowsMainService: IWindowsMainService, now: () => number = Date.now): IDisposable {
	const store = new DisposableStore();
	const budget = new ParadisHangReportBudget(now);
	/** window の ID → Electron が固まりを知らせた時刻。 */
	const unresponsiveSince = new Map<number, number>();
	const watched = store.add(new DisposableMap<number, DisposableStore>());

	const watch = (window: ICodeWindow): void => {
		const win = window.win;
		if (!win || watched.has(window.id)) {
			return;
		}
		const id = window.id;
		const windowStore = new DisposableStore();
		watched.set(id, windowStore);
		// upstream の listener（同じ window の作成時に登録）より後に走るので、responsive で消すのはスタックを送った後になる
		windowStore.add(Event.fromNodeEventEmitter(win, 'unresponsive')(() => {
			if (!unresponsiveSince.has(id)) {
				unresponsiveSince.set(id, now());
			}
		}));
		windowStore.add(Event.fromNodeEventEmitter(win, 'responsive')(() => unresponsiveSince.delete(id)));
		windowStore.add(window.onDidClose(() => {
			unresponsiveSince.delete(id);
			watched.deleteAndDispose(id);
		}));
	};
	for (const window of windowsMainService.getWindows()) {
		watch(window);
	}
	store.add(windowsMainService.onDidOpenWindow(window => watch(window)));

	store.add(toDisposable(errorHandler.addListener(error => {
		// upstream の stopCollectingJScallStacks の途中で呼ばれるので、何があっても投げない
		try {
			if (!(error instanceof Error) || error.name !== UNRESPONSIVE_SAMPLE_ERROR) {
				return;
			}
			const decision = budget.take();
			if (!decision.allowed) {
				return;
			}
			const stack = typeof error.stack === 'string' ? error.stack : '';
			const groupKey = paradisHangStackKey(stack);
			if (groupKey !== undefined) {
				markParadisErrorGroupKey(error, groupKey);
			}
			const sample = getParadisUnresponsiveSample(error);
			const since = sample !== undefined ? unresponsiveSince.get(sample.windowId) : undefined;
			reportParadisDiagnosticError('patched', 'window-hang', 'unresponsive-sample', error, paradisWindowHangSafeExtra(error, since, now(), decision.skipped), 'warning');
		} catch {
			// Diagnostics must never change the behavior they observe.
		}
	})));
	return store;
}
