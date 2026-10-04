// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { approvalButtons, approvalDangers, approvalEditDiff, approvalMeasureCopy, approvalHeading, approvalLineCount, approvalSender, approvalUrlParts, isAlwaysApprovalChoice } from './approvalDetail.js';
import { approvalChoicesFromOptions } from './approvalOptions.js';

describe('approvalDetail (agent.approval.detail.v1)', () => {
	it('asks by tool in the heading and names the subagent that asked', () => {
		expect({
			bash: approvalHeading({ tool: 'Bash', kind: 'bash', command: 'ls' }, '操作の許可'),
			edit: approvalHeading({ tool: 'Edit', kind: 'edit', path: '/a.ts' }, '操作の許可'),
			mcp: approvalHeading({ tool: 'mcp__db__q', kind: 'mcp' }, '操作の許可'),
			other: approvalHeading({ tool: 'Glob', kind: 'other' }, '操作の許可'),
			oldPc: approvalHeading(undefined, '操作の許可'),
			sender: [approvalSender({ id: 'a-1', name: 'general-purpose', role: 'subagent' }), approvalSender({ id: 'a-2', role: 'teammate' }), approvalSender(undefined)],
		}).toEqual({
			bash: 'Bash を実行してよいか',
			edit: 'ファイルを編集してよいか',
			mcp: 'MCP ツールを使ってよいか',
			other: 'Glob を使ってよいか',
			oldPc: '操作の許可',
			sender: [{ name: 'general-purpose', role: 'サブエージェント' }, { name: 'a-2', role: 'チームメイト' }, undefined],
		});
	});

	it('finds dangers in the whole command, not only in the description', () => {
		expect({
			command: approvalDangers({ tool: 'Bash', kind: 'bash', description: 'Copy render data', command: 'docker cp a b; docker exec $C sh -c "rm -rf /srv/.staging"' }, '操作の許可', 'Bash: Copy render data'),
			edit: approvalDangers({ tool: 'Edit', kind: 'edit', newText: 'rm -rf /' }, undefined, 'Edit: {"new_string":"rm -rf /"}'),
			oldPc: approvalDangers(undefined, '操作の許可', 'Bash: rm -rf build'),
			// MCP と形を知らないツールは引数の値から拾う（入力の JSON を詳細に出していた頃と同じ範囲）
			mcp: approvalDangers({ tool: 'mcp__acme-db__run_query', kind: 'mcp', args: [{ key: 'sql', value: 'DROP TABLE render_jobs' }, { key: 'dry_run', value: 'false' }] }, undefined, undefined),
			other: approvalDangers({ tool: 'Shell', kind: 'other', args: [{ key: 'script', value: 'git push --force' }] }, undefined, undefined),
			// 文章の項目（依頼文・説明）は判定しない
			prose: approvalDangers({ tool: 'Task', kind: 'other', args: [{ key: 'prompt', value: 'Clean up without rm -rf build' }, { key: 'Description', value: 'git push --force は使わない' }] }, undefined, undefined),
		}).toEqual({ command: ['削除を含む'], edit: [], oldPc: ['削除を含む'], mcp: ['DB を削除'], other: ['強制 push'], prose: [] });
	});

	it('turns an edit into removed and added lines, leaving out the lines that stay', () => {
		expect({
			change: approvalEditDiff('a\nconst RETRY = 3;\nb', 'a\nconst RETRY = 5;\nconst DELAY = 500;\nb'),
			cut: approvalEditDiff('1\n2\n3', '4\n5\n6', 4),
			same: approvalEditDiff('x', 'x'),
			lines: [approvalLineCount('a\nb\n'), approvalLineCount('')],
		}).toEqual({
			change: { lines: [{ kind: 'del', text: 'const RETRY = 3;' }, { kind: 'add', text: 'const RETRY = 5;' }, { kind: 'add', text: 'const DELAY = 500;' }], hidden: 0 },
			cut: { lines: [{ kind: 'del', text: '1' }, { kind: 'del', text: '2' }, { kind: 'del', text: '3' }, { kind: 'add', text: '4' }], hidden: 2 },
			same: { lines: [{ kind: 'ctx', text: 'x' }], hidden: 0 },
			lines: [2, 0],
		});
	});

	it('measures folding on a copy cut to the line limit plus one line', () => {
		expect([approvalMeasureCopy('x'.repeat(10_000), 6).length, approvalMeasureCopy('short', 2)]).toEqual([1_400, 'short']);
	});

	it('splits a URL so the host can stand out', () => {
		expect([approvalUrlParts('https://docs.example.com/render/v2?x=1'), approvalUrlParts('not a url')]).toEqual([
			{ scheme: 'https://', host: 'docs.example.com', rest: '/render/v2?x=1' },
			{ scheme: '', host: '', rest: 'not a url' },
		]);
	});

	it('puts allow first, the "don\'t ask again" with its rule second, and one 拒否 last; drops "don\'t ask again" without rules', () => {
		const screen = approvalChoicesFromOptions([{ n: 1, label: 'Yes' }, { n: 2, label: `Yes, and don't ask again for: npm test` }, { n: 3, label: 'No' }]);
		const shown = (buttons: ReturnType<typeof approvalButtons>) => buttons.map(button => [button.choice.id, button.variant, button.title, button.rule]);
		expect({
			screen: shown(approvalButtons(screen.choices, { screenLabels: screen.labels, suggestions: ['Bash(npm test)'], scope: 'settings' })),
			noRules: shown(approvalButtons(screen.choices, { screenLabels: screen.labels })),
			twoRules: shown(approvalButtons(screen.choices, { screenLabels: screen.labels, suggestions: ['Bash(npm test)', 'Bash(npm run lint)'], scope: 'settings' })),
			mod: shown(approvalButtons([
				{ id: 'yes', label: '許可', tone: 'approve' },
				{ id: 'always', label: '許可（このセッションでは以後確認しない: Bash(npm test:*)）', tone: 'approve' },
				{ id: 'no', label: '拒否', tone: 'deny' },
			], { suggestions: ['Bash(npm test:*)'], scope: 'session' })),
			always: [isAlwaysApprovalChoice({ id: 'opt:2', label: 'x', tone: 'neutral' }, 'Yes, allow all edits during this session (shift+tab)'), isAlwaysApprovalChoice({ id: 'opt:2', label: 'No, keep planning', tone: 'deny' }, undefined)],
		}).toEqual({
			screen: [
				['opt:1', 'primary', '許可', undefined],
				['opt:2', 'secondary', '許可して、設定に残す', 'Bash(npm test)'],
				['no', 'destructive', '拒否', undefined],
			],
			noRules: [['opt:1', 'primary', '許可', undefined], ['opt:2', 'secondary', `Yes, and don't ask again for: npm test`, undefined], ['no', 'destructive', '拒否', undefined]],
			// 候補が 2 つ以上なら、画面の文言のまま出してルールは付けない
			twoRules: [['opt:1', 'primary', '許可', undefined], ['opt:2', 'secondary', `Yes, and don't ask again for: npm test`, undefined], ['no', 'destructive', '拒否', undefined]],
			mod: [
				['yes', 'primary', '許可', undefined],
				['always', 'secondary', '許可して、このセッションでは確認しない', 'Bash(npm test:*)'],
				['no', 'destructive', '拒否', undefined],
			],
			always: [true, false],
		});
		// 「以後は確認しない」に当たる選択肢が 2 つ（候補は 1 つ）なら、どちらも画面の文言のまま
		const twoYes = approvalChoicesFromOptions([{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, allow all edits during this session (shift+tab)' }, { n: 3, label: `Yes, and don't ask again for: npm test` }, { n: 4, label: 'No' }]);
		expect(shown(approvalButtons(twoYes.choices, { screenLabels: twoYes.labels, suggestions: ['Bash(npm test)'], scope: 'settings' }))).toEqual([
			['opt:1', 'primary', '許可', undefined],
			['opt:2', 'secondary', 'Yes, allow all edits during this session', undefined],
			['opt:3', 'secondary', `Yes, and don't ask again for: npm test`, undefined],
			['no', 'destructive', '拒否', undefined],
		]);
		const modChoices = [{ id: 'yes', label: '許可', tone: 'approve' as const }, { id: 'always', label: '許可（以後確認しない: A、B）', tone: 'approve' as const }, { id: 'no', label: '拒否', tone: 'deny' as const }];
		expect({
			modNoRules: shown(approvalButtons(modChoices, {})),
			modTwoRules: shown(approvalButtons(modChoices, { suggestions: ['A', 'B'], scope: 'session' })),
		}).toEqual({
			modNoRules: [['yes', 'primary', '許可', undefined], ['no', 'destructive', '拒否', undefined]],
			modTwoRules: [['yes', 'primary', '許可', undefined], ['always', 'secondary', '許可（以後確認しない: A、B）', undefined], ['no', 'destructive', '拒否', undefined]],
		});
	});
});
