/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisResolveRunOnEnter, PARADIS_TERMINAL_HISTORY_PROVIDER_ID } from '../../common/paradisTerminalSuggestRunOnEnter.js';

suite('ParadisTerminalSuggestRunOnEnter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('always ではすぐ実行するのは履歴の候補だけ。ほかの設定は upstream の判断のまま（Q137）', () => {
		// 履歴の提供元はこの id を名乗る（`ParadisTerminalHistoryCompletionProvider.ID`）。
		const history = { provider: PARADIS_TERMINAL_HISTORY_PROVIDER_ID };
		// upstream の組み込みの提供元（パス・フォルダ・コマンド・引数）と拡張機能の提供元
		const builtin = { provider: 'core:path' };
		const extension = { provider: 'ms-vscode.vscode-terminal-completions' };

		const decide = (config: string | undefined, upstreamDecision: boolean) => [history, builtin, extension].map(completion => paradisResolveRunOnEnter(config, upstreamDecision, completion));

		assert.deepStrictEqual({
			always: decide('always', true),
			exactMatchHit: decide('exactMatch', true),
			exactMatchMiss: decide('exactMatch', false),
			never: decide('never', false),
		}, {
			always: [true, false, false],
			exactMatchHit: [true, true, true],
			exactMatchMiss: [false, false, false],
			never: [false, false, false],
		});
	});
});
