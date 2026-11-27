/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBotTaskPrompt } from '../../../scheduledRuns/common/paradisScheduledRunBotTask.js';
import { paradisBotLaunchWaitsForPrompt } from '../../electron-browser/paradisBotTerminalLaunch.js';

suite('Paradis bot terminal launch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('定期実行は段に関係なく（Bot の権限の段も）プロンプトを待ってから打つ。指示の無い会話の起動は待たない', () => {
		// Bot の権限の段の起動の行は、引数が文字列でも、指示（900 字ほど）と権限・道具の許可の引数で 1024 バイトを超えうる
		const prompt = paradisBotTaskPrompt('下北沢の天気', '翌日の下北沢の天気を調べて知らせて', 'bot');
		assert.deepStrictEqual({
			longPrompt: new TextEncoder().encode(prompt).length > 900,
			taskBot: paradisBotLaunchWaitsForPrompt({ purpose: 'task' }, prompt),
			taskWeb: paradisBotLaunchWaitsForPrompt({ purpose: 'task' }, paradisBotTaskPrompt('x', 'y', 'web')),
			patrol: paradisBotLaunchWaitsForPrompt({ purpose: 'patrol' }, undefined),
			chatWithFirstMessage: paradisBotLaunchWaitsForPrompt({ purpose: 'chat' }, 'hello'),
			chat: paradisBotLaunchWaitsForPrompt({ purpose: 'chat' }, undefined),
		}, { longPrompt: true, taskBot: true, taskWeb: true, patrol: true, chatWithFirstMessage: true, chat: false });
	});
});
