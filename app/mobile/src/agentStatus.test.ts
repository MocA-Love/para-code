// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { activityStatusColor, activityStatusKind, agentStatusColor, agentStatusKind, agentStatusLabel } from './agentStatus.js';
import { colors } from './theme.js';

describe('agentStatusKind', () => {
	test('許可待ちと質問はどちらも要対応', () => {
		expect(agentStatusKind('permission')).toBe('attention');
		expect(agentStatusKind('question')).toBe('attention');
	});

	test('動いていないエージェントは待機、作業を終えたものは未確認', () => {
		expect(agentStatusKind(undefined)).toBe('idle');
		expect(agentStatusKind('working')).toBe('running');
		expect(agentStatusKind('review')).toBe('review');
	});
});

describe('agentStatusLabel', () => {
	test('要対応は何を待っているかを具体的に書く', () => {
		expect(agentStatusLabel('permission')).toBe('許可待ち');
		expect(agentStatusLabel('question')).toBe('質問');
	});

	test('それ以外は状態表の呼び名', () => {
		expect(agentStatusLabel('working')).toBe('実行中');
		expect(agentStatusLabel('review')).toBe('未確認');
		expect(agentStatusLabel(undefined)).toBe('待機');
	});
});

describe('色の割り当て', () => {
	test('同じ状態は画面をまたいで同じ色になる', () => {
		expect(agentStatusColor('permission')).toBe(colors.red);
		// 色は Orca の AgentSpinner / AgentStateDot に合わせた（実行中=黄、未確認=緑）
		expect(agentStatusColor('working')).toBe(colors.yellow);
		expect(agentStatusColor('review')).toBe(colors.emerald);
		expect(agentStatusColor(undefined)).toBe(colors.idle);
	});

	test('サブエージェントの失敗はエラー、中断と不明は待機と同じ灰', () => {
		expect(activityStatusKind('failed')).toBe('error');
		expect(activityStatusColor('running')).toBe(colors.yellow);
		expect(activityStatusColor('completed')).toBe(colors.emerald);
		expect(activityStatusColor('interrupted')).toBe(colors.idle);
		expect(activityStatusColor('unknown')).toBe(colors.idle);
	});
});
