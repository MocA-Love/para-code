/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { paradisRefreshAgentPageScriptModels } from '../../browser/paradisAgentPageScriptModels.js';
import { paradisAgentPageScriptUri } from '../../common/paradisAgentBrowser.js';

suite('paradisAgentPageScriptModels', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// 「中身を見る」で開いたまま外されたスクリプトは、古い本文を出し続けない。
	test('a script document left open shows the gone text once the script is removed, and only for that tab', async () => {
		const disposables = store.add(new DisposableStore());
		const removed = disposables.add(createTextModel('window.removed = 1;', 'javascript', undefined, paradisAgentPageScriptUri('view-1', 's1')));
		const kept = disposables.add(createTextModel('window.kept = 1;', 'javascript', undefined, paradisAgentPageScriptUri('view-1', 's2')));
		const unreadable = disposables.add(createTextModel('window.unreadable = 1;', 'javascript', undefined, paradisAgentPageScriptUri('view-1', 's3')));
		const otherTab = disposables.add(createTextModel('window.other = 1;', 'javascript', undefined, paradisAgentPageScriptUri('view-2', 's4')));
		const unrelated = disposables.add(createTextModel('const a = 1;', 'javascript', undefined, URI.file('/project/a.js')));
		const asked: string[] = [];
		await paradisRefreshAgentPageScriptModels([removed, kept, unreadable, otherTab, unrelated], 'view-1', async (viewId, id) => {
			asked.push(`${viewId}/${id}`);
			if (id === 's3') {
				throw new Error('channel closed');
			}
			return id === 's2' ? 'window.kept = 1;' : undefined;
		}, '// gone');
		assert.deepStrictEqual({
			asked,
			values: [removed, kept, unreadable, otherTab, unrelated].map(model => model.getValue()),
		}, {
			asked: ['view-1/s1', 'view-1/s2', 'view-1/s3'],
			values: ['// gone', 'window.kept = 1;', 'window.unreadable = 1;', 'window.other = 1;', 'const a = 1;'],
		});
	});
});
