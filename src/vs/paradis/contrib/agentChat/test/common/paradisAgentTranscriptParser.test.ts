/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisParseCodexTranscriptLineForTest } from '../../common/paradisAgentTranscriptParser.js';

suite('paradisAgentTranscriptParser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not show the Codex interruption notice as a user message', () => {
		const userMessage = (text: string) => JSON.stringify({ type: 'response_item', timestamp: '2026-09-27T10:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
		// codex-cli 0.155.1 が rollout に書く中断の知らせ（フェーズ6の実機確認 NG-11）
		const aborted = paradisParseCodexTranscriptLineForTest(userMessage('<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'));
		const normal = paradisParseCodexTranscriptLineForTest(userMessage('P6CXASK 質問して'));
		assert.deepStrictEqual({ aborted: aborted.messages.length, normal: normal.messages.map(message => message.text) }, { aborted: 0, normal: ['P6CXASK 質問して'] });
	});
});
