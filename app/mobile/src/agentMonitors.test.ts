// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	MONITOR_PILL_LINGER_MS,
	formatMonitorDuration,
	localizeAgentMonitors,
	monitorElapsedLabel,
	monitorLimitLabel,
	monitorPillSummary,
	monitorStatusLabel,
	nextMonitorPillChange,
	parseAgentMonitors,
	partitionMonitors,
	type AgentMonitor,
} from './agentMonitors.js';

const NOW = 1_760_000_000_000;

function monitor(id: string, extra: Partial<AgentMonitor> = {}): AgentMonitor {
	return { id, description: `説明 ${id}`, startedAt: NOW - 300_000, status: 'running', output: [], eventCount: 0, ...extra };
}

describe('monitorPillSummary', () => {
	test('一覧が無い（古い PC）・空・終わってから 1 分を過ぎたものだけなら出さない', () => {
		expect([
			monitorPillSummary(undefined, NOW),
			monitorPillSummary([], NOW),
			monitorPillSummary([monitor('b1', { status: 'completed', endedAt: NOW - MONITOR_PILL_LINGER_MS })], NOW),
		]).toEqual([undefined, undefined, undefined]);
	});

	test('実行中は件数を 2 件以上のときだけ出し、終わったものは 1 分だけ終わり方を出す', () => {
		const ended = monitor('b3', { status: 'completed', endedAt: NOW - 10_000 });
		expect({
			one: monitorPillSummary([monitor('b1')], NOW)?.label,
			two: monitorPillSummary([monitor('b1'), monitor('b2'), ended], NOW)?.label,
			ended: monitorPillSummary([ended], NOW),
			failed: monitorPillSummary([ended, monitor('b4', { status: 'failed', endedAt: NOW - 20_000, exitCode: 1 })], NOW)?.label,
			stoppedLater: monitorPillSummary([ended, monitor('b5', { status: 'stopped', endedAt: NOW - 1_000 })], NOW)?.label,
			afterLinger: monitorPillSummary([ended], NOW + MONITOR_PILL_LINGER_MS)?.label,
		}).toEqual({
			one: 'Monitor',
			two: 'Monitor 2',
			ended: { tone: 'done', label: 'Monitor 終了', accessibilityLabel: 'Monitor が終了しました。押すと一覧を開きます' },
			failed: 'Monitor 失敗',
			stoppedLater: 'Monitor 停止',
			afterLinger: undefined,
		});
	});

	test('次に描き直す時刻は、いちばん早く 1 分を過ぎるもの', () => {
		expect([
			nextMonitorPillChange([monitor('b1'), monitor('b2', { status: 'completed', endedAt: NOW - 50_000 }), monitor('b3', { status: 'failed', endedAt: NOW - 10_000 })], NOW),
			nextMonitorPillChange([monitor('b1')], NOW),
		]).toEqual([NOW - 50_000 + MONITOR_PILL_LINGER_MS, undefined]);
	});
});

describe('parseAgentMonitors', () => {
	test('形の合わない要素は捨て、任意項目は持っているものだけ残す', () => {
		expect(parseAgentMonitors([
			{ id: 'b1', description: 'ビルド', command: 'tail -f build.log', startedAt: NOW, timeoutMs: 900_000, status: 'running', output: [{ at: NOW, text: '› Planning build' }, { at: 'x', text: 1 }], eventCount: 1 },
			{ id: 'b2', description: '常駐', startedAt: NOW, persistent: true, status: 'timedOut', estimated: true, endedAt: NOW + 1, output: [] },
			{ id: 'b3', description: '不明な状態', startedAt: NOW, status: 'paused', output: [] },
			null,
		])).toEqual([
			{ id: 'b1', description: 'ビルド', command: 'tail -f build.log', startedAt: NOW, timeoutMs: 900_000, status: 'running', output: [{ at: NOW, text: '› Planning build' }], eventCount: 1 },
			{ id: 'b2', description: '常駐', startedAt: NOW, persistent: true, status: 'timedOut', estimated: true, endedAt: NOW + 1, output: [], eventCount: 0 },
		]);
		expect(parseAgentMonitors(undefined)).toBeUndefined();
	});
});

