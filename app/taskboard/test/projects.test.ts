// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { ITaskBoardFlow } from '@engine/paradisTaskBoard.js';
import { TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';
import { TASK_BOARD_DEFAULT_FLOW, taskBoardStepsFromOptions } from '@engine/paradisTaskBoardFlow.js';
import { GitHubClient } from '../server/github.js';
import { GitHubSync } from '../server/githubSync.js';

/* 実際の Status (AI) の欄の選択肢（名前と説明）から工程を組む */
const STATUS_AI = [
	['Investigating', '対象の Issue やタスクを調査している段階。原因の特定や要件の整理を行う'],
	['Planning', '調査結果をもとに実装方針を検討している段階。方針のレビューと反映も含む'],
	['Plan Review', '実装方針を提示済みで着手の承認待ち。作業は止まっており人間の確認が必要'],
	['Implementing', '承認された方針に沿ってコードを変更している段階'],
	['Verifying', '変更内容の型チェックや自己点検を実施している段階'],
	['PR Created', '変更をコミット・push して PR を作成済み。レビュー開始前の状態'],
	['Local Review', 'PR に対するレビューと CI の結果を待っている状態'],
	['In Review', 'レビューで挙がった指摘に対応している状態'],
	['E2E Testing', 'ブラウザ上で実際の挙動やリグレッションを確認している段階'],
	['Done', '一連の作業が完了し、PR がレビュー・マージ可能な状態'],
].map(([name, description]) => ({ name, description }));

describe('Projects の軸の欄', () => {
	test('Status (AI) の選択肢から工程を組む', () => {
		const { steps, doneOption } = taskBoardStepsFromOptions(STATUS_AI);
		expect({ doneOption, steps: steps.map(s => `${s.name}:${s.kind}${s.gate ? `/${s.gate}` : ''}${s.run ? `/${s.run}` : ''}${s.wait ? `/${s.wait}` : ''}${s.onFail ? `<${s.onFail}` : ''}`) }).toEqual({
			doneOption: 'Done',
			steps: [
				'Investigating:agent',
				'Planning:agent',
				'Plan Review:human/approve<planning',
				'Implementing:agent',
				'Verifying:agent',
				'PR Created:run/draft-pr<verifying',
				'Local Review:wait/review<verifying',
				'In Review:agent',
				'E2E Testing:agent',
			],
		});
		expect(steps.every(s => s.projectOption === s.name)).toBe(true);
	});

	test('工程が進むと軸の欄へ書き戻し、既存の選択肢は id 付きで送り直す', async () => {
		const calls: { query: string; variables: Record<string, unknown> }[] = [];
		const fields = { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'F1', name: 'Status (AI)', options: [{ id: 'o1', name: 'Planning', color: 'BLUE', description: '' }, { id: 'o2', name: 'Plan Review', color: 'YELLOW', description: '' }] }] };
		const client = new GitHubClient({
			token: async () => 't',
			fetch: async (_url, init) => {
				const body = JSON.parse(init.body!);
				calls.push(body);
				const data = body.query.includes('viewer') ? { viewer: { login: 'me' } } : body.query.includes('fields(first: 50)') ? { repositoryOwner: { projectV2: { id: 'P1', fields } } } : {};
				return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data }) };
			},
		});
		await client.init();
		const flow: ITaskBoardFlow = {
			...TASK_BOARD_DEFAULT_FLOW,
			intake: { source: 'github-project', owner: 'o', project: 4, stageField: 'Status (AI)', doneOption: 'Done' },
			steps: [{ id: 'plan', name: 'Planning', kind: 'agent', projectOption: 'Planning' }, { id: 'review', name: 'Plan Review', kind: 'human', gate: 'approve', projectOption: 'Plan Review' }],
		};
		const noop = { startStep() { }, answer() { }, sendInput() { }, sendKey() { }, stop() { }, run() { }, cancel() { }, prepare: async (_t: unknown, _s: unknown, b: string) => ({ branch: b }), release: async () => { } };
		const engine = new TaskBoardEngine({ clock: Date.now, newId: () => Math.random().toString(36).slice(2), agents: noop, runner: noop, workspaces: noop });
		engine.setFlows([flow], flow.id, true);
		engine.setPoolSlots([{ id: 's', name: 's', path: '/s', kind: 'clone-pool' }]);
		engine.syncIntake([{ issue: { owner: 'o', repo: 'r', number: 1, url: 'u' }, title: 'T', labels: [], assignees: [], projectItemId: 'I1', projectStage: 'Planning' }]);
		const sync = new GitHubSync({ client, engine, repo: undefined, onState() { } });
		(sync as unknown as { state: { mode: string } }).state.mode = 'ok';
		engine.start('gh:o/r#1', { agent: 'claude', stepId: 'review' });
		await (sync as unknown as { writeBack(): Promise<void> }).writeBack();
		const write = calls.find(c => c.query.includes('updateProjectV2ItemFieldValue'));
		expect(write?.variables).toEqual({ project: 'P1', item: 'I1', field: 'F1', option: 'o2' });
		expect(engine.getTask('gh:o/r#1')!.projectStage).toBe('Plan Review');

		await sync.addProjectOptions('o', 4, 'Status (AI)', [{ name: 'Plan Review', color: 'YELLOW', description: '' }, { name: 'Implementing', color: 'BLUE', description: 'x' }]);
		const update = calls.find(c => c.query.includes('updateProjectV2Field('));
		expect(update?.variables).toEqual({ field: 'F1', options: [{ id: 'o1', name: 'Planning', color: 'BLUE', description: '' }, { id: 'o2', name: 'Plan Review', color: 'YELLOW', description: '' }, { name: 'Implementing', color: 'BLUE', description: 'x' }] });
	});
});
