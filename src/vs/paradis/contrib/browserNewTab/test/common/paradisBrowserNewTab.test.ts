/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPortServerEntry } from '../../../portList/common/paradisPortList.js';
import { IParadisNewTabSpace, paradisGroupNewTabServers, paradisIsPathInside, paradisIsTooBroadRoot } from '../../common/paradisBrowserNewTab.js';

function entry(port: number, pid: number, cwd: string | undefined, processName = 'node'): IParadisPortServerEntry {
	return { port, proto: 'TCP', pid, processName, address: '127.0.0.1', risky: false, cwd };
}

const spaces: IParadisNewTabSpace[] = [
	{ key: 'repo', label: 'app', rootPath: '/work/app' },
	{ key: 'worktree:feature', label: 'app / feature', rootPath: '/work/app/.worktrees/feature' },
	{ key: 'other', label: 'docs', rootPath: '/work/docs' },
	{ key: 'home', label: '~', rootPath: '/home/u' },
];

suite('ParadisBrowserNewTab - grouping servers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('puts each port in the deepest matching space and merges duplicate listeners', () => {
		const groups = paradisGroupNewTabServers([
			entry(5173, 10, '/work/app/.worktrees/feature/web'),
			entry(5173, 11, undefined),
			entry(6006, 12, '/work/app'),
			entry(4000, 13, '/work/docs'),
			entry(8828, 14, '/home/u/Library', 'Para Code Helper'),
			entry(9000, 15, '/work/application'),
		], spaces, 'worktree:feature', '/home/u');
		assert.deepStrictEqual({
			current: groups.current.map(server => [server.port, server.pid]),
			otherSpaces: groups.otherSpaces.map(server => [server.port, server.space?.key]),
			outside: groups.outside.map(server => server.port),
		}, {
			current: [[5173, 10]],
			otherSpaces: [[4000, 'other'], [6006, 'repo']],
			outside: [8828, 9000],
		});
	});

	test('matches paths by separator and refuses roots that are too broad', () => {
		assert.deepStrictEqual([
			paradisIsPathInside('/work/app/src', '/work/app'),
			paradisIsPathInside('/work/app', '/work/app/'),
			paradisIsPathInside('/work/application', '/work/app'),
			paradisIsPathInside('C:\\Work\\App\\src', 'c:/work/app', true),
			paradisIsTooBroadRoot('/', '/home/u'),
			paradisIsTooBroadRoot('/home/u/', '/home/u'),
			paradisIsTooBroadRoot('C:\\', ''),
			paradisIsTooBroadRoot('/work/app', '/home/u'),
		], [true, true, false, true, true, true, true, false]);
	});
});
