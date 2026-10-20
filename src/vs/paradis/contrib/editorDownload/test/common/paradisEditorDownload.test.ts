/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { paradisIsDiffTab } from '../../../../../workbench/services/editor/common/paradisTabContextKeys.js';
import { PARADIS_EDITOR_DOWNLOAD_WHEN, paradisEditorDownloadSource } from '../../common/paradisEditorDownload.js';

function context(values: Record<string, unknown>): IContext {
	return { getValue: <T>(key: string) => values[key] as T };
}

const REMOTE = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev-server', path: '/home/example/app/server.ts' });

suite('Paradis editor download', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the tab menu shows the entry only for saved files of the remote host, never on a diff tab', () => {
		const cases: Array<[string, boolean, boolean]> = [['vscode-remote', false, false], ['vscode-remote', true, false], ['vscode-remote', false, true], ['file', false, false], ['untitled', false, false], ['vscode-terminal', false, false], ['git', false, false]];
		assert.deepStrictEqual(
			cases.map(([scheme, dirty, diff]) => PARADIS_EDITOR_DOWNLOAD_WHEN?.evaluate(context({ resourceScheme: scheme, activeEditorIsDirty: dirty, paradisTabIsDiff: diff }))),
			[true, false, false, false, false, false, false],
		);
	});

	test('downloads the file of the clicked tab, never a diff, an unsaved tab or a local file', () => {
		const saved = { sideBySide: false, dirty: false };
		assert.deepStrictEqual({
			remote: paradisEditorDownloadSource(REMOTE, saved),
			diff: paradisEditorDownloadSource(REMOTE, { sideBySide: true, dirty: false }),
			dirty: paradisEditorDownloadSource(REMOTE, { sideBySide: false, dirty: true }),
			local: paradisEditorDownloadSource(URI.file('/Users/example/app/server.ts'), saved),
			noResource: paradisEditorDownloadSource(undefined, saved),
			noTab: paradisEditorDownloadSource(REMOTE, undefined),
		}, {
			remote: { resource: REMOTE, name: 'server.ts', isDirectory: false },
			diff: undefined,
			dirty: undefined,
			local: undefined,
			noResource: undefined,
			noTab: undefined,
		});
	});

	test('treats the diff inputs of the Para Code viewers as diff tabs', () => {
		const original = REMOTE.with({ scheme: 'git' });
		assert.deepStrictEqual([
			paradisIsDiffTab({ originalResource: original, modifiedResource: REMOTE }),
			paradisIsDiffTab({ resource: REMOTE }),
			paradisIsDiffTab({ originalResource: 'not a uri', modifiedResource: REMOTE }),
		], [true, false, false]);
	});
});
