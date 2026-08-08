/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ParadisCodexPaneFailureKind,
	paradisClassifyCodexPaneFailure,
	paradisInspectCodexPaneFailure,
} from '../../common/paradisCodexPaneFailure.js';

function classify(log: string | undefined, serverAlive = false): ParadisCodexPaneFailureKind {
	return paradisClassifyCodexPaneFailure({ log, serverAlive });
}

/** 実機の `<socket>.log` から採取した、正常稼働中にも出続ける良性のERROR行。 */
const benignNoise = [
	'\u001b[2m2026-07-23T07:53:47.319342Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_models_manager::cache\u001b[0m\u001b[2m:\u001b[0m failed to load models cache: missing field `supports_reasoning_summaries` at line 88 column 5',
	'\u001b[2m2026-07-23T07:54:46.946923Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_models_manager::manager\u001b[0m\u001b[2m:\u001b[0m failed to renew cache TTL: missing field `supports_reasoning_summaries` at line 88 column 5',
].join('\n');

suite('ParadisCodexPaneFailure', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 実地で観測された主因。これを取りこぼすと計装した意味がない。
	test('classifies the observed sqlite state runtime failure', () => {
		assert.strictEqual(
			classify('Error: failed to initialize sqlite state runtime under /Users/someone/.codex: failed to initialize state runtime at /Users/someone/.codex'),
			'state-runtime');
	});

	// 正常稼働中のログにも ERROR / failed が大量に出るため、語だけで失敗判定してはならない。
	test('treats the benign models-cache noise as a healthy slow start, not a failure', () => {
		assert.strictEqual(classify(benignNoise, true), 'server-alive');
		assert.strictEqual(classify(benignNoise, false), 'unclassified');
	});

	test('strips ANSI so coloured output still matches', () => {
		assert.strictEqual(
			classify('\u001b[31mERROR\u001b[0m failed to initialize state runtime at /tmp/home'),
			'state-runtime');
	});

	// 根本原因(ディスク・権限)は、それが state runtime の初期化失敗として現れても優先する。
	test('prefers the actionable root cause over the symptom it surfaces as', () => {
		assert.strictEqual(
			classify('failed to initialize state runtime at /tmp/home: ENOSPC: no space left on device'),
			'disk-full');
		assert.strictEqual(
			classify('failed to initialize state runtime at /tmp/home: EACCES: permission denied'),
			'permission');
	});

	test('classifies the remaining known startup failures', () => {
		assert.deepStrictEqual([
			classify('Error: spawn /opt/homebrew/lib/codex-darwin-arm64/vendor/codex ENOENT'),
			classify('Error: listen EADDRINUSE: address already in use 127.0.0.1:0'),
			classify('Error: failed to parse config.toml at line 3'),
			classify('Error: your authentication token has been invalidated. Please try signing in again.'),
		], ['exec-missing', 'port-in-use', 'config', 'auth']);
	});

	// ログの有無そのものが切り分けの材料になる: 無い=ランチャーが起動を試みた形跡すら無い。
	test('distinguishes a missing log from an empty one', () => {
		assert.deepStrictEqual([
			classify(undefined),
			classify(''),
			classify('   \n  '),
			classify(undefined, true),
		], ['no-log', 'log-empty', 'log-empty', 'server-alive']);
	});

	// 本番の `auth` 58件が「今回の起動の話」なのかを決める材料。ログには前のセッションの行が
	// 残るので、末尾から遠い位置での一致は「古い行を拾っただけ」の疑いが濃い。
	test('reports how far from the end of the log the verdict came from', () => {
		const stale = ['unauthorized: please re-login', benignNoise, benignNoise].join('\n');
		const fresh = [benignNoise, 'unauthorized: please re-login'].join('\n');

		const staleEvidence = paradisInspectCodexPaneFailure({ log: stale, serverAlive: false });
		const freshEvidence = paradisInspectCodexPaneFailure({ log: fresh, serverAlive: false });

		assert.deepStrictEqual({
			staleKind: staleEvidence.kind,
			freshKind: freshEvidence.kind,
			// 古い行のほうが末尾から遠い、が成り立てば本番データで両者を分けられる。
			staleIsFartherFromEnd: staleEvidence.distanceFromEnd! > freshEvidence.distanceFromEnd!,
			// 一致が無ければ距離も無い（0 を送ると「末尾で一致」と読めてしまう）。
			benignDistance: paradisInspectCodexPaneFailure({ log: benignNoise, serverAlive: false }).distanceFromEnd,
		}, { staleKind: 'auth', freshKind: 'auth', staleIsFartherFromEnd: true, benignDistance: undefined });
	});

	// 分類と根拠は同じ判定順序でなければならない。ずれると Sentry 上で kind と距離が食い違う。
	// **両方を実際に呼んで突き合わせる**こと。片方の出力を定数と比べるだけでは、
	// もう片方が将来変わっても緑のままで、守りたい不変条件を守れない。
	test('keeps the verdict and its evidence in agreement', () => {
		const logs = [undefined, '', '  \n ', benignNoise, 'ENOSPC: no space left on device', 'unauthorized'];
		assert.deepStrictEqual(logs.map(log => {
			const evidence = paradisInspectCodexPaneFailure({ log, serverAlive: false });
			return {
				// 根拠が種別を出したなら、分類も必ず同じ種別になる。
				agrees: evidence.kind === undefined || evidence.kind === classify(log),
				kind: evidence.kind,
			};
		}), [
			{ agrees: true, kind: undefined },
			{ agrees: true, kind: undefined },
			{ agrees: true, kind: undefined },
			{ agrees: true, kind: undefined },
			{ agrees: true, kind: 'disk-full' },
			{ agrees: true, kind: 'auth' },
		]);
	});

	// 空白しかないログは「空」として扱われ、致命パターンの探索に入らない。
	test('treats a blank log as blank regardless of whitespace', () => {
		assert.deepStrictEqual([
			paradisInspectCodexPaneFailure({ log: '   \n\t ', serverAlive: false }).blank,
			paradisInspectCodexPaneFailure({ log: benignNoise, serverAlive: false }).blank,
			paradisInspectCodexPaneFailure({ log: undefined, serverAlive: false }).blank,
		], [true, false, false]);
	});
});
