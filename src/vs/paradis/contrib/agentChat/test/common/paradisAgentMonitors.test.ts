/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentMonitor, IParadisMonitorSignal, IParadisMonitorTimers, PARADIS_MONITOR_LIMITS, ParadisAgentMonitorTracker, ParadisAgentMonitorWatch, paradisMonitorsForStoppedPane } from '../../common/paradisAgentMonitors.js';
import { newParseSignals, parseClaudeLine, rec } from '../../common/paradisAgentTranscriptParser.js';

const T0 = Date.parse('2026-10-02T10:00:00.000Z');

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function monitorCall(toolUseId: string, input: Record<string, unknown>, offsetMs = 0): string {
	return JSON.stringify({ type: 'assistant', timestamp: iso(offsetMs), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: toolUseId, name: 'Monitor', input }] } });
}

function monitorStarted(toolUseId: string, taskId: string, timeoutMs: number, persistent: boolean, offsetMs = 1_000): string {
	const detail = persistent ? 'persistent — runs until TaskStop or session end' : `timeout ${timeoutMs}ms`;
	return JSON.stringify({
		type: 'user', timestamp: iso(offsetMs), toolUseResult: { taskId, timeoutMs, persistent },
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Monitor started (task ${taskId}, ${detail}). You will be notified on each event.` }] },
	});
}

function notification(body: string, offsetMs: number, queued = false): string {
	const text = `<task-notification>\n${body}\n</task-notification>`;
	return queued
		? JSON.stringify({ type: 'attachment', timestamp: iso(offsetMs), attachment: { type: 'queued_command', prompt: text } })
		: JSON.stringify({ type: 'user', timestamp: iso(offsetMs), message: { role: 'user', content: text } });
}

function signalsOf(lines: readonly string[]): IParadisMonitorSignal[] {
	const signals = newParseSignals();
	for (const line of lines) {
		const obj = rec(JSON.parse(line));
		if (obj !== undefined) {
			parseClaudeLine(obj, signals);
		}
	}
	return signals.monitorSignals;
}

function track(lines: readonly string[], now: number): ParadisAgentMonitorTracker {
	const tracker = new ParadisAgentMonitorTracker();
	tracker.apply(signalsOf(lines), now);
	return tracker;
}

suite('paradisAgentMonitors', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads start, output (user and queued_command), and the end of a Monitor', () => {
		const tracker = track([
			monitorCall('toolu_1', { command: 'tail -f /tmp/build.log | grep --line-buffered error', description: 'iOS ビルドの進行', persistent: false, timeout_ms: 150000 }),
			monitorStarted('toolu_1', 'bwnyoulx6', 150000, false),
			notification('<task-id>bwnyoulx6</task-id>\n<summary>Monitor event: "iOS ビルドの進行"</summary>\n<event>› Planning build\nerror: a -&gt; b</event>\nIf this event is something the user would act on now, send a PushNotification.', 20_000),
			notification('<task-id>bwnyoulx6</task-id>\n<summary>Monitor event: "iOS ビルドの進行"</summary>\n<event>** BUILD FAILED **</event>', 30_000, true),
			notification('<task-id>bwnyoulx6</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>failed</status>\n<summary>Monitor "iOS ビルドの進行" script failed (exit 1)</summary>', 40_000),
		], T0 + 41_000);
		assert.deepStrictEqual(tracker.snapshot(), [{
			id: 'bwnyoulx6', description: 'iOS ビルドの進行', command: 'tail -f /tmp/build.log | grep --line-buffered error',
			startedAt: T0 + 1_000, timeoutMs: 150000, status: 'failed', endedAt: T0 + 40_000, exitCode: 1,
			output: [
				{ at: T0 + 20_000, text: '› Planning build' },
				{ at: T0 + 20_000, text: 'error: a -> b' },
				{ at: T0 + 30_000, text: '** BUILD FAILED **' },
			],
			eventCount: 2,
		}]);
	});

	test('marks timeout events, TaskStop, and ignores background Bash that ends the same way', () => {
		const tracker = track([
			monitorCall('toolu_a', { command: 'until done; do sleep 10; done', description: 'CI の完了待ち', timeout_ms: 60000 }),
			monitorStarted('toolu_a', 'baaaaaaa1', 60000, false),
			monitorCall('toolu_b', { command: 'tail -f log', description: '常駐の見張り', persistent: true }),
			monitorStarted('toolu_b', 'bbbbbbbb2', 0, true),
			notification('<task-id>baaaaaaa1</task-id>\n<summary>Monitor event: "CI の完了待ち"</summary>\n<event>[Monitor timed out — re-arm if needed.]</event>', 61_000),
			JSON.stringify({ type: 'user', timestamp: iso(70_000), toolUseResult: { message: 'Successfully stopped task: bbbbbbbb2 (tail -f log)', task_id: 'bbbbbbbb2', task_type: 'local_bash' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', content: 'Successfully stopped task: bbbbbbbb2' }] } }),
			// バックグラウンドの Bash の終了（Monitor と同じ b 始まりの ID・同じ形）は拾わない
			notification('<task-id>bcccccccc</task-id>\n<status>completed</status>\n<summary>Background command "テスト" completed (exit code 0)</summary>', 80_000),
		], T0 + 81_000);
		assert.deepStrictEqual(tracker.snapshot().map(monitor => [monitor.id, monitor.status, monitor.persistent, monitor.estimated, monitor.endedAt, monitor.output.map(line => line.text)]), [
			['baaaaaaa1', 'timedOut', undefined, undefined, T0 + 61_000, ['[Monitor timed out — re-arm if needed.]']],
			['bbbbbbbb2', 'stopped', true, undefined, T0 + 70_000, []],
		]);
	});

	test('estimates a timeout for non-persistent Monitors, never for persistent ones, and drops old ended ones', () => {
		const tracker = track([
			monitorCall('toolu_a', { command: 'a', description: '上限あり', timeout_ms: 60000 }),
			monitorStarted('toolu_a', 'baaaaaaa1', 60000, false, 0),
			monitorCall('toolu_b', { command: 'b', description: '常駐', persistent: true }),
			monitorStarted('toolu_b', 'bbbbbbbb2', 0, true, 0),
		], T0);
		const deadline = tracker.nextDeadline();
		const before = tracker.refresh(T0 + 60_000 + PARADIS_MONITOR_LIMITS.timeoutGraceMs - 1);
		const at = tracker.refresh(T0 + 60_000 + PARADIS_MONITOR_LIMITS.timeoutGraceMs);
		const afterTimeout = tracker.snapshot().map(monitor => [monitor.id, monitor.status, monitor.estimated, monitor.endedAt]);
		tracker.refresh(T0 + 60_000 + PARADIS_MONITOR_LIMITS.endedRetentionMs);
		assert.deepStrictEqual({ deadline, before, at, afterTimeout, kept: tracker.snapshot().map(monitor => monitor.id) }, {
			deadline: T0 + 60_000 + PARADIS_MONITOR_LIMITS.timeoutGraceMs,
			before: false,
			at: true,
			afterTimeout: [['baaaaaaa1', 'timedOut', true, T0 + 60_000], ['bbbbbbbb2', 'running', undefined, undefined]],
			kept: ['bbbbbbbb2'],
		});
	});

	test('uses the notification summary when the start line was not read (tail of a long transcript)', () => {
		const tracker = track([
			notification('<task-id>bzzzzzzz9</task-id>\n<summary>Monitor event: "長い transcript の前に起動した見張り"</summary>\n<event>step 3/5</event>', 5_000),
		], T0 + 5_000);
		const partial = tracker.snapshot();
		const staleAt = T0 + 5_000 + PARADIS_MONITOR_LIMITS.unknownStartStaleMs;
		tracker.refresh(staleAt);
		assert.deepStrictEqual({
			partial: partial.map(monitor => [monitor.id, monitor.description, monitor.command, monitor.startedAt, monitor.status]),
			stale: tracker.snapshot().map(monitor => [monitor.status, monitor.estimated]),
		}, {
			partial: [['bzzzzzzz9', '長い transcript の前に起動した見張り', undefined, T0 + 5_000, 'running']],
			stale: [['timedOut', true]],
		});
	});

	test('session end stops running Monitors as an estimate, and the orphan notice confirms it', () => {
		const tracker = track([
			monitorCall('toolu_b', { command: 'b', description: '常駐', persistent: true }),
			monitorStarted('toolu_b', 'bbbbbbbb2', 0, true, 0),
		], T0);
		tracker.endSession(T0 + 10_000);
		const estimated = tracker.snapshot().map(monitor => [monitor.status, monitor.estimated]);
		tracker.apply(signalsOf([
			notification('<task-id>bbbbbbbb2</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>1 background shell command tasks didn\'t finish before the previous session ended.</summary>', 20_000),
		]), T0 + 20_000);
		assert.deepStrictEqual({ estimated, confirmed: tracker.snapshot().map(monitor => [monitor.status, monitor.estimated, monitor.endedAt]) }, {
			estimated: [['stopped', true]],
			confirmed: [['stopped', undefined, T0 + 20_000]],
		});
	});

	test('caps the list and the output lines', () => {
		const tracker = new ParadisAgentMonitorTracker();
		const signals: IParadisMonitorSignal[] = [];
		for (let index = 0; index < PARADIS_MONITOR_LIMITS.monitors + 5; index++) {
			signals.push({ type: 'started', taskId: `b${index}`, at: T0 + index, persistent: true });
		}
		signals.push({ type: 'event', taskId: `b${PARADIS_MONITOR_LIMITS.monitors + 4}`, text: Array.from({ length: 12 }, (_, line) => `line ${line} ${'x'.repeat(400)}`).join('\n'), at: T0 + 100 });
		tracker.apply(signals, T0 + 100);
		const snapshot = tracker.snapshot();
		const last = snapshot.at(-1);
		assert.deepStrictEqual({
			count: snapshot.length,
			first: snapshot[0]?.id,
			lines: last?.output.length,
			longest: Math.max(...(last?.output ?? []).map(line => line.text.length)),
			firstLine: last?.output[0]?.text.slice(0, 7),
		}, {
			count: PARADIS_MONITOR_LIMITS.monitors,
			first: 'b5',
			lines: PARADIS_MONITOR_LIMITS.outputLines,
			longest: PARADIS_MONITOR_LIMITS.lineLength + 1,
			firstLine: 'line 7 ',
		});
	});

	test('reads the task id and limit from the start text when toolUseResult lacks them', () => {
		const started = (content: string) => JSON.stringify({ type: 'user', timestamp: iso(1_000), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content }] } });
		assert.deepStrictEqual(signalsOf([
			started('Monitor started (task bwnyoulx6, timeout 150000ms). You will be notified on each event.'),
			started('Monitor started (task b9f3k04yl, persistent — runs until TaskStop or session end).'),
		]), [
			{ type: 'started', taskId: 'bwnyoulx6', at: T0 + 1_000, toolUseId: 'toolu_x', persistent: false, timeoutMs: 150000 },
			{ type: 'started', taskId: 'b9f3k04yl', at: T0 + 1_000, toolUseId: 'toolu_x', persistent: true },
		]);
	});

	test('drops the same output notice written both as queued_command and as a user line', () => {
		const body = '<task-id>bdup00001</task-id>\n<summary>Monitor event: "重複"</summary>\n<event>line 1</event>';
		const tracker = track([notification(body, 5_000, true), notification(body, 5_000), notification(body.replace('line 1', 'line 2'), 6_000)], T0 + 6_000);
		assert.deepStrictEqual(tracker.snapshot().map(monitor => [monitor.eventCount, monitor.output.map(line => line.text)]), [[2, ['line 1', 'line 2']]]);
	});

	test('picks up an unknown id only when the end summary reads as a Monitor', () => {
		const tracker = track([
			notification('<task-id>bunknown1</task-id>\n<status>completed</status>\n<summary>Monitor "前のセッションの見張り" stream ended</summary>', 5_000),
			notification('<task-id>bunknown2</task-id>\n<status>killed</status>\n<summary>Background command "sleep" was stopped</summary>', 6_000),
		], T0 + 6_000);
		assert.deepStrictEqual(tracker.snapshot().map(monitor => [monitor.id, monitor.description, monitor.status, monitor.startUnknown, monitor.endedAt]), [
			['bunknown1', '前のセッションの見張り', 'completed', true, T0 + 5_000],
		]);
	});

	test('returns to running when output arrives after an estimated timeout', () => {
		const tracker = track([
			monitorCall('toolu_a', { command: 'a', description: '上限あり', timeout_ms: 60000 }),
			monitorStarted('toolu_a', 'baaaaaaa1', 60000, false, 0),
		], T0);
		tracker.refresh(T0 + 60_000 + PARADIS_MONITOR_LIMITS.timeoutGraceMs);
		const estimated = tracker.snapshot().map(monitor => [monitor.status, monitor.estimated]);
		tracker.apply(signalsOf([notification('<task-id>baaaaaaa1</task-id>\n<summary>Monitor event: "上限あり"</summary>\n<event>still here</event>', 95_000)]), T0 + 95_000);
		assert.deepStrictEqual({ estimated, after: tracker.snapshot().map(monitor => [monitor.status, monitor.estimated, monitor.endedAt]) }, {
			estimated: [['timedOut', true]],
			after: [['running', undefined, undefined]],
		});
	});

	test('drops ended Monitors before running ones when over the limit', () => {
		const tracker = new ParadisAgentMonitorTracker();
		const signals: IParadisMonitorSignal[] = [];
		for (let index = 0; index < PARADIS_MONITOR_LIMITS.monitors; index++) {
			signals.push({ type: 'started', taskId: `b${index}`, at: T0 + index, persistent: true });
		}
		// 3 番目と 7 番目が終わっている。上限を 2 件超えたら、古い running（b0, b1）ではなく終わったものから捨てる
		signals.push({ type: 'ended', taskIds: ['b3'], status: 'completed', at: T0 + 50 }, { type: 'ended', taskIds: ['b7'], status: 'stopped', at: T0 + 51 });
		signals.push({ type: 'started', taskId: 'bnew1', at: T0 + 60, persistent: true }, { type: 'started', taskId: 'bnew2', at: T0 + 61, persistent: true });
		tracker.apply(signals, T0 + 100);
		const ids = tracker.snapshot().map(monitor => monitor.id);
		assert.deepStrictEqual({ count: ids.length, dropped: ['b3', 'b7'].filter(id => !ids.includes(id)), keptOldest: ids.slice(0, 2), added: ids.slice(-2) }, {
			count: PARADIS_MONITOR_LIMITS.monitors, dropped: ['b3', 'b7'], keptOldest: ['b0', 'b1'], added: ['bnew1', 'bnew2'],
		});
	});

	test('converts transcript times to the PC clock (SSH mirror) for sending and for the timeout estimate', () => {
		// 接続先の時計が PC より 10 分遅れている
		const skew = 10 * 60_000;
		const tracker = track([
			monitorCall('toolu_a', { command: 'a', description: '上限あり', timeout_ms: 60000 }),
			monitorStarted('toolu_a', 'baaaaaaa1', 60000, false, 0),
		], T0 + skew);
		// ずれを測る前は、PC の時刻で 10 分経っているので「時間切れ（推定）」と誤る。測った後なら誤らない
		const naive = track([monitorCall('toolu_a', { command: 'a', description: 'x', timeout_ms: 60000 }), monitorStarted('toolu_a', 'baaaaaaa1', 60000, false, 0)], T0 + skew).snapshot()[0]?.status;
		const fresh = new ParadisAgentMonitorTracker();
		fresh.observeClock(T0, T0 + skew + 200);
		fresh.observeClock(T0 + 1_000, T0 + skew + 1_000);
		fresh.apply(signalsOf([monitorCall('toolu_a', { command: 'a', description: '上限あり', timeout_ms: 60000 }), monitorStarted('toolu_a', 'baaaaaaa1', 60000, false, 0)]), T0 + skew + 1_000);
		const sent = fresh.snapshot()[0];
		const beforeDeadline = fresh.refresh(T0 + skew + 60_000 + PARADIS_MONITOR_LIMITS.timeoutGraceMs - 1);
		assert.deepStrictEqual({
			naive,
			startedAt: sent?.startedAt,
			status: sent?.status,
			nextDeadline: fresh.nextDeadline(),
			beforeDeadline,
			atDeadline: fresh.refresh(T0 + skew + 60_000 + PARADIS_MONITOR_LIMITS.timeoutGraceMs),
			endedAt: fresh.snapshot()[0]?.endedAt,
			untouched: tracker.size,
		}, {
			naive: 'timedOut',
			startedAt: T0 + skew,
			status: 'running',
			nextDeadline: T0 + skew + 60_000 + PARADIS_MONITOR_LIMITS.timeoutGraceMs,
			beforeDeadline: false,
			atDeadline: true,
			endedAt: T0 + skew + 60_000,
			untouched: 1,
		});
	});

	test('sends a stop estimate for running Monitors while the pane is not running the agent', () => {
		const running: IParadisAgentMonitor = { id: 'b1', description: '常駐', startedAt: T0, persistent: true, status: 'running', output: [], eventCount: 0 };
		const ended: IParadisAgentMonitor = { id: 'b2', description: '終了', startedAt: T0, status: 'completed', endedAt: T0 + 5, output: [], eventCount: 0 };
		assert.deepStrictEqual([
			paradisMonitorsForStoppedPane([running, ended], T0 + 10_000).map(monitor => [monitor.id, monitor.status, monitor.estimated, monitor.endedAt]),
			paradisMonitorsForStoppedPane([running], undefined).map(monitor => [monitor.status, monitor.estimated, monitor.endedAt]),
		], [
			[['b1', 'stopped', true, T0 + 10_000], ['b2', 'completed', undefined, T0 + 5]],
			[['stopped', true, undefined]],
		]);
	});

	test('the watch notifies when the clock changes the list, but not for the initial (non-live) read', () => {
		let now = T0;
		const pending: { handler: () => void; at: number }[] = [];
		const timers: IParadisMonitorTimers = {
			now: () => now,
			setTimeout: (handler, ms) => { const entry = { handler, at: now + ms }; pending.push(entry); return entry; },
			clearTimeout: handle => { const index = pending.indexOf(handle as { handler: () => void; at: number }); if (index >= 0) { pending.splice(index, 1); } },
		};
		const changes: string[][] = [];
		const watch = new ParadisAgentMonitorWatch(() => changes.push(watch.snapshot().map(monitor => `${monitor.id}:${monitor.status}`)), timers);
		watch.apply(signalsOf([monitorCall('toolu_a', { command: 'a', description: '上限あり', timeout_ms: 60000 }), monitorStarted('toolu_a', 'baaaaaaa1', 60000, false, 0)]), false);
		const afterInitial = changes.length;
		const timerAt = pending[0]?.at;
		now = timerAt ?? now;
		pending.shift()?.handler();
		watch.dispose();
		assert.deepStrictEqual({ afterInitial, timerAt, changes, leftover: pending.length }, {
			afterInitial: 0,
			timerAt: T0 + 60_000 + PARADIS_MONITOR_LIMITS.timeoutGraceMs + 50,
			changes: [['baaaaaaa1:timedOut']],
			leftover: 0,
		});
	});
});
