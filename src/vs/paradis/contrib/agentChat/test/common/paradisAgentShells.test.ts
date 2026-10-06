/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentMonitorTracker, ParadisAgentMonitorWatch, IParadisMonitorTimers } from '../../common/paradisAgentMonitors.js';
import { IParadisShellSignal, PARADIS_SHELL_LIMITS, ParadisAgentShellTracker, paradisShellOutputEndMarker, paradisShellStartedSignal, paradisShellsAccess, paradisShellsForStoppedPane } from '../../common/paradisAgentShells.js';
import { IParseSignals, newParseSignals, parseClaudeLine, rec } from '../../common/paradisAgentTranscriptParser.js';

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const OUTPUT = '/private/tmp/claude-501/-Users-example-projects-app/11111111-2222-3333-4444-555555555555/tasks';

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function bashCall(toolUseId: string, input: Record<string, unknown>, offsetMs = 0): string {
	return JSON.stringify({ type: 'assistant', timestamp: iso(offsetMs), message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input }] } });
}

function toolResult(toolUseId: string, text: string, toolUseResult: Record<string, unknown>, offsetMs: number): string {
	return JSON.stringify({ type: 'user', timestamp: iso(offsetMs), toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } });
}

function started(toolUseId: string, taskId: string, offsetMs = 500): string {
	return toolResult(toolUseId, `Command running in background with ID: ${taskId}. Output is being written to: ${OUTPUT}/${taskId}.output`, { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: taskId }, offsetMs);
}

function notification(taskId: string, status: string, summary: string, offsetMs: number, where: 'user' | 'queued' | 'queue-operation' = 'user', withOutput = true): string {
	const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n${withOutput ? `<output-file>${OUTPUT}/${taskId}.output</output-file>\n` : ''}<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
	switch (where) {
		case 'queued': return JSON.stringify({ type: 'attachment', timestamp: iso(offsetMs), attachment: { type: 'queued_command', prompt: text } });
		case 'queue-operation': return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(offsetMs), sessionId: 's', content: text });
		default: return JSON.stringify({ type: 'user', timestamp: iso(offsetMs), origin: { kind: 'task-notification' }, message: { role: 'user', content: text } });
	}
}

function parse(lines: readonly string[]): IParseSignals {
	const signals = newParseSignals();
	for (const line of lines) {
		const obj = rec(JSON.parse(line));
		if (obj !== undefined) {
			parseClaudeLine(obj, signals);
		}
	}
	return signals;
}

function track(lines: readonly string[], now = T0 + 60_000): ParadisAgentShellTracker {
	const tracker = new ParadisAgentShellTracker();
	tracker.apply(parse(lines).shellSignals, now);
	return tracker;
}