describe('表示の文字', () => {
	test('経過時間・上限・終わり方', () => {
		expect({
			durations: [formatMonitorDuration(12_400), formatMonitorDuration(332_000), formatMonitorDuration(3_900_000)],
			limits: [monitorLimitLabel({ timeoutMs: 1_800_000 }), monitorLimitLabel({ timeoutMs: 5_400_000 }), monitorLimitLabel({ persistent: true }), monitorLimitLabel({})],
			statuses: [
				monitorStatusLabel(monitor('b1')),
				monitorStatusLabel(monitor('b2', { status: 'failed', exitCode: 1 })),
				monitorStatusLabel(monitor('b3', { status: 'timedOut', estimated: true })),
				monitorStatusLabel(monitor('b4', { status: 'completed' })),
			],
		}).toEqual({
			durations: ['12秒', '5分32秒', '1時間5分'],
			limits: ['上限 30分', '上限 1時間30分', '常駐', undefined],
			statuses: [undefined, '失敗（exit 1）', '時間切れ（推定）', '終了'],
		});
	});

	test('ドロワーは実行中を起動の古い順、終わったものを新しく終わった順に並べる', () => {
		const { running, ended } = partitionMonitors([
			monitor('r2', { startedAt: NOW - 10 }),
			monitor('e1', { status: 'completed', endedAt: NOW - 100 }),
			monitor('r1', { startedAt: NOW - 20 }),
			monitor('e2', { status: 'stopped', endedAt: NOW - 50 }),
		]);
		expect({ running: running.map(item => item.id), ended: ended.map(item => item.id) }).toEqual({ running: ['r1', 'r2'], ended: ['e2', 'e1'] });
	});
});

describe('localizeAgentMonitors（PC との時計のずれ）', () => {
	test('PC の送信時刻との差を全部の時刻に足し、1 分の判定を手元の時計で正しく行う', () => {
		// PC の時計がスマホより 5 分進んでいる。PC の時計で 10 秒前に終わったものは、スマホの時計でも 10 秒前に終わったことになる
		const pcNow = NOW + 300_000;
		const fromPc = [monitor('b1', { status: 'completed', startedAt: pcNow - 70_000, endedAt: pcNow - 10_000, output: [{ at: pcNow - 20_000, text: 'done' }] })];
		const localized = localizeAgentMonitors(fromPc, pcNow, NOW);
		expect({
			times: localized.map(item => [item.startedAt, item.endedAt, item.output[0]?.at]),
			withoutShift: monitorPillSummary(fromPc, NOW)?.label,
			shifted: monitorPillSummary(localized, NOW)?.label,
			afterMinute: monitorPillSummary(localized, NOW + 50_000)?.label,
			legacyPc: localizeAgentMonitors(fromPc, undefined, NOW)[0]?.endedAt,
		}).toEqual({
			times: [[NOW - 70_000, NOW - 10_000, NOW - 20_000]],
			// 直さないと、手元の時計では「まだ 5 分先に終わる」ものになり、1 分を過ぎても残り続ける
			withoutShift: 'Monitor 終了',
			shifted: 'Monitor 終了',
			afterMinute: undefined,
			legacyPc: pcNow - 10_000,
		});
		expect(monitorPillSummary(fromPc, NOW + 50_000)?.label).toBe('Monitor 終了');
	});

	test('起動を PC が読めなかったものの経過時間には「以上」を付ける', () => {
		expect([
			monitorElapsedLabel({ startedAt: NOW - 90_000 }, NOW),
			monitorElapsedLabel({ startedAt: NOW - 90_000, startUnknown: true }, NOW),
		]).toEqual(['1分30秒', '1分30秒以上']);
	});
});
