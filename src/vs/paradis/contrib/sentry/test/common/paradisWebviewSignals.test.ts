/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { configureParadisDiagnosticReporter } from '../../common/paradisSentryDiagnostics.js';
import { IParadisWebviewSignal, notifyParadisWebviewSignal, onParadisWebviewSignal } from '../../common/paradisWebviewSignals.js';

suite('ParadisWebviewSignals', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function capture(signals: IParadisWebviewSignal[], reports: Array<[string, string, Record<string, unknown> | undefined]>, disposables: Pick<DisposableStore, 'add'>): void {
		disposables.add(onParadisWebviewSignal(signal => signals.push(signal)));
		configureParadisDiagnosticReporter((_scope, feature, operation, _error, safeExtra) => reports.push([feature, operation, safeExtra]));
		disposables.add({ dispose: () => configureParadisDiagnosticReporter(() => { }) });
	}

	test('service worker trouble is forwarded and reported, the normal render steps are only forwarded', () => {
		const signals: IParadisWebviewSignal[] = [];
		const reports: Array<[string, string, Record<string, unknown> | undefined]> = [];
		capture(signals, reports, store);

		// ParadisWebviewSignalCode の全種類を流す。新しい種類を足したらここにも足すこと
		// （どれを Sentry に送るかの判断が漏れると、頻発するシグナルで診断が埋まる）。
		notifyParadisWebviewSignal({ origin: 'origin-a', code: 'sw-control-timeout', detail: { duration_ms: 5000 } });
		notifyParadisWebviewSignal({ origin: 'origin-a', code: 'sw-control-recovered', detail: { duration_ms: 5200, attempt: 1 } });
		notifyParadisWebviewSignal({ origin: 'origin-a', code: 'sw-register-timeout', detail: { duration_ms: 5000, attempt: 1 } });
		notifyParadisWebviewSignal({ origin: 'origin-a', code: 'sw-register-recovered', detail: { duration_ms: 7000, attempt: 2 } });
		notifyParadisWebviewSignal({ origin: 'origin-a', code: 'sw-unavailable', detail: { duration_ms: 20000 } });
		notifyParadisWebviewSignal({ origin: 'origin-a', code: 'sw-versionless-registration-discarded', detail: { duration_ms: 320, safe_removed: true } });
		notifyParadisWebviewSignal({ origin: 'origin-b', code: 'content-started' });
		notifyParadisWebviewSignal({ origin: 'origin-b', code: 'content-worker-ready' });
		notifyParadisWebviewSignal({ origin: 'origin-b', code: 'content-applied' });

		assert.deepStrictEqual({
			signals: signals.map(signal => [signal.origin, signal.code]),
			reports,
		}, {
			signals: [
				['origin-a', 'sw-control-timeout'],
				['origin-a', 'sw-control-recovered'],
				['origin-a', 'sw-register-timeout'],
				['origin-a', 'sw-register-recovered'],
				['origin-a', 'sw-unavailable'],
				['origin-a', 'sw-versionless-registration-discarded'],
				['origin-b', 'content-started'],
				['origin-b', 'content-worker-ready'],
				['origin-b', 'content-applied'],
			],
			reports: [
				['webview', 'sw-control-timeout', { duration_ms: 5000, attempt: undefined, safe_removed: undefined }],
				['webview', 'sw-control-recovered', { duration_ms: 5200, attempt: 1, safe_removed: undefined }],
				['webview', 'sw-register-timeout', { duration_ms: 5000, attempt: 1, safe_removed: undefined }],
				['webview', 'sw-register-recovered', { duration_ms: 7000, attempt: 2, safe_removed: undefined }],
				['webview', 'sw-unavailable', { duration_ms: 20000, attempt: undefined, safe_removed: undefined }],
				['webview', 'sw-versionless-registration-discarded', { duration_ms: 320, attempt: undefined, safe_removed: true }],
			],
		});
	});
});
