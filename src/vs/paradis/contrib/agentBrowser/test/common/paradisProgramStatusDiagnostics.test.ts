/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isParadisSentryScrubbedWord } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { paradisProgramStatusDropReason, paradisProgramStatusProcessKind } from '../../common/paradisProgramStatus.js';
import { PARADIS_PROGRAM_STATUS_SPAN_INTERVAL_MS, ParadisProgramStatusRunEnd, ParadisProgramStatusRunStats, ParadisProgramStatusSpanThrottle, paradisProgramStatusCliVersion, paradisProgramStatusQueryAttributes } from '../../common/paradisProgramStatusDiagnostics.js';

suite('Para Browser Claude Code program status diagnostics (OSC 7501)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names why a body was not read, and passes on an unknown state only when it is a plain word', () => {
		assert.deepStrictEqual([
			'state=working:app=claude-code',
			'?',
			'state=thinking:app=claude-code',
			'state=/Users/someone/secret:app=claude-code',
			'app=claude-code',
			'state=working:app=claude-code:id=agent-1',
			'state=working:app=other',
			'x'.repeat(5_000),
		].map(paradisProgramStatusDropReason), [
			undefined,
			undefined,
			{ reason: 'unknown-state', unknownState: 'thinking' },
			{ reason: 'unknown-state' },
			{ reason: 'no-state' },
			{ reason: 'subagent' },
			{ reason: 'other-app' },
			{ reason: 'too-long' },
		]);
	});

	test('reduces the foreground process to a kind and a version number, never its name or path', () => {
		const titles = [undefined, '2.1.295', '/opt/bin/claude --resume', 'ssh', '-zsh', 'node', '/Users/someone/bin/my-tool'];
		assert.deepStrictEqual({
			kinds: titles.map(paradisProgramStatusProcessKind),
			versions: titles.map(paradisProgramStatusCliVersion),
			query: paradisProgramStatusQueryAttributes({ answered: false, foreground: undefined, processKind: 'node', cmdlineTrusted: false, shellIntegration: true, cliVersion: undefined }),
		}, {
			kinds: ['none', 'claude', 'claude', 'passthrough', 'shell', 'node', 'other'],
			versions: [undefined, '2.1.295', undefined, undefined, undefined, undefined, undefined],
			query: { safe_answered: false, safe_foreground_kind: 'none', safe_process_kind: 'node', safe_cmdline_trusted: false, safe_shell_integration: true },
		});
	});

	test('counts one run from the answered query to the close, and keeps states that arrive after the close for the next report', () => {
		let now = 1_000;
		const stats = new ParadisProgramStatusRunStats(() => now);
		// 問い合わせに答える前の出力（Claude Code 以外）は数えない
		stats.noteGateClosed();
		const before = stats.take('disposed');
		stats.opened('2.1.295');
		stats.noteSent();
		stats.noteApplied();
		stats.noteSent();
		stats.noteMuted();
		stats.noteDropped('unknown-state', 'thinking');
		stats.noteDropped('subagent', undefined);
		stats.noteUnbound();
		stats.noteIpcFailure();
		now += 5_000;
		const run = stats.take('shell-end');
		stats.noteGateClosed();
		assert.deepStrictEqual({ before, run, after: stats.take('disposed'), nothing: stats.take('disposed') }, {
			before: undefined,
			run: {
				safe_ended_by: 'shell-end',
				safe_open_ms: 5_000,
				safe_states_sent: 2,
				safe_states_applied: 1,
				safe_states_muted: 1,
				safe_states_after_close: 0,
				safe_unknown_states: 1,
				safe_unknown_state_name: 'thinking',
				safe_too_long: 0,
				safe_ignored: 1,
				safe_unbound_drops: 1,
				safe_ipc_failures: 1,
				safe_cli_version: '2.1.295',
			},
			after: {
				safe_ended_by: 'disposed',
				safe_states_sent: 0,
				safe_states_applied: 0,
				safe_states_muted: 0,
				safe_states_after_close: 1,
				safe_unknown_states: 0,
				safe_too_long: 0,
				safe_ignored: 0,
				safe_unbound_drops: 0,
				safe_ipc_failures: 0,
				safe_cli_version: '2.1.295',
			},
			nothing: undefined,
		});
	});

	test('sends at most one span per terminal every 10 seconds, carries the skipped count, and always sends the last one on close', () => {
		let now = 0;
		const throttle = new ParadisProgramStatusSpanThrottle(() => now);
		const taken: (number | undefined)[] = [throttle.take()];
		for (let index = 0; index < 1_000; index++) {
			now += 1;
			taken.push(throttle.take());
		}
		const sentDuringFlood = taken.filter(value => value !== undefined).length;
		now = PARADIS_PROGRAM_STATUS_SPAN_INTERVAL_MS;
		const afterInterval = throttle.take();
		now += 1;
		throttle.take();
		assert.deepStrictEqual({ sentDuringFlood, afterInterval, onClose: throttle.take(true) }, { sentDuringFlood: 1, afterInterval: 1_000, onClose: 1 });
	});

	test('drops an unknown state name that Sentry would scrub, but still counts it', () => {
		const stats = new ParadisProgramStatusRunStats(() => 0);
		stats.opened(undefined);
		stats.noteDropped('unknown-state', 'auth_wait');
		const run = stats.take('process-exit');
		assert.deepStrictEqual({ unknown: run?.safe_unknown_states, name: run?.safe_unknown_state_name }, { unknown: 1, name: undefined });
	});

	test('sends no key or fixed value that Sentry would scrub', () => {
		const ends: ParadisProgramStatusRunEnd[] = ['clear-status', 'shell-end', 'process-exit', 'foreground', 'requery', 'disposed'];
		const stats = new ParadisProgramStatusRunStats(() => 0);
		stats.opened('2.1.295');
		stats.noteDropped('unknown-state', 'thinking');
		const run = stats.take('disposed') ?? {};
		const query = paradisProgramStatusQueryAttributes({ answered: true, foreground: 'passthrough', processKind: 'passthrough', cmdlineTrusted: true, shellIntegration: true, cliVersion: '2.1.295' });
		const words = [...ends, ...Object.keys(run), ...Object.keys(query), 'safe_queries_skipped', 'safe_runs_skipped', ...[...Object.values(run), ...Object.values(query)].filter((value): value is string => typeof value === 'string')];
		assert.deepStrictEqual(words.filter(isParadisSentryScrubbedWord), []);
	});
});
