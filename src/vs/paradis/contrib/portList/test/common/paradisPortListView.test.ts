/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPortEntry } from '../../common/paradisPortList.js';
import { PARADIS_PORT_LIST_DEFAULT_VIEW, ParadisPortSortDirection, ParadisPortSortKey, paradisGroupPortEntries, paradisNextPortSort, paradisParsePortListView, paradisSortPortEntries } from '../../common/paradisPortListView.js';

function entry(port: number, processName: string, pid: number, address = '127.0.0.1'): IParadisPortEntry {
	return { port, proto: 'TCP', pid, processName, address, risky: address === '*' };
}

const entries: readonly IParadisPortEntry[] = [
	entry(8080, 'node', 300),
	entry(3000, 'Node', 200, '*'),
	entry(5432, 'postgres', 100),
	entry(3000, 'node', 150, '::1'),
	entry(3000, 'node', 150),
	entry(9229, 'claude', 400, '*'),
];

function sorted(key: ParadisPortSortKey, direction: ParadisPortSortDirection): string[] {
	return paradisSortPortEntries(entries, key, direction).map(item => `${item.port}/${item.processName}/${item.pid}/${item.address}`);
}

suite('Paradis port list view', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sorts by each column in both directions and breaks ties by port, PID and address', () => {
		assert.deepStrictEqual({
			portAsc: sorted('port', 'asc'),
			portDesc: sorted('port', 'desc'),
			processAsc: sorted('process', 'asc'),
			processDesc: sorted('process', 'desc'),
			pidAsc: sorted('pid', 'asc'),
			pidDesc: sorted('pid', 'desc'),
			scopeAsc: sorted('scope', 'asc'),
			scopeDesc: sorted('scope', 'desc'),
		}, {
			portAsc: ['3000/node/150/127.0.0.1', '3000/node/150/::1', '3000/Node/200/*', '5432/postgres/100/127.0.0.1', '8080/node/300/127.0.0.1', '9229/claude/400/*'],
			portDesc: ['9229/claude/400/*', '8080/node/300/127.0.0.1', '5432/postgres/100/127.0.0.1', '3000/node/150/127.0.0.1', '3000/node/150/::1', '3000/Node/200/*'],
			processAsc: ['9229/claude/400/*', '3000/node/150/127.0.0.1', '3000/node/150/::1', '3000/Node/200/*', '8080/node/300/127.0.0.1', '5432/postgres/100/127.0.0.1'],
			processDesc: ['5432/postgres/100/127.0.0.1', '3000/node/150/127.0.0.1', '3000/node/150/::1', '3000/Node/200/*', '8080/node/300/127.0.0.1', '9229/claude/400/*'],
			pidAsc: ['5432/postgres/100/127.0.0.1', '3000/node/150/127.0.0.1', '3000/node/150/::1', '3000/Node/200/*', '8080/node/300/127.0.0.1', '9229/claude/400/*'],
			pidDesc: ['9229/claude/400/*', '8080/node/300/127.0.0.1', '3000/Node/200/*', '3000/node/150/127.0.0.1', '3000/node/150/::1', '5432/postgres/100/127.0.0.1'],
			scopeAsc: ['3000/Node/200/*', '9229/claude/400/*', '3000/node/150/127.0.0.1', '3000/node/150/::1', '5432/postgres/100/127.0.0.1', '8080/node/300/127.0.0.1'],
			scopeDesc: ['3000/node/150/127.0.0.1', '3000/node/150/::1', '5432/postgres/100/127.0.0.1', '8080/node/300/127.0.0.1', '3000/Node/200/*', '9229/claude/400/*'],
		});
	});

	test('does not change the given array', () => {
		const before = [...entries];
		paradisSortPortEntries(entries, 'pid', 'desc');
		assert.deepStrictEqual(entries, before);
	});

	test('groups by process name in the order the first row of each process appears', () => {
		const groups = paradisGroupPortEntries(paradisSortPortEntries(entries, 'port', 'desc'));
		assert.deepStrictEqual(groups.map(group => ({ name: group.processName, ports: group.entries.map(item => item.port), risky: group.risky })), [
			{ name: 'claude', ports: [9229], risky: true },
			{ name: 'node', ports: [8080, 3000, 3000], risky: false },
			{ name: 'postgres', ports: [5432], risky: false },
			{ name: 'Node', ports: [3000], risky: true },
		]);
	});

	test('toggles the direction on the same column and starts ascending on another column', () => {
		const byProcess = paradisNextPortSort({ ...PARADIS_PORT_LIST_DEFAULT_VIEW, grouped: true }, 'process');
		const byProcessDesc = paradisNextPortSort(byProcess, 'process');
		const byScope = paradisNextPortSort(byProcessDesc, 'scope');
		assert.deepStrictEqual([byProcess, byProcessDesc, byScope], [
			{ sortKey: 'process', sortDirection: 'asc', grouped: true },
			{ sortKey: 'process', sortDirection: 'desc', grouped: true },
			{ sortKey: 'scope', sortDirection: 'asc', grouped: true },
		]);
	});

	test('reads the stored view and falls back to the default for unknown values', () => {
		assert.deepStrictEqual([
			paradisParsePortListView(undefined),
			paradisParsePortListView('not json'),
			paradisParsePortListView('null'),
			paradisParsePortListView('[]'),
			paradisParsePortListView(JSON.stringify({ sortKey: 'pid', sortDirection: 'desc', grouped: true })),
			paradisParsePortListView(JSON.stringify({ sortKey: 'address', sortDirection: 'down', grouped: 'yes' })),
			paradisParsePortListView(JSON.stringify({ sortKey: 'scope' })),
		], [
			PARADIS_PORT_LIST_DEFAULT_VIEW,
			PARADIS_PORT_LIST_DEFAULT_VIEW,
			PARADIS_PORT_LIST_DEFAULT_VIEW,
			PARADIS_PORT_LIST_DEFAULT_VIEW,
			{ sortKey: 'pid', sortDirection: 'desc', grouped: true },
			PARADIS_PORT_LIST_DEFAULT_VIEW,
			{ sortKey: 'scope', sortDirection: 'asc', grouped: false },
		]);
	});
});
