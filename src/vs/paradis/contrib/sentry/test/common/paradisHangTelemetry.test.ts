/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { markParadisUnresponsiveSample } from '../../../../../platform/windows/common/paradisUnresponsiveSample.js';
import { IParadisHangEpisode, PARADIS_HANG_REPORT_AFTER_MS, ParadisHangEpisodeTracker, ParadisHangReportBudget, paradisHangStackKey, paradisWindowHangSafeExtra } from '../../common/paradisHangTelemetry.js';
import { paradisSentryFingerprint } from '../../common/paradisSentryCommon.js';
import { markParadisErrorGroupKey, paradisSafeErrorTags, toParadisSentrySafeError } from '../../common/paradisSentryDiagnostics.js';

/** upstream の UnresponsiveError と同じ形（name と、取ったスタックをそのまま stack に持つ）。 */
function unresponsiveSampleError(stack: string): Error {
	const error = new Error('UnresponsiveSampleError: from window with ID 1 belonging to process with pid 4242');
	error.name = 'UnresponsiveSampleError';
	error.stack = stack;
	return error;
}

function sampleStack(root: string, line = 120): string {
	return [
		`    at spin (${root}/out/vs/workbench/workbench.desktop.main.js:${line}:17)`,
		`    at Object.run (${root}/out/vs/workbench/workbench.desktop.main.js:88:3)`,
		`    at extensionCode (${root.replace(/\/Contents\/Resources\/app$|\/para-code$/, '')}/.vscode/extensions/acme.x/dist/main.js:1:9)`,
		`    at fire (${root}/out/vs/workbench/workbench.desktop.main.js:40:5)`,
	].join('\n');
}

suite('ParadisHangTelemetry', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('budget allows three reports in ten minutes and twenty per launch', () => {
		let now = 0;
		const budget = new ParadisHangReportBudget(() => now);
		const firstWindow = [budget.take(), budget.take(), budget.take(), budget.take()].map(decision => decision.allowed);
		let allowed = 3;
		for (let round = 0; round < 10; round++) {
			now += 10 * 60 * 1_000;
			for (let index = 0; index < 3; index++) {
				if (budget.take().allowed) {
					allowed++;
				}
			}
		}
		assert.deepStrictEqual({ firstWindow, allowed, skipped: budget.take().skipped }, { firstWindow: [true, true, true, false], allowed: 20, skipped: 15 });
	});

	test('stack key uses the first five file:line:column positions, not the install folder', () => {
		const mac = paradisHangStackKey(sampleStack('vscode-file://vscode-app/Applications/Para Code.app/Contents/Resources/app'));
		const home = paradisHangStackKey(sampleStack('vscode-file://vscode-app/Users/example/Applications/Para Code.app/Contents/Resources/app'));
		const otherLine = paradisHangStackKey(sampleStack('vscode-file://vscode-app/Applications/Para Code.app/Contents/Resources/app', 121));
		assert.deepStrictEqual({ shape: /^[0-9a-f]{8}$/.test(mac ?? ''), sameAcrossFolders: mac === home, differsByLine: mac !== otherLine, none: paradisHangStackKey('no frames here') }, { shape: true, sameAcrossFolders: true, differsByLine: true, none: undefined });
	});

	test('the reported stack keeps out/vs frames and hides home folders on every platform', () => {
		const roots = [
			'vscode-file://vscode-app/Applications/Para Code.app/Contents/Resources/app',
			'vscode-file://vscode-app/Users/example/Applications/Para Code.app/Contents/Resources/app',
			'vscode-file://vscode-app/home/example/para-code',
			'vscode-file://vscode-app/c:/Users/example/AppData/Local/Programs/Para Code/resources/app',
		];
		const frames = roots.map(root => toParadisSentrySafeError('window-hang', 'unresponsive-sample', unresponsiveSampleError(sampleStack(root))).stack?.split('\n').slice(1, 2)[0]);
		assert.deepStrictEqual(frames, [
			'    at spin (vscode-file://vscode-app/Applications/Para Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js:120:17)',
			'    at spin (vscode-file://vscode-app~/Applications/Para Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js:120:17)',
			'    at spin (vscode-file://vscode-app~/para-code/out/vs/workbench/workbench.desktop.main.js:120:17)',
			'    at spin (vscode-file://vscode-app/~/AppData/Local/Programs/Para Code/resources/app/out/vs/workbench/workbench.desktop.main.js:120:17)',
		]);
		const stack = toParadisSentrySafeError('window-hang', 'unresponsive-sample', unresponsiveSampleError(sampleStack(roots[1]))).stack ?? '';
		assert.deepStrictEqual({ user: stack.includes('example'), extension: stack.includes('acme') }, { user: false, extension: false });
	});

	test('the group key joins the tags and the fingerprint', () => {
		const error = unresponsiveSampleError(sampleStack('vscode-file://vscode-app/Applications/Para Code.app/Contents/Resources/app'));
		markParadisErrorGroupKey(error, 'abcd1234');
		const tags: Record<string, string> = { 'para.scope': 'patched', 'para.feature': 'window-hang', 'para.operation': 'unresponsive-sample', ...paradisSafeErrorTags(error) };
		const fingerprint = paradisSentryFingerprint({ tags, exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: 'app:///out/vs/workbench/workbench.desktop.main.js', function: 'r4e' }] } }] } });
		assert.deepStrictEqual({ groupKey: tags['para.group_key'], errorName: tags['para.error_name'], endsWithKey: fingerprint.endsWith('|abcd1234') }, { groupKey: 'abcd1234', errorName: 'UnresponsiveSampleError', endsWithKey: true });
	});

	test('window hang extra carries the sample share and the time since the window stopped responding', () => {
		const error = unresponsiveSampleError('');
		markParadisUnresponsiveSample(error, 9, 15, 1);
		assert.deepStrictEqual([paradisWindowHangSafeExtra(error, 1_000, 16_000, 2), paradisWindowHangSafeExtra(new Error('x'), undefined, 0, 0)], [
			{ safe_hang_samples: 9, safe_hang_sample_pct: 60, safe_hang_ms: 15_000, safe_hang_reports_skipped: 2 },
			{},
		]);
	});

	test('episode tracker reports once per hang: on recovery, or after the limit if it never recovers', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const reports: IParadisHangEpisode[] = [];
		const tracker = disposables.add(new ParadisHangEpisodeTracker(episode => reports.push(episode), () => Date.now()));
		tracker.setResponsive(false);
		await new Promise(resolve => setTimeout(resolve, 4_000));
		tracker.setResponsive(false);
		tracker.setResponsive(true);
		tracker.setResponsive(true);
		tracker.setResponsive(false);
		await new Promise(resolve => setTimeout(resolve, PARADIS_HANG_REPORT_AFTER_MS + 5_000));
		// 戻らないまま作り直された拡張ホストの次の固まりも 1 回として数える
		tracker.setResponsive(false);
		await new Promise(resolve => setTimeout(resolve, 2_000));
		tracker.setResponsive(true);
		assert.deepStrictEqual(reports, [
			{ safe_hang_ms: 4_000, safe_hang_recovered: true },
			{ safe_hang_ms: PARADIS_HANG_REPORT_AFTER_MS, safe_hang_recovered: false },
			{ safe_hang_ms: 2_000, safe_hang_recovered: true },
		]);
	}));
});
