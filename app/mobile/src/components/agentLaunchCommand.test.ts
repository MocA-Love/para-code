// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { allowedEfforts, buildLaunchCommandPreview } from './agentLaunchCommand.js';
import type { WorktreeAgentDef } from '../store.js';

const claude: WorktreeAgentDef = {
	id: 'claude', label: 'Claude Code', command: 'claude {prompt}',
	models: [
		{ id: 'opus', label: 'opus (Opus 5)', flag: '--model opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
		{ id: 'haiku', label: 'haiku (Haiku 4.5)', flag: '--model haiku', efforts: [] },
	],
	efforts: [{ id: 'high', flag: '--effort high' }, { id: 'xhigh', flag: '--effort xhigh' }],
	permissions: [
		{ id: 'default', label: '通常（確認あり）', flag: '' },
		{ id: 'skip-permissions', label: '全許可', flag: '--dangerously-skip-permissions', danger: true },
	],
};

describe('allowedEfforts', () => {
	test('モデル未選択（既定）は undefined、モデル固有 > エージェント共通語彙の順で解決する', () => {
		expect(allowedEfforts(claude, undefined)).toBeUndefined();
		expect(allowedEfforts(claude, claude.models![0])).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
		// efforts: [] のモデル（Haiku）は effort 非対応
		expect(allowedEfforts(claude, claude.models![1])).toEqual([]);
		// モデル側に efforts 未定義ならエージェント共通語彙へフォールバック
		expect(allowedEfforts(claude, { id: 'x', flag: '--model x' })).toEqual(['high', 'xhigh']);
	});
});

describe('buildLaunchCommandPreview', () => {
	test('プロンプト無しはフラグのみ（空引数を付けない）', () => {
		expect(buildLaunchCommandPreview(claude, '', { model: '', effort: '', permission: '' })).toBe('claude');
		expect(buildLaunchCommandPreview(claude, '  ', { model: '--model opus', effort: '--effort xhigh', permission: '' }))
			.toBe('claude --model opus --effort xhigh');
	});

	test('フラグはプロンプトの直前へ挿入され、プロンプトはPOSIXクォートされる', () => {
		expect(buildLaunchCommandPreview(claude, "fix it's broken", { model: '--model opus', effort: '', permission: '--dangerously-skip-permissions' }))
			.toBe(String.raw`claude --model opus --dangerously-skip-permissions 'fix it'\''s broken'`);
	});

	test('コマンドテンプレート未配信（旧PC）は id をコマンド名にフォールバックする', () => {
		expect(buildLaunchCommandPreview({ id: 'gemini', label: 'Gemini CLI' }, 'hello', { model: '', effort: '', permission: '' }))
			.toBe("gemini 'hello'");
	});

	test('指示を値として取るフラグ（Antigravity CLI の -i）は、指示があるときだけ選んだフラグの後・指示の直前に付ける', () => {
		const antigravity: WorktreeAgentDef = { id: 'antigravity', label: 'Antigravity CLI', command: 'agy {prompt}', promptFlag: '-i' };
		expect([
			buildLaunchCommandPreview(antigravity, '', { model: '', effort: '', permission: '' }),
			buildLaunchCommandPreview(antigravity, 'go', { model: '', effort: '', permission: '--mode accept-edits' }),
			buildLaunchCommandPreview(antigravity, '-v を直して', { model: '--model gemini-3.8-flash-high', effort: '', permission: '' }),
		]).toEqual([
			'agy',
			"agy --mode accept-edits -i 'go'",
			"agy --model gemini-3.8-flash-high -i '-v を直して'",
		]);
	});

	test('長いプロンプトは省略記号付きで切り詰める', () => {
		const longPrompt = 'a'.repeat(60);
		expect(buildLaunchCommandPreview(claude, longPrompt, { model: '', effort: '', permission: '' }))
			.toBe(`claude '${'a'.repeat(40)}…'`);
	});
});
