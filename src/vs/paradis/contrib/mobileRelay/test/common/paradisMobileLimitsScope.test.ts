/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisMobileLimitsClaudeFromLocal } from '../../common/paradisMobileLimitsScope.js';

suite('paradisMobileLimitsClaudeFromLocal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only a request that names a window gets that window host Claude; implicit ones stay local', () => {
		assert.deepStrictEqual({
			// ホーム・ウィジェット（アプリが最初に見つけたウィンドウの ws を付けて送る。古いアプリも同じ）
			implicitWithWorkspace: paradisMobileLimitsClaudeFromLocal({ ws: 'space-1' }),
			// ws と rendererGeneration の両方があれば ws の経路（リレーもそちらで配る）
			workspaceWins: paradisMobileLimitsClaudeFromLocal({ ws: 'space-1', rendererGeneration: 3 }),
			// 使用量の画面で接続先を選んだ（ウィンドウを名指し）
			explicitWindow: paradisMobileLimitsClaudeFromLocal({ rendererGeneration: 3 }),
			emptyWorkspaceExplicit: paradisMobileLimitsClaudeFromLocal({ ws: '', rendererGeneration: 0 }),
			brokenGeneration: paradisMobileLimitsClaudeFromLocal({ rendererGeneration: 1.5 }),
			nothing: paradisMobileLimitsClaudeFromLocal({}),
		}, {
			implicitWithWorkspace: true,
			workspaceWins: true,
			explicitWindow: false,
			emptyWorkspaceExplicit: false,
			brokenGeneration: true,
			nothing: true,
		});
	});
});
