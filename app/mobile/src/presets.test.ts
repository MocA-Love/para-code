// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { isValidPresetDef, presetApprovalKey, presetCommandSummary, presetIonicon, presetTerminalCount, visiblePresets } from './presets.js';
import type { PresetDef } from './store.js';

function preset(overrides: Partial<PresetDef> = {}): PresetDef {
	return {
		key: 'user:dev',
		name: 'dev',
		source: 'user',
		layout: 'tabs',
		signature: '1234',
		tasks: [{ name: 'dev', commands: ['bun dev'] }],
		...overrides,
	};
}

describe('command presets on the phone', () => {
	it('keys approvals on the signature the PC issued, not on the truncated commands shown here', () => {
		const base = preset();
		expect([
			// 表示だけが違っても承認は生きる（署名はPCが完全な定義から出している）
			presetApprovalKey(base) === presetApprovalKey(preset({ description: 'added later' })),
			// PCが署名を出し直したら別物として扱う（コマンドや作業ディレクトリの書き換え）
			presetApprovalKey(base) === presetApprovalKey(preset({ signature: '5678' })),
			// 同じ内容の別プリセットを承認しても、こちらは承認済みにならない
			presetApprovalKey(base) === presetApprovalKey(preset({ key: 'user:other' })),
		]).toEqual([true, false, false]);
	});

	it('rejects malformed entries so one bad preset cannot break the list', () => {
		expect([
			isValidPresetDef(preset()),
			isValidPresetDef({ ...preset(), signature: undefined }),
			isValidPresetDef({ ...preset(), tasks: undefined }),
			isValidPresetDef({ ...preset(), tasks: [{ commands: [1] }] }),
			isValidPresetDef({ ...preset(), layout: 'grid' }),
			isValidPresetDef(null),
		]).toEqual([true, false, false, false, false, false]);
	});

	it('describes how many terminals a preset will create', () => {
		const tasks = [{ commands: ['bun dev'] }, { commands: ['docker compose up -d'] }];
		expect([
			presetTerminalCount(preset({ tasks })),
			presetTerminalCount(preset({ tasks, layout: 'split' })),
			// current は既存の端末へ送る指定なので、タスクが分かれていても端末は増えない
			presetTerminalCount(preset({ tasks, layout: 'current' })),
		]).toEqual([2, 2, 1]);
	});

	it('hides only what this phone turned off, keeping the PC order', () => {
		const list = [preset(), preset({ key: 'user:test', name: 'test' }), preset({ key: 'workspace:up', name: 'up' })];
		expect(visiblePresets(list, new Set(['user:test'])).map(entry => entry.key)).toEqual(['user:dev', 'workspace:up']);
	});

	it('summarises every command across tasks', () => {
		expect(presetCommandSummary(preset({ tasks: [{ commands: ['bun dev'] }, { commands: ['docker compose up -d'] }] })))
			.toBe('bun dev ／ docker compose up -d');
	});

	it('maps PC icons onto Ionicons and falls back to the bolt', () => {
		expect([presetIonicon('rocket'), presetIonicon('$(beaker)'), presetIonicon('no-such-icon'), presetIonicon(undefined)])
			.toEqual(['rocket-outline', 'flask-outline', 'flash-outline', 'flash-outline']);
	});
});
