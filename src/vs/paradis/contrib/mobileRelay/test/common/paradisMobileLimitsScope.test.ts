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

	test('only a new app that names a window and asks for the host gets the host Claude; everything else stays local', () => {
		assert.deepStrictEqual({
			// ホーム・ウィジェット（アプリが最初に見つけたウィンドウの ws を付けて送る。古いアプリも同じ）
			implicitWithWorkspace: paradisMobileLimitsClaudeFromLocal({ ws: 'space-1' }),
			implicitAskingHost: paradisMobileLimitsClaudeFromLocal({ ws: 'space-1', claudeHost: true }),
			// 古いアプリの使用量の画面（ウィンドウを名指しするが claudeHost を知らない）
			oldAppNamedWindow: paradisMobileLimitsClaudeFromLocal({ rendererGeneration: 3 }),
			// 新しいアプリの使用量の画面で接続先を選んだ
			newAppHost: paradisMobileLimitsClaudeFromLocal({ rendererGeneration: 3, claudeHost: true }),
			emptyWorkspaceHost: paradisMobileLimitsClaudeFromLocal({ ws: '', rendererGeneration: 0, claudeHost: true }),
			// ws と rendererGeneration の両方があれば ws の経路（リレーもそちらで配る）
			workspaceWins: paradisMobileLimitsClaudeFromLocal({ ws: 'space-1', rendererGeneration: 3, claudeHost: true }),
			notTrue: paradisMobileLimitsClaudeFromLocal({ rendererGeneration: 3, claudeHost: 'yes' }),
			brokenGeneration: paradisMobileLimitsClaudeFromLocal({ rendererGeneration: 1.5, claudeHost: true }),
			nothing: paradisMobileLimitsClaudeFromLocal({}),
		}, {
			implicitWithWorkspace: true,
			implicitAskingHost: true,
			oldAppNamedWindow: true,
			newAppHost: false,
			emptyWorkspaceHost: false,
			workspaceWins: true,
			notTrue: true,
			brokenGeneration: true,
			nothing: true,
		});
	});
});
