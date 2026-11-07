/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisTasksProjectField, IParadisTasksProjectItem, paradisTasksBoardColumns, paradisTasksBoardField, paradisTasksProjectItemsQuery, paradisTasksTableFields } from '../../common/paradisTasksProjects.js';

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
});
