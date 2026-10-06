// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';
import { MONITOR_PILL_LINGER_MS, type AgentMonitor } from './agentMonitors.js';
import {
	SHELL_OUTPUT_BUSY_RETRY_MS,
	SHELL_OUTPUT_POLL_MS,
	ShellOutputBusyError,
	ShellOutputPoller,
	backgroundPillSummary,
	localizeAgentShells,
	nextShellPillChange,
	parseAgentShells,
	parseAgentShellsAccess,
	parseShellOutputReply,
	partitionShells,
	shellDurationLabel,
	shellOutputErrorMessage,
	shellOutputUnavailableReason,
	shellStatusLabel,
	shellStopState,
	shellTitle,
	type AgentShell,
} from './agentShells.js';

const NOW = 1_760_000_100_000;

function shell(id: string, overrides: Partial<AgentShell> = {}): AgentShell {
	return { id, command: `cmd ${id}`, startedAt: NOW - 60_000, status: 'running', ...overrides };
}

function monitor(id: string, overrides: Partial<AgentMonitor> = {}): AgentMonitor {
	return { id, description: id, startedAt: NOW - 60_000, status: 'running', output: [], eventCount: 0, ...overrides };
}

describe('agentShells', () => {
	it('parses shells and the access, dropping malformed ones; old PCs send nothing', () => {
		expect({
			old: parseAgentShells(undefined),
			parsed: parseAgentShells([
				{ id: 'b1', command: 'npm run dev', startedAt: 1, status: 'running', movedToBackground: 'timeout' },
				{ id: 'b2', startedAt: 2, status: 'stopped', stoppedBy: 'user', endedAt: 3, exitCode: 143.7, estimated: true },
				{ id: '../x', startedAt: 1, status: 'running' },
				{ id: 'b3', startedAt: 'x', status: 'running' },
				{ id: 'b4', startedAt: 1, status: 'exploded' },
			]),
			access: [
				parseAgentShellsAccess({ output: true, stop: true }),
				// SSH の接続先は、接続先で読める PC なら出力だけ読める（止めない）。古い PC は output: false を送る
				parseAgentShellsAccess({ output: true, stop: true, where: 'ssh' }),
				parseAgentShellsAccess({ output: false, stop: false, where: 'ssh' }),
				parseAgentShellsAccess({ output: true, stop: true, where: 'wsl' }),
				parseAgentShellsAccess(undefined),
			],
		}).toEqual({
			old: undefined,
			parsed: [
				{ id: 'b1', command: 'npm run dev', startedAt: 1, status: 'running', movedToBackground: 'timeout' },
				{ id: 'b2', startedAt: 2, status: 'stopped', stoppedBy: 'user', endedAt: 3, exitCode: 143, estimated: true },
			],
			access: [{ output: true, stop: true }, { output: true, stop: false, where: 'ssh' }, { output: false, stop: false, where: 'ssh' }, { output: false, stop: false, where: 'wsl' }, undefined],
		});
	});

	it('moves PC times to the local clock with shellsAt', () => {
		expect(localizeAgentShells([shell('b1', { startedAt: 100, endedAt: 200, status: 'completed' })], 1_000, 1_500)).toEqual([shell('b1', { startedAt: 600, endedAt: 700, status: 'completed' })]);
	});

	it('pill: Monitor only stays as before, shells only say Shell, both say 実行中 N', () => {
		const monitors = [monitor('m1')];
		const running = [shell('b1'), shell('b2')];
		expect([
			backgroundPillSummary(monitors, undefined, NOW)?.label,
			backgroundPillSummary(undefined, [shell('b1')], NOW)?.label,
			backgroundPillSummary(undefined, running, NOW)?.label,
			backgroundPillSummary(monitors, running, NOW),
			backgroundPillSummary(undefined, [shell('b1', { status: 'failed', endedAt: NOW - 1_000, exitCode: 2 })], NOW)?.label,
			backgroundPillSummary([monitor('m1', { status: 'completed', endedAt: NOW - 1_000 })], [shell('b1', { status: 'completed', endedAt: NOW - 5_000 })], NOW)?.label,
			backgroundPillSummary(undefined, [shell('b1', { status: 'completed', endedAt: NOW - MONITOR_PILL_LINGER_MS })], NOW),
		]).toEqual([
			'Monitor',
			'Shell',
			'Shell 2',
			{ tone: 'running', label: '実行中 3', accessibilityLabel: 'シェルが 2 件、Monitor が 1 件実行中。押すと一覧を開きます', tab: 'shells' },
			'Shell 失敗',
			'Monitor 終了',
			undefined,
		]);
	});

	it('labels, titles, durations, order and the next pill change', () => {
		const ended = [
			shell('b1', { status: 'completed', exitCode: 0, endedAt: NOW - 30_000 }),
			shell('b2', { status: 'stopped', stoppedBy: 'user', endedAt: NOW - 10_000 }),
			shell('b3', { status: 'stopped', estimated: true, endedAt: NOW - 20_000 }),
			shell('b4', { status: 'stopped', stoppedBy: 'mobile', endedAt: NOW - 5_000 }),
		];
		expect({
			labels: [...ended, shell('b5', { status: 'failed', exitCode: 2 }), shell('b6'), shell('b7', { status: 'failed', exitCode: 1, estimated: true })].map(shellStatusLabel),
			titles: [shellTitle({ id: 'b1', command: '\n  npm run dev\nnext' }), shellTitle({ id: 'b2', description: 'ビルド' }), shellTitle({ id: 'b3' })],
			durations: [shellDurationLabel(shell('b1'), NOW), shellDurationLabel(shell('b1', { startUnknown: true }), NOW), shellDurationLabel(ended[0]!, NOW)],
			order: partitionShells([...ended, shell('r2', { startedAt: NOW - 1_000 }), shell('r1', { startedAt: NOW - 9_000 })]),
			next: nextShellPillChange(ended, NOW),
		}).toEqual({
			labels: ['終了（exit 0）', 'TUI で停止', '停止（推定）', 'アプリから停止', '失敗（exit 2）', '実行中', '失敗（exit 1）（推定）'],
			titles: ['npm run dev', 'ビルド', 'b3'],
			durations: ['1分00秒', '1分00秒以上', '30秒'],
			order: {
				running: [shell('r1', { startedAt: NOW - 9_000 }), shell('r2', { startedAt: NOW - 1_000 })],
				ended: [ended[3], ended[1], ended[2], ended[0]],
			},
			next: NOW - 30_000 + MONITOR_PILL_LINGER_MS,
		});
	});

	it('the stop button: shown only with Claude Mods and a connected PC, disabled with a reason on SSH, WSL and Windows', () => {
		const running = shell('b1');
		expect([
			shellStopState(running, { output: true, stop: true }, true),
			shellStopState(running, { output: true, stop: true }, false),
			shellStopState(running, { output: true, stop: false }, true),
			shellStopState(shell('b1', { status: 'completed' }), { output: true, stop: true }, true),
			shellStopState(shell('b1', { status: 'completed', estimated: true }), { output: true, stop: true }, true),
			shellStopState(running, { output: false, stop: false, where: 'ssh' }, true).kind,
			shellStopState(running, undefined, true),
			shellOutputUnavailableReason({ output: true, stop: false }),
			shellOutputUnavailableReason({ output: false, stop: false, where: 'wsl' })?.startsWith('WSL'),
			shellOutputUnavailableReason({ output: true, stop: false, where: 'ssh' }),
			shellOutputUnavailableReason({ output: false, stop: false, where: 'ssh' })?.startsWith('SSH'),
			shellStopState(running, { output: true, stop: false, where: 'ssh' }, true).kind,
		]).toEqual([
			{ kind: 'enabled' },
			{ kind: 'hidden' },
			{ kind: 'hidden' },
			{ kind: 'hidden' },
			{ kind: 'enabled' },
			'disabled',
			{ kind: 'hidden' },
			undefined,
			true,
			undefined,
			true,
			'disabled',
		]);
	});

	it('reads the shell-output reply', () => {
		const reply = parseShellOutputReply({ shells: [{ id: 'b1', lines: ['a', 7, 'b'], truncated: true }, { id: 'b2', error: 'not-found' }, { id: 'b3', error: 'no-window' }, { id: 'b4', error: 'exploded' }, { id: '../x', lines: [] }], readAt: 5 });
		expect({ outputs: [...(reply?.outputs.entries() ?? [])], readAt: reply?.readAt, failed: parseShellOutputReply({ error: 'busy' })?.error, broken: parseShellOutputReply({}) }).toEqual({
			outputs: [['b1', { lines: ['a', 'b'], truncated: true }], ['b2', { lines: [], truncated: false, error: 'not-found' }], ['b3', { lines: [], truncated: false, error: 'no-window' }], ['b4', { lines: [], truncated: false }]],
			readAt: 5,
			failed: 'busy',
			broken: undefined,
		});
	});

	it('says why the output could not be read, pointing at the window of the host for SSH', () => {
		expect((['not-found', 'unavailable', 'no-window'] as const).map(shellOutputErrorMessage)).toEqual([
			'出力のファイルが見つかりません（消えたか、PC が再起動しました）。',
			'この PC からは出力を読めません。',
			'この接続先のウィンドウを PC で開くと読めます。',
		]);
	});

	describe('ShellOutputPoller', () => {
		const empty = { outputs: new Map() };
		function deferred() {
			let resolve!: (value: typeof empty) => void;
			let reject!: (error: unknown) => void;
			const promise = new Promise<typeof empty>((res, rej) => { resolve = res; reject = rej; });
			return { promise, resolve, reject };
		}

		it('loads at once even while the previous poller is still waiting, and reads once more after an overlapping tick', async () => {
			vi.useFakeTimers();
			try {
				const pending: ReturnType<typeof deferred>[] = [];
				const request = () => { const next = deferred(); pending.push(next); return next.promise; };
				const results: unknown[] = [];
				const first = new ShellOutputPoller(request, result => results.push(['first', result]), true);
				// 組み合わせが変わった（作り直し）。前の読みは終わっていないが、新しい方はすぐ読む
				first.dispose();
				const second = new ShellOutputPoller(request, result => results.push(['second', result]), true);
				const startedAtOnce = pending.length;
				// 読んでいる間に 2 回時計が来ても重ねない。終わったら 1 回だけ読み直す
				vi.advanceTimersByTime(SHELL_OUTPUT_POLL_MS * 2);
				const whileWaiting = pending.length;
				pending[0]!.resolve(empty);
				pending[1]!.resolve(empty);
				await vi.advanceTimersByTimeAsync(0);
				const afterDone = pending.length;
				second.dispose();
				expect({ startedAtOnce, whileWaiting, afterDone, results: results.map(entry => (entry as unknown[])[0]) }).toEqual({ startedAtOnce: 2, whileWaiting: 2, afterDone: 3, results: ['second'] });
			} finally {
				vi.useRealTimers();
			}
		});

		it('retries once after a busy answer, and shows the error when the retry is busy too', async () => {
			vi.useFakeTimers();
			try {
				let calls = 0;
				const results: unknown[] = [];
				const poller = new ShellOutputPoller(async () => {
					calls++;
					throw new ShellOutputBusyError();
				}, result => results.push(result), false);
				await vi.advanceTimersByTimeAsync(0);
				const beforeRetry = calls;
				await vi.advanceTimersByTimeAsync(SHELL_OUTPUT_BUSY_RETRY_MS);
				await vi.advanceTimersByTimeAsync(SHELL_OUTPUT_BUSY_RETRY_MS * 4);
				poller.dispose();
				expect({ beforeRetry, calls, results }).toEqual({ beforeRetry: 1, calls: 2, results: [{ error: '出力を読み込み中です' }] });
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
