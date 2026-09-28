/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// main プロセスの固まりの見張り（W2-33）を配布版で動かす配線。見張りの本体は
// `node/paradisMainHangWatchdog.ts`。ヘルスビーコンの登録（app.ts の既存の PARA-PATCH 行）から
// 一緒に起こすので、新しい差し込み口は無い。
//
// 開発版では動かさない。デバッガで止めている間を固まりと誤って数えるため（Orca も同じ判断）。

import { app, powerMonitor } from 'electron';
import { join } from '../../../../base/common/path.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisMainHangMarker, IParadisMainHangRecovery, PARADIS_MAIN_HANG_DEFAULTS, ParadisMainHangWatchdog, paradisMainHangExtra, paradisTakeMainHangMarker } from '../node/paradisMainHangWatchdog.js';

/** 印のファイル名（userData の直下）。 */
const MARKER_FILE_NAME = 'paradis-main-hang.json';

/**
 * 前回の印を送るまで待つ時間。Sentry は起動時に遅れて読み込まれるので、それより前に送ると
 * 報告の受け口がまだ無く、黙って捨てられる。
 */
const PREVIOUS_HANG_REPORT_DELAY_MS = 60_000;

function report(operation: 'blocked' | 'blocked-until-exit', value: IParadisMainHangRecovery | IParadisMainHangMarker): void {
	const extra = paradisMainHangExtra(value);
	// main の ILogService はここへ来ないので、標準エラーへも書いておく。
	console.warn(`[paradisMainHang] the main process was blocked (${operation}): ${JSON.stringify(extra)}`);
	reportParadisDiagnosticError('owned', 'main-hang', operation, undefined, extra, 'warning');
}

/** 配布版でだけ見張りを起こす。返した IDisposable で worker・タイマー・購読を畳む。 */
export function paradisStartMainHangWatchdog(): IDisposable {
	if (!app.isPackaged) {
		return Disposable.None;
	}
	const store = new DisposableStore();
	const markerPath = join(app.getPath('userData'), MARKER_FILE_NAME);
	void (async () => {
		// 前回の印は、新しい見張りが書き始める前に読んで消す。
		const previous = await paradisTakeMainHangMarker(markerPath);
		if (store.isDisposed) {
			return;
		}
		if (previous) {
			const timer = setTimeout(() => report('blocked-until-exit', previous), PREVIOUS_HANG_REPORT_DELAY_MS);
			store.add(toDisposable(() => clearTimeout(timer)));
		}
		let watchdog: ParadisMainHangWatchdog;
		try {
			watchdog = store.add(new ParadisMainHangWatchdog({
				markerPath,
				...PARADIS_MAIN_HANG_DEFAULTS,
				onRecovered: recovery => report('blocked', recovery),
				onError: error => console.warn('[paradisMainHang] the watchdog stopped', error),
			}));
		} catch (error) {
			console.warn('[paradisMainHang] could not start the watchdog', error);
			return;
		}
		const onSuspend = () => watchdog.pause();
		const onResume = () => watchdog.resume();
		powerMonitor.on('suspend', onSuspend);
		powerMonitor.on('resume', onResume);
		store.add(toDisposable(() => {
			powerMonitor.removeListener('suspend', onSuspend);
			powerMonitor.removeListener('resume', onResume);
		}));
	})();
	return store;
}
