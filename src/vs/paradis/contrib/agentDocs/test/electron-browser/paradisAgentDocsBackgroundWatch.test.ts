/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_DOC_BACKGROUND_WATCH_LINGER_MS, PARADIS_DOC_BACKGROUND_WATCH_MAX } from '../../common/paradisAgentDocs.js';
import { ParadisDocBackgroundWatchers } from '../../electron-browser/paradisAgentDocsBackgroundWatch.js';
import { paradisDocWatchPaneTokens } from '../../electron-browser/paradisAgentDocsPaneFolder.js';

suite('paradisAgentDocsBackgroundWatch', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(paneFolders: Record<string, string>, opened: string[]) {
		const log: string[] = [];
		const state = { opened };
		const watchers = store.add(new ParadisDocBackgroundWatchers({
			openedFolders: () => state.opened.map(path => URI.file(path)),
			paneFolder: token => paneFolders[token] !== undefined ? URI.parse(paneFolders[token]) : undefined,
			onWindowHost: folder => folder.scheme === 'file',
			watch: folder => {
				log.push(`watch ${folder.path}`);
				return toDisposable(() => log.push(`unwatch ${folder.path}`));
			},
		}));
		return { watchers, log, state };
	}

	test('watches the spaces that are not displayed while an agent works there, and stops a while after the last one left', () => {
		const { watchers, log, state } = setup({
			front: 'file:///work/front', nested: 'file:///work/front/packages/a', back: 'file:///work/back', back2: 'file:///work/back', other: 'file:///work/other',
			remote: 'vscode-remote://ssh-remote+box/work/remote',
		}, ['/work/front']);
		// 表示中のスペース（とその中のフォルダ）・別の機械のフォルダ・スペースの分からないペインには張らない。同じスペースは 1 本
		watchers.update(['front', 'nested', 'back', 'back2', 'remote', 'unknown'], 1_000);
		// ターンの合間（作業中のペインが無い）では外さない
		watchers.update([], 30_000);
		watchers.update(['other'], 40_000);
		const whileWorking = [...log];
		// back は最後に作業中だったのが 1,000。しばらく経ったら外す
		watchers.update(['other'], 1_000 + PARADIS_DOC_BACKGROUND_WATCH_LINGER_MS + 1);
		// 利用者が other を表示した（本体が見張る）ので外す
		state.opened = ['/work/other'];
		watchers.update(['other'], 70_000);
		assert.deepStrictEqual({ whileWorking, log: log.slice(whileWorking.length), watched: watchers.watched }, {
			whileWorking: ['watch /work/back', 'watch /work/other'],
			log: ['unwatch /work/back', 'unwatch /work/other'],
			watched: [],
		});
	});

	test('keeps at most a fixed number of watches, for the spaces that worked most recently', () => {
		const folders: Record<string, string> = {};
		for (let index = 0; index < PARADIS_DOC_BACKGROUND_WATCH_MAX + 2; index++) {
			folders[`pane-${index}`] = `file:///work/space-${index}`;
		}
		const { watchers } = setup(folders, []);
		Object.keys(folders).forEach((token, index) => watchers.update([token], 1_000 + index));
		assert.deepStrictEqual(watchers.watched.map(folder => URI.parse(folder).path).sort(), Object.values(folders).slice(2).map(folder => URI.parse(folder).path).sort());
	});

	test('a file written in a watched space that is not displayed is reported with the panes of that space', () => {
		const panes = [{ token: 'front', folder: URI.file('/work/front') }, { token: 'back', folder: URI.file('/work/back') }];
		assert.deepStrictEqual(paradisDocWatchPaneTokens(URI.file('/work/back/out/report.html'), panes), ['back']);
	});
});
