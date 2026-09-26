// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { DEFAULT_WIDGET_SETTINGS, type WidgetSettings } from '../../widgets/settings.js';
import { attentionRows, listedAgents, pcMetrics, samplePc } from './previewModel.js';

const NOW = 1_790_000_000_000;

function withSettings(patch: Partial<WidgetSettings>): WidgetSettings {
	return { ...DEFAULT_WIDGET_SETTINGS, ...patch };
}

describe('widget preview model', () => {
	it('lists attention first and hides idle agents', () => {
		const rows = attentionRows(samplePc(NOW).agents, DEFAULT_WIDGET_SETTINGS);
		expect(rows.map(agent => agent.state)).toEqual(['approve', 'question', 'running', 'unread']);
	});

	it('filters the agents list by the chosen states and sorts by newest', () => {
		const settings = withSettings({ agents: { states: ['running', 'unread'], order: 'newest', limit: 8 } });
		expect(listedAgents(samplePc(NOW).agents, settings).map(agent => agent.key)).toEqual(['s-diff', 's-readme']);
	});

	it('follows the chosen metrics and their order', () => {
		const settings = withSettings({ pc: { metrics: ['cost', 'codexWeek', 'cpu'] } });
		const metrics = pcMetrics(samplePc(NOW), settings, NOW);
		expect(metrics.map(metric => metric.key)).toEqual(['cost', 'codexWeek', 'cpu']);
		expect(metrics[0]?.value).toBe('$4.12');
		expect(metrics[1]?.sub).toBe('5日後にリセット');
	});
});
