/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisHasRelayedFailures, paradisRelayDiagnosticsFromThisProcess, paradisRelayedFailureReports, paradisTakeRelayedFailures } from '../../common/paradisRelayedDiagnostics.js';
import { configureParadisDiagnosticReporter, paradisSafeErrorExtra, paradisSafeErrorTags, reportParadisDiagnosticError, toParadisSentrySafeError } from '../../common/paradisSentryDiagnostics.js';

suite('ParadisRelayedDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => {
		// 溜まり場はプロセスに1つ。前のテストの分を捨てる。
		paradisTakeRelayedFailures();
		paradisRelayDiagnosticsFromThisProcess();
	});

	teardown(() => {
		configureParadisDiagnosticReporter(() => { });
		paradisTakeRelayedFailures();
	});

	test('数えるのは種類と件数だけで、メッセージ・追加情報・固定の語に見えないものは残さない', () => {
		const spawnFailed = Object.assign(new Error('spawn /Users/alice/Applications/Para Code ENOENT'), { code: 'ENOENT' });
		reportParadisDiagnosticError('owned', 'pty-daemon', 'spawn-failed', spawnFailed, { safe_note: '/Users/alice' });
		reportParadisDiagnosticError('owned', 'pty-daemon', 'spawn-failed', spawnFailed);
		reportParadisDiagnosticError('owned', 'pty-host', 'no-pty', new Error('Could not find pty 12 on pty host'), undefined, 'warning');
		reportParadisDiagnosticError('owned', 'fileViewers', 'open /Users/alice/report.xlsx', new TypeError('bad'));
		const before = paradisHasRelayedFailures();

		assert.deepStrictEqual({ before, failures: paradisTakeRelayedFailures(), after: paradisHasRelayedFailures() }, {
			before: true,
			failures: [
				{ feature: 'pty-daemon', operation: 'spawn-failed', errorName: 'Error', errno: 'ENOENT', severity: 'error', count: 2 },
				{ feature: 'pty-host', operation: 'no-pty', errorName: 'Error', severity: 'warning', count: 1 },
				{ feature: 'fileViewers', operation: 'other', errorName: 'TypeError', severity: 'error', count: 1 },
			],
			after: false,
		});
	});

	test('窓が来ないまま種類が溢れたら、溢れた数だけを1種類として渡す', () => {
		for (let index = 0; index < 33; index++) {
			reportParadisDiagnosticError('owned', 'pty-daemon', `kind-${index}`, new Error('x'));
		}
		const failures = paradisTakeRelayedFailures();

		assert.deepStrictEqual({ kinds: failures.length, last: failures[failures.length - 1] }, {
			kinds: 31,
			last: { feature: 'relay', operation: 'overflow', errorName: 'none', severity: 'warning', count: 3 },
		});
	});

	test('受け取った記録は形を確かめ直し、窓から送る例外には種類だけを持たせる', () => {
		const reports = paradisRelayedFailureReports([
			{ feature: 'pty-daemon', operation: 'spawn-failed', errorName: 'Error', errno: 'EACCES', severity: 'error', count: 4 },
			{ feature: 'pty-host', operation: 'no-pty', errorName: 'ErrorNoTelemetry', severity: 'warning', count: 2_000_000 },
			{ feature: '/Users/alice', operation: 'x y', errorName: 'has spaces', errno: '/tmp', severity: 'fatal', count: 1 },
			{ feature: 'a', operation: 'b', errorName: 'Error', severity: 'error', count: 0 },
			{ feature: 'a', operation: 'b', errorName: 'Error', severity: 'error', count: 1.5 },
			'not an object',
		], { remote: true, hostOs: 'linux' });

		assert.deepStrictEqual(reports.map(report => ({
			feature: report.feature,
			operation: report.operation,
			severity: report.severity,
			data: report.data,
			tags: paradisSafeErrorTags(report.error),
			extra: paradisSafeErrorExtra(report.error),
			sent: toParadisSentrySafeError(report.feature, report.operation, report.error).stack,
		})), [
			{
				feature: 'pty-daemon', operation: 'spawn-failed', severity: 'error',
				data: { safe_count: 4, safe_remote: true, safe_host_os: 'linux' },
				tags: { 'para.error_name': 'Error' }, extra: { safe_errno: 'EACCES' },
				sent: 'Error: Para Code diagnostic: pty-daemon.spawn-failed',
			},
			{
				feature: 'pty-host', operation: 'no-pty', severity: 'warning',
				data: { safe_count: 1_000_000, safe_remote: true, safe_host_os: 'linux' },
				tags: { 'para.error_name': 'ErrorNoTelemetry' }, extra: {},
				sent: 'Error: Para Code diagnostic: pty-host.no-pty',
			},
			{
				feature: 'other', operation: 'other', severity: 'warning',
				data: { safe_count: 1, safe_remote: true, safe_host_os: 'linux' },
				tags: { 'para.error_name': 'unknown' }, extra: {},
				sent: 'Error: Para Code diagnostic: other.other',
			},
		]);
		assert.deepStrictEqual(paradisRelayedFailureReports(undefined, { remote: false, hostOs: 'darwin' }), []);
	});
});
