/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisTasksProjectField, IParadisTasksProjectItem, paradisTasksBoardColumns, paradisTasksBoardField, paradisTasksProjectItemsQuery, paradisTasksRoadmap, paradisTasksRoadmapFields, paradisTasksTableFields } from '../../common/paradisTasksProjects.js';

function item(id: string, status?: string): IParadisTasksProjectItem {
	return { id, kind: 'issue', title: id, assignees: [], labels: [], values: status ? { Status: { text: status } } : {} };
}

suite('ParadisTasksProjects', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const status: IParadisTasksProjectField = { name: 'Status', dataType: 'SINGLE_SELECT', options: [{ name: 'Todo', color: 'GRAY' }, { name: 'Done', color: 'GREEN' }] };
	const fields: IParadisTasksProjectField[] = [{ name: 'Title', dataType: 'TITLE' }, { name: 'Priority', dataType: 'SINGLE_SELECT', options: [] }, status, { name: 'Sub-issues progress', dataType: 'SUB_ISSUES_PROGRESS' }];

	// ボードの列は選択肢の順。値の無い項目は先頭の列、選択肢に無い値は末尾の列
	test('groups items into board columns', () => {
		const columns = paradisTasksBoardColumns([item('a', 'Done'), item('b'), item('c', 'Todo'), item('d', 'Gone')], status);
		assert.deepStrictEqual(columns.map(column => [column.name, column.color, column.items.map(entry => entry.id)]), [
			[undefined, undefined, ['b']],
			['Todo', 'GRAY', ['c']],
			['Done', 'GREEN', ['a']],
			['Gone', undefined, ['d']],
		]);
	});

	test('picks the board field, table fields and the items query', () => {
		assert.deepStrictEqual({
			configured: paradisTasksBoardField(fields, 'Priority')?.name,
			status: paradisTasksBoardField(fields, undefined)?.name,
			table: paradisTasksTableFields(fields).map(field => field.name),
			query: [paradisTasksProjectItemsQuery('status:Todo ', ' assignee:@me'), paradisTasksProjectItemsQuery(undefined, ''), paradisTasksProjectItemsQuery('', 'is:open')],
		}, {
			configured: 'Priority',
			status: 'Status',
			table: ['Priority', 'Status'],
			query: ['status:Todo assignee:@me', undefined, 'is:open'],
		});
	});

	// 開始・終了の欄を名前で探し、無ければ繰り返し、それも無ければ最初の日付の欄
	test('chooses roadmap fields', () => {
		const date = (name: string): IParadisTasksProjectField => ({ name, dataType: 'DATE' });
		assert.deepStrictEqual([
			paradisTasksRoadmapFields([date('Due'), date('Start date'), date('Target date')]),
			paradisTasksRoadmapFields([date('Due'), { name: 'Sprint', dataType: 'ITERATION' }]),
			paradisTasksRoadmapFields([date('期限')]),
			paradisTasksRoadmapFields([status]),
		], [
			{ start: 'Start date', end: 'Due', iteration: false },
			{ start: 'Sprint', end: 'Sprint', iteration: true },
			{ start: '期限', end: '期限', iteration: false },
			undefined,
		]);
	});

	// 幅は最初の月の 1 日から最後の月の末まで（今日を含む）。片方だけの日付は点、逆向きは入れ替え、日付の無い項目は分ける
	test('lays out the roadmap', () => {
		const fields: IParadisTasksProjectField[] = [{ name: 'Start', dataType: 'DATE' }, { name: 'End', dataType: 'DATE' }];
		const dated = (id: string, start?: string, end?: string): IParadisTasksProjectItem => ({
			id, kind: 'issue', title: id, assignees: [], labels: [],
			values: { ...(start ? { Start: { text: start, date: start } } : {}), ...(end ? { End: { text: end, date: end } } : {}) },
		});
		const roadmap = paradisTasksRoadmap([dated('b', '2026-12-01', '2026-12-31'), dated('a', '2026-11-11'), dated('c', '2026-11-30', '2026-11-20'), dated('none')], fields, '2026-11-08')!;
		const round = (value: number) => Math.round(value * 1000) / 1000;
		assert.deepStrictEqual({
			rows: roadmap.rows.map(row => [row.item.id, row.startDate, row.endDate, round(row.from), round(row.to)]),
			undated: roadmap.undated.map(entry => entry.id),
			ticks: roadmap.ticks.map(tick => [tick.date, round(tick.at)]),
			today: round(roadmap.today!),
		}, {
			rows: [
				['a', '2026-11-11', '2026-11-11', round(10 / 61), round(11 / 61)],
				['c', '2026-11-20', '2026-11-30', round(19 / 61), round(30 / 61)],
				['b', '2026-12-01', '2026-12-31', round(30 / 61), 1],
			],
			undated: ['none'],
			ticks: [['2026-11-01', 0], ['2026-12-01', round(30 / 61)]],
			today: round(7 / 61),
		});
	});
});
