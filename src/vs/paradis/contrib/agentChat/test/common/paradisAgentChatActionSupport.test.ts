/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAntigravitySendState, paradisAgentChatActionSupport, paradisAntigravitySendBlock } from '../../common/paradisAgentChatActionSupport.js';

suite('paradisAgentChatActionSupport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('passes only sends to Antigravity CLI, and everything to the agents whose keys are measured', () => {
		assert.deepStrictEqual({
			claude: paradisAgentChatActionSupport('claude'),
			codex: paradisAgentChatActionSupport('codex'),
			antigravity: paradisAgentChatActionSupport('antigravity'),
			unknown: paradisAgentChatActionSupport(undefined),
		}, {
			claude: { sendMessage: true, answerQuestion: true, answerApproval: true, settings: true },
			codex: { sendMessage: true, answerQuestion: true, answerApproval: true, settings: true },
			antigravity: { sendMessage: true, answerQuestion: false, answerApproval: false, settings: false },
			unknown: { sendMessage: true, answerQuestion: true, answerApproval: true, settings: true },
		});
	});

	test('sends to Antigravity CLI only while it waits in its input box', () => {
		const waiting: IParadisAntigravitySendState = { agyInForeground: true, status: undefined, pendingInteraction: false, multiline: false, bracketedPaste: false };
		assert.deepStrictEqual({
			idle: paradisAntigravitySendBlock(waiting),
			done: paradisAntigravitySendBlock({ ...waiting, status: 'review' }),
			shell: paradisAntigravitySendBlock({ ...waiting, agyInForeground: false }),
			// 許可待ちは、作業中より先に理由にする（Enter が許可を確定しうる）
			permission: paradisAntigravitySendBlock({ ...waiting, status: 'permission', pendingInteraction: true }),
			question: paradisAntigravitySendBlock({ ...waiting, status: 'question' }),
			questionInRecord: paradisAntigravitySendBlock({ ...waiting, pendingInteraction: true }),
			working: paradisAntigravitySendBlock({ ...waiting, status: 'working' }),
			multiline: paradisAntigravitySendBlock({ ...waiting, multiline: true }),
			multilinePasted: paradisAntigravitySendBlock({ ...waiting, multiline: true, bracketedPaste: true }),
		}, {
			idle: undefined,
			done: undefined,
			shell: 'not-running',
			permission: 'permission',
			question: 'question',
			questionInRecord: 'question',
			working: 'working',
			multiline: 'multiline',
			multilinePasted: undefined,
		});
	});
});
