// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	clampAgentsLimit,
	DEFAULT_WIDGET_SETTINGS,
	moveMetric,
	normalizeWidgetSettings,
	parseWidgetSettings,
	resolveWidgetAccentHex,
	serializeWidgetSettings,
	toggleAgentFilter,
	toggleMetric,
	WIDGET_AGENTS_LIMIT_MAX,
	WIDGET_AGENTS_LIMIT_MIN,
} from './settings.js';

describe('widget settings', () => {
	it('hides question text and commands by default', () => {
		expect(DEFAULT_WIDGET_SETTINGS.showDetail).toBe(false);
		expect(parseWidgetSettings(undefined).showDetail).toBe(false);
	});

	it('falls back to the defaults for broken input', () => {
		expect(parseWidgetSettings('{')).toBe(DEFAULT_WIDGET_SETTINGS);
		expect(normalizeWidgetSettings(null)).toBe(DEFAULT_WIDGET_SETTINGS);
		expect(normalizeWidgetSettings([])).toBe(DEFAULT_WIDGET_SETTINGS);
	});

	it('fills only the missing or wrong fields', () => {
		const parsed = normalizeWidgetSettings({
			accent: 'green',
			showDetail: true,
			freshness: 'sometimes',
			attention: { order: 'newest', showApprove: 'yes' },
			agents: { states: ['idle', 'bogus', 'idle', 'running'], limit: 99 },
			pc: { metrics: ['cost', 'cpu', 'nope'] },
			space: { defaultSpace: { pcId: 'pc-a', spaceId: '1:w1' }, showCommits: false },
		});
		expect(parsed.accent).toBe('green');
		expect(parsed.showDetail).toBe(true);
		expect(parsed.freshness).toBe('always');
		expect(parsed.attention).toEqual({ order: 'newest', showApprove: true, showAnswer: true, showReview: true });
		expect(parsed.agents).toEqual({ states: ['idle', 'running'], order: 'attention', limit: WIDGET_AGENTS_LIMIT_MAX });
		expect(parsed.pc.metrics).toEqual(['cost', 'cpu']);
		expect(parsed.space).toEqual({ defaultSpace: { pcId: 'pc-a', spaceId: '1:w1' }, showAgents: true, showChanges: true, showCommits: false });
	});

	it('drops a malformed default space', () => {
		expect(normalizeWidgetSettings({ space: { defaultSpace: { pcId: '', spaceId: 'x' } } }).space.defaultSpace).toBeUndefined();
	});

	it('keeps the agents limit in range', () => {
		expect(clampAgentsLimit(1)).toBe(WIDGET_AGENTS_LIMIT_MIN);
		expect(clampAgentsLimit(5.4)).toBe(5);
		expect(clampAgentsLimit('7')).toBe(DEFAULT_WIDGET_SETTINGS.agents.limit);
	});

	it('resolves the accent color for the widget', () => {
		expect(resolveWidgetAccentHex('mono', '#ffffff')).toBeUndefined();
		expect(resolveWidgetAccentHex('theme', '#09AFD9')).toBe('#09afd9');
		expect(resolveWidgetAccentHex('theme', 'red')).toBeUndefined();
		expect(resolveWidgetAccentHex('blue', undefined)).toBe('#3b82f6');
		const json = JSON.parse(serializeWidgetSettings({ ...DEFAULT_WIDGET_SETTINGS, accent: 'theme' }, '#123456')) as { accentHex?: string; accent: string };
		expect(json.accentHex).toBe('#123456');
		expect(json.accent).toBe('theme');
		// 書いたものを読み戻すと同じ設定になる（accentHex は読むときに捨てる）。
		expect(parseWidgetSettings(serializeWidgetSettings(DEFAULT_WIDGET_SETTINGS, undefined))).toEqual(DEFAULT_WIDGET_SETTINGS);
	});

	it('moves and toggles metrics', () => {
		expect(moveMetric(['battery', 'cpu', 'cost'], 'cpu', -1)).toEqual(['cpu', 'battery', 'cost']);
		expect(moveMetric(['battery', 'cpu'], 'battery', -1)).toEqual(['battery', 'cpu']);
		expect(toggleMetric(['battery', 'cost'], 'cpu')).toEqual(['battery', 'cpu', 'cost']);
		expect(toggleMetric(['cost', 'battery'], 'codexWeek')).toEqual(['cost', 'battery', 'codexWeek']);
		expect(toggleMetric(['battery', 'cpu'], 'cpu')).toEqual(['battery']);
	});

	it('never leaves the agent filter empty', () => {
		expect(toggleAgentFilter(['running'], 'running')).toEqual(['running']);
		expect(toggleAgentFilter(['running', 'idle'], 'idle')).toEqual(['running']);
		expect(toggleAgentFilter(['idle'], 'attention')).toEqual(['attention', 'idle']);
	});
});
