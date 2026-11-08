/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';

suite('Paradis pane session transcript', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the transcript path of the conversation for the hand-off and drops it when the conversation changes', async () => {
		// _recordPaneSession は _paneSessions だけを、getPaneTranscriptPath はそれと呼んだ窓のペインだけを読む
		const host = {
			_paneSessions: new Map<string, object>(),
			_currentEligibleTokens: () => new Set(['pane', 'open']),
		};
		const record = Reflect.get(ParadisAgentBrowserService.prototype, '_recordPaneSession') as (this: typeof host, ...args: unknown[]) => void;
		const getPath = Reflect.get(ParadisAgentBrowserService.prototype, 'getPaneTranscriptPath') as (this: typeof host, connection: object, token: string) => Promise<string | undefined>;
		const transcript = (token: string) => getPath.call(host, {}, token);
		const steps: Record<string, unknown> = {};

		record.call(host, 'pane', 'SessionStart', 's1', '/Users/example/.claude/projects/app/s1.jsonl', '/Users/example/app', false);
		steps.started = await transcript('pane');
		// 後の hook が記録のパスを持っていなくても、同じ会話の間は残す
		record.call(host, 'pane', 'PostToolUse', 's1', undefined, '/Users/example/app', false);
		steps.laterHookWithoutPath = await transcript('pane');
		// 別の会話（/clear など）になったら、前の会話の記録は渡さない
		record.call(host, 'pane', 'SessionStart', 's2', undefined, '/Users/example/app', false);
		steps.otherConversation = await transcript('pane');
		// OpenCode はデータベースの場所なので控えない
		record.call(host, 'open', 'SessionStart', 'ses_1', '/Users/example/opencode.db#ses_1', '/Users/example/app', false, 'opencode', 'opencode');
		steps.openCode = await transcript('open');
		// 呼んだ窓のペインでなければ答えない
		record.call(host, 'other', 'SessionStart', 's3', '/Users/example/.claude/projects/app/s3.jsonl', '/Users/example/app', false);
		steps.otherWindow = await transcript('other');

		assert.deepStrictEqual(steps, {
			started: '/Users/example/.claude/projects/app/s1.jsonl',
			laterHookWithoutPath: '/Users/example/.claude/projects/app/s1.jsonl',
			otherConversation: undefined,
			openCode: undefined,
			otherWindow: undefined,
		});
	});
});