suite('paradisAgentShells', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the start and the end of background shells, whichever way the end arrives', () => {
		const tracker = track([
			bashCall('toolu_1', { command: 'npm run dev', description: 'dev サーバー', run_in_background: true }),
			started('toolu_1', 'bdev1'),
			bashCall('toolu_2', { command: 'npx tsc --noEmit', run_in_background: true }, 1_000),
			started('toolu_2', 'btsc2', 1_500),
			bashCall('toolu_3', { command: 'sleep 600', run_in_background: true }, 2_000),
			started('toolu_3', 'bsleep3', 2_500),
			bashCall('toolu_4', { command: 'npm test', run_in_background: true }, 3_000),
			started('toolu_4', 'btest4', 3_500),
			// 作業中に届いた失敗: queue-operation が先、queued_command が後（同じ通知の二度書き）
			notification('btsc2', 'failed', 'Background command "npx tsc --noEmit" failed with exit code 2', 10_000, 'queue-operation'),
			notification('btsc2', 'failed', 'Background command "npx tsc --noEmit" failed with exit code 2', 12_000, 'queued'),
			// TUI の x で止めた（queue-operation にだけ残る。output-file は無い）
			notification('bsleep3', 'killed', 'Task "sleep 600" was stopped by the user', 20_000, 'queue-operation', false),
			// 待機中に届いた完了
			notification('btest4', 'completed', 'Background command "npm test" completed (exit code 0)', 30_000),
		]);
		assert.deepStrictEqual(tracker.snapshot(), [
			{ id: 'bdev1', command: 'npm run dev', description: 'dev サーバー', startedAt: T0 + 500, status: 'running' },
			{ id: 'btsc2', command: 'npx tsc --noEmit', startedAt: T0 + 1_500, status: 'failed', endedAt: T0 + 10_000, exitCode: 2 },
			{ id: 'bsleep3', command: 'sleep 600', startedAt: T0 + 2_500, status: 'stopped', stoppedBy: 'user', endedAt: T0 + 20_000 },
			{ id: 'btest4', command: 'npm test', startedAt: T0 + 3_500, status: 'completed', endedAt: T0 + 30_000, exitCode: 0 },
		]);
		assert.strictEqual(tracker.outputFileFor('bdev1'), `${OUTPUT}/bdev1.output`);
	});

	test('a shell moved to the background (time-out or by hand) and a TaskStop from the agent', () => {
		const tracker = track([
			bashCall('toolu_a', { command: 'cargo build --release', description: 'ビルド' }),
			toolResult('toolu_a', `Command did not complete within its 120s timeout and was moved to the background (ID: bslow). Output is being written to: ${OUTPUT}/bslow.output. You will be notified when it completes.`, { timedOutAfterMs: 120_000 }, 120_000),
			bashCall('toolu_b', { command: 'npm run storybook' }, 121_000),
			toolResult('toolu_b', 'Command running in background with ID: bbook.', { backgroundTaskId: 'bbook', backgroundedByUser: true }, 125_000),
			bashCall('toolu_stop', { command: 'echo' }, 126_000),
			JSON.stringify({ type: 'user', timestamp: iso(130_000), toolUseResult: { message: 'Successfully stopped task: bbook (npm run storybook)', task_id: 'bbook', task_type: 'local_bash', command: 'npm run storybook' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: '{"message":"Successfully stopped task"}' }] } }),
		], T0 + 131_000);
		assert.deepStrictEqual(tracker.snapshot(), [
			{ id: 'bslow', command: 'cargo build --release', description: 'ビルド', startedAt: T0 + 120_000, status: 'running', movedToBackground: 'timeout' },
			{ id: 'bbook', command: 'npm run storybook', startedAt: T0 + 125_000, status: 'stopped', stoppedBy: 'agent', endedAt: T0 + 130_000, movedToBackground: 'user' },
		]);
	});

	test('unknown ids are taken only from a background command summary; Monitor and Agent results are not shells', () => {
		const signals = parse([
			notification('bagent', 'completed', 'Agent "レビュー" finished', 1_000),
			notification('bfar', 'failed', 'Background command "make" failed with exit code 1', 2_000),
			JSON.stringify({ type: 'user', timestamp: iso(3_000), toolUseResult: { taskId: 'bmon', timeoutMs: 1_000, persistent: false }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_m', content: 'Monitor started (task bmon, timeout 1000ms).' }] } }),
		]);
		const tracker = new ParadisAgentShellTracker();
		tracker.apply(signals.shellSignals, T0 + 4_000);
		assert.deepStrictEqual(tracker.snapshot(), [
			{ id: 'bfar', description: 'make', startedAt: T0 + 2_000, startUnknown: true, status: 'failed', endedAt: T0 + 2_000, exitCode: 1 },
		]);
	});

	test('a Monitor stopped in the TUI is closed from the queue-operation line only', () => {
		const signals = parse([
			JSON.stringify({ type: 'assistant', timestamp: iso(0), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_m', name: 'Monitor', input: { command: 'tail -f log', description: 'ログ', persistent: true } }] } }),
			JSON.stringify({ type: 'user', timestamp: iso(500), toolUseResult: { taskId: 'bmon', persistent: true }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_m', content: 'Monitor started (task bmon, persistent — runs until TaskStop or session end).' }] } }),
			notification('bmon', 'killed', 'Task "ログ" was stopped by the user', 9_000, 'queue-operation', false),
			// queue-operation の出力の通知は数えない（後から queued_command か user 行に同じものが来る）
			JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(8_000), content: '<task-notification>\n<task-id>bmon</task-id>\n<summary>Monitor event: "ログ"</summary>\n<event>line</event>\n</task-notification>' }),
		]);
		const monitors = new ParadisAgentMonitorTracker();
		monitors.apply(signals.monitorSignals, T0 + 10_000);
		assert.deepStrictEqual(monitors.snapshot().map(monitor => [monitor.id, monitor.status, monitor.eventCount]), [['bmon', 'stopped', 0]]);
	});

	test('a stop from the phone outlives a re-read of the transcript; the output marker ends a shell', () => {
		const lines = [bashCall('toolu_1', { command: 'sleep 600', run_in_background: true }), started('toolu_1', 'bsleep')];
		const tracker = new ParadisAgentShellTracker();
		tracker.apply(parse(lines).shellSignals, T0 + 1_000);
		const changed = tracker.markStoppedFromMobile('bsleep', T0 + 2_000);
		tracker.clear();
		tracker.apply(parse(lines).shellSignals, T0 + 3_000);
		assert.deepStrictEqual({ changed, snapshot: tracker.snapshot(), markers: ['[exited with code 0]', '[exited with code 2]', '[killed]', 'done'].map(paradisShellOutputEndMarker) }, {
			changed: true,
			snapshot: [{ id: 'bsleep', command: 'sleep 600', startedAt: T0 + 500, status: 'stopped', stoppedBy: 'mobile', endedAt: T0 + 2_000 }],
			markers: [{ status: 'completed', exitCode: 0 }, { status: 'failed', exitCode: 2 }, { status: 'stopped' }, undefined],
		});
	});

	test('an id only in the result text makes a shell only when it pairs with a remembered Bash call', () => {
		const tracker = track([
			// Bash の呼び出しと結べる（toolUseResult に構造化した値が無い版）
			bashCall('toolu_1', { command: 'sleep 9', run_in_background: true }),
			toolResult('toolu_1', `Command running in background with ID: btext1. Output is being written to: ${OUTPUT}/btext1.output`, {}, 500),
			// 呼び出しを覚えていない結果の本文に同じ文が入っていても、シェルにしない（ファイルの中身を Read した等）
			toolResult('toolu_read', 'Command running in background with ID: bfake. Output is being written to: /tmp/x.output', {}, 600),
			JSON.stringify({ type: 'user', timestamp: iso(700), message: { role: 'user', content: [{ type: 'tool_result', content: 'Command running in background with ID: bnoid.' }] } }),
		]);
		assert.deepStrictEqual(tracker.snapshot().map(shell => shell.id), ['btext1']);
	});

	test('the text of a foreground command result never makes a shell, even when it contains the background reply', () => {
		const tracker = track([
			// 前景の cat: 出力の先頭に同じ文がある
			bashCall('toolu_cat', { command: 'cat notes.txt' }),
			toolResult('toolu_cat', 'Command running in background with ID: bcat. Output is being written to: /tmp/a.output', {}, 100),
			// 前景の grep: 出力の途中に同じ文がある
			bashCall('toolu_grep', { command: 'grep -rn "Command running" src' }),
			toolResult('toolu_grep', 'src/a.ts:1: Command running in background with ID: bgrep. Output is being written to: /tmp/b.output', {}, 200),
			// 前景の差分の表示: 時間切れの文が途中にある
			bashCall('toolu_diff', { command: 'show the diff' }),
			toolResult('toolu_diff', '+ Command did not complete within its 120s timeout and was moved to the background (ID: bdiff).', {}, 300),
			// 背景指定の呼び出しでも、本文が応答の書き出しで始まらなければ読まない
			bashCall('toolu_bg', { command: 'sleep 9', run_in_background: true }),
			toolResult('toolu_bg', 'note: Command running in background with ID: bbg.', {}, 400),
		]);
		assert.deepStrictEqual({ shells: tracker.snapshot().map(shell => shell.id), foregroundStart: paradisShellStartedSignal('x Command running in background with ID: b1.', {}, 'toolu_x', 0) }, { shells: [], foregroundStart: undefined });
	});

	test('an estimated end from the output marker goes back to running when the next read has no marker, and stays stoppable', () => {
		const tracker = new ParadisAgentShellTracker();
		tracker.apply(parse([bashCall('toolu_1', { command: 'tail -f log', run_in_background: true }), started('toolu_1', 'btail')]).shellSignals, T0 + 1_000);
		tracker.markEndedFromOutput('btail', { status: 'completed', exitCode: 0 }, T0 + 2_000);
		const ended = { status: tracker.snapshot()[0]?.status, stoppable: tracker.isRunning('btail') };
		const reverted = tracker.markRunningFromOutput('btail');
		const running = tracker.snapshot()[0];
		// 本物の終わり・セッションの終わりの推定は、印が無いことでは戻さない
		tracker.endSession(T0 + 3_000);
		const sessionEndReverted = tracker.markRunningFromOutput('btail');
		assert.deepStrictEqual({ ended, reverted, running, sessionEndReverted }, {
			ended: { status: 'completed', stoppable: true },
			reverted: true,
			running: { id: 'btail', command: 'tail -f log', startedAt: T0 + 500, status: 'running' },
			sessionEndReverted: false,
		});
	});

	test('the end marker of the output file is an estimate that a real notification overwrites and a re-read forgets', () => {
		const lines = [bashCall('toolu_1', { command: 'make', run_in_background: true }), started('toolu_1', 'bmake')];
		const tracker = new ParadisAgentShellTracker();
		tracker.apply(parse(lines).shellSignals, T0 + 1_000);
		const changed = tracker.markEndedFromOutput('bmake', { status: 'failed', exitCode: 2 }, T0 + 2_000);
		const estimated = tracker.snapshot()[0];
		tracker.apply(parse([notification('bmake', 'completed', 'Background command "make" completed (exit code 0)', 3_000)]).shellSignals, T0 + 4_000);
		const confirmed = tracker.snapshot()[0];
		tracker.markEndedFromOutput('bmake', { status: 'stopped' }, T0 + 5_000);
		const afterConfirmed = tracker.snapshot()[0]?.status;
		const reread = new ParadisAgentShellTracker();
		reread.apply(parse(lines).shellSignals, T0 + 1_000);
		reread.markEndedFromOutput('bmake', { status: 'failed', exitCode: 2 }, T0 + 2_000);
		reread.clear();
		reread.apply(parse(lines).shellSignals, T0 + 6_000);
		assert.deepStrictEqual({ changed, estimated, confirmed, afterConfirmed, reread: reread.snapshot()[0]?.status }, {
			changed: true,
			estimated: { id: 'bmake', command: 'make', startedAt: T0 + 500, status: 'failed', estimated: true, endedAt: T0 + 2_000, exitCode: 2 },
			confirmed: { id: 'bmake', command: 'make', startedAt: T0 + 500, status: 'completed', endedAt: T0 + 3_000, exitCode: 0 },
			afterConfirmed: 'completed',
			reread: 'running',
		});
	});

	test('ended shells are kept like Monitors (30 minutes), session end and stopped panes stop running ones', () => {
		const tracker = track([
			bashCall('toolu_1', { command: 'a', run_in_background: true }), started('toolu_1', 'ba'),
			bashCall('toolu_2', { command: 'b', run_in_background: true }), started('toolu_2', 'bb'),
			notification('bb', 'completed', 'Background command "b" completed (exit code 0)', 1_000),
		], T0 + 2_000);
		const beforeExpiry = tracker.refresh(T0 + 1_000 + PARADIS_SHELL_LIMITS.endedRetentionMs - 1);
		const expired = tracker.refresh(T0 + 1_000 + PARADIS_SHELL_LIMITS.endedRetentionMs);
		const stoppedPane = paradisShellsForStoppedPane(tracker.snapshot(), T0 + 5_000);
		tracker.endSession(T0 + 6_000);
		assert.deepStrictEqual({ beforeExpiry, expired, ids: tracker.snapshot().map(shell => `${shell.id}:${shell.status}:${shell.estimated === true}`), stoppedPane: stoppedPane.map(shell => `${shell.id}:${shell.status}:${shell.estimated === true}:${shell.endedAt}`) }, {
			beforeExpiry: false,
			expired: true,
			ids: ['ba:stopped:true'],
			stoppedPane: [`ba:stopped:true:${T0 + 5_000}`],
		});
	});

	test('a shell started by a subagent or a Workflow child is listed from the child transcript and closed by the parent notification, and an ended one is not revived', () => {
		const child = (lines: readonly string[]) => {
			const signals = newParseSignals();
			for (const line of lines) {
				const obj = rec(JSON.parse(line));
				if (obj !== undefined) {
					parseClaudeLine({ ...obj, isSidechain: true }, signals, true);
				}
			}
			return signals.shellSignals;
		};
		const tracker = new ParadisAgentShellTracker();
		// 子の transcript にだけ起動が書かれる
		tracker.applyFromChild(child([bashCall('toolu_c1', { command: 'npm run dev', run_in_background: true }), started('toolu_c1', 'bchild')]), T0 + 1_000);
		const running = tracker.snapshot().map(shell => `${shell.id}:${shell.status}:${shell.command}`);
		// 親の transcript には queue-operation の終わりの通知だけが届く
		tracker.apply(parse([notification('bchild', 'completed', 'Background command "npm run dev" completed (exit code 0)', 2_000, 'queue-operation')]).shellSignals, T0 + 2_000);
		const closed = tracker.snapshot().map(shell => `${shell.id}:${shell.status}`);
		// 終わって一覧から捨てた後に子の transcript を読み直しても、動いているシェルに戻さない
		tracker.refresh(T0 + 2_000 + PARADIS_SHELL_LIMITS.endedRetentionMs);
		tracker.applyFromChild(child([bashCall('toolu_c1', { command: 'npm run dev', run_in_background: true }), started('toolu_c1', 'bchild')]), T0 + 2_000 + PARADIS_SHELL_LIMITS.endedRetentionMs);
		assert.deepStrictEqual({ running, closed, afterReread: tracker.snapshot().length }, {
			running: ['bchild:running:npm run dev'],
			closed: ['bchild:completed'],
			afterReread: 0,
		});
	});

	test('a shell started by a child keeps the id of that child (Workflow cards gather them)', () => {
		const tracker = new ParadisAgentShellTracker();
		const signals = parse([bashCall('toolu_o1', { command: 'npm test', run_in_background: true }), started('toolu_o1', 'bowned')]).shellSignals
			.map(signal => signal.type === 'started' ? { ...signal, ownerAgentId: 'aworkflowchild1' } : signal);
		tracker.applyFromChild(signals, T0 + 1_000);
		assert.deepStrictEqual(tracker.snapshot().map(shell => ({ id: shell.id, ownerAgentId: shell.ownerAgentId })), [{ id: 'bowned', ownerAgentId: 'aworkflowchild1' }]);
	});

	test('access per environment', () => {
		assert.deepStrictEqual([paradisShellsAccess(undefined, true), paradisShellsAccess(undefined, false), paradisShellsAccess('ssh', true), paradisShellsAccess('windows', false)], [
			{ output: true, stop: true },
			{ output: true, stop: false },
			{ output: false, stop: false, where: 'ssh' },
			{ output: false, stop: false, where: 'windows' },
		]);
	});

	test('the Monitor watch also tells about shells, including a stop that is not in the transcript', () => {
		let now = T0;
		const timers: IParadisMonitorTimers = { now: () => now, setTimeout: () => 1, clearTimeout: () => { } };
		let changes = 0;
		const watch = new ParadisAgentMonitorWatch(() => changes++, timers);
		const signals: IParadisShellSignal[] = parse([bashCall('toolu_1', { command: 'sleep 9', run_in_background: true }), started('toolu_1', 'bs')]).shellSignals;
		watch.apply([], true, signals);
		now += 1_000;
		watch.markShellStoppedFromMobile('bs');
		watch.markShellStoppedFromMobile('bs');
		const result = { changes, shells: watch.shellSnapshot().map(shell => `${shell.id}:${shell.status}:${shell.stoppedBy}`), running: watch.isShellRunning('bs') };
		watch.dispose();
		assert.deepStrictEqual(result, { changes: 2, shells: ['bs:stopped:mobile'], running: false });
	});
});
