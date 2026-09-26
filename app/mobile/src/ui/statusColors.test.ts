// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { colors } from '../theme.js';
import {
	agentDotColor,
	agentKindFromStatus,
	connectionColor,
	connectionKind,
	connectionLabel,
	isSpinningKind,
	meterColor,
	meterPercent,
	meterValueLabel,
} from './statusColors.js';

describe('connectionKind', () => {
	test('リレーにつながり Para Code も動いていれば接続中（緑）', () => {
		expect(connectionKind('online', true)).toBe('connected');
		expect(connectionColor('connected')).toBe(colors.green);
		expect(connectionLabel('connected')).toBe('接続中');
	});

	test('リレーにはつながっているが Para Code が落ちていれば PC オフライン（赤）で、ただのオフラインと分ける', () => {
		expect(connectionKind('online', false)).toBe('pcOffline');
		expect(connectionColor('pcOffline')).toBe(colors.red);
	});

	test('接続の途中は琥珀', () => {
		expect(connectionKind('connecting', false)).toBe('connecting');
		expect(connectionKind('handshaking', true)).toBe('connecting');
		expect(connectionColor('connecting')).toBe(colors.amber);
	});

	test('切れていれば弱い灰', () => {
		expect(connectionKind('offline', true)).toBe('offline');
		expect(connectionColor('offline')).toBe(colors.textMuted);
	});
});

describe('エージェントの状態の点', () => {
	test('要対応=赤、実行中=黄、未確認=緑、待機=薄い灰', () => {
		expect(agentDotColor('attention')).toBe(colors.red);
		expect(agentDotColor('running')).toBe(colors.yellow);
		expect(agentDotColor('review')).toBe(colors.emerald);
		expect(agentDotColor('idle')).toBe(colors.idleDot);
	});

	test('回るのは実行中だけ', () => {
		expect(isSpinningKind('running')).toBe(true);
		expect(isSpinningKind('attention')).toBe(false);
		expect(isSpinningKind('review')).toBe(false);
		expect(isSpinningKind('idle')).toBe(false);
	});

	test('PC から届いた状態の文字列は既存の判定（agentStatusKind）で畳む', () => {
		expect(agentKindFromStatus('permission')).toBe('attention');
		expect(agentKindFromStatus('question')).toBe('attention');
		expect(agentKindFromStatus('working')).toBe('running');
		expect(agentKindFromStatus('done')).toBe('review');
		expect(agentKindFromStatus(undefined)).toBe('idle');
	});
});

describe('メーター', () => {
	test('値は四捨五入して 0〜100 に収める', () => {
		expect(meterPercent(42.4)).toBe(42);
		expect(meterPercent(42.5)).toBe(43);
		expect(meterPercent(-5)).toBe(0);
		expect(meterPercent(130)).toBe(100);
		expect(meterPercent(undefined)).toBeUndefined();
		expect(meterPercent(Number.NaN)).toBeUndefined();
	});

	test('60% 未満は緑、60〜79% は琥珀、80% 以上は赤', () => {
		expect(meterColor(0)).toBe(colors.green);
		expect(meterColor(59)).toBe(colors.green);
		expect(meterColor(60)).toBe(colors.amber);
		expect(meterColor(79)).toBe(colors.amber);
		expect(meterColor(80)).toBe(colors.red);
		expect(meterColor(100)).toBe(colors.red);
	});

	test('値が無いときは灰とダッシュ', () => {
		expect(meterColor(undefined)).toBe(colors.textMuted);
		expect(meterValueLabel(undefined)).toBe('—');
		expect(meterValueLabel(71)).toBe('71%');
	});
});
