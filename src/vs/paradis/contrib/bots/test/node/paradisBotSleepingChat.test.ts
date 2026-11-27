/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisReadBotSleepingChat } from '../../node/paradisBotSleepingChat.js';

const CLAUDE_ID = '6adce79d-6bb2-4b6b-9123-baba73a26c49';
const CODEX_ID = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b';

function claudeLine(type: 'user' | 'assistant', text: string): string {
	return JSON.stringify(type === 'user'
		? { type: 'user', message: { role: 'user', content: text }, uuid: `u-${text}`, timestamp: '2026-11-28T03:06:00.000Z', sessionId: CLAUDE_ID }
		: { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text }] }, uuid: `a-${text}`, timestamp: '2026-11-28T03:06:01.000Z', sessionId: CLAUDE_ID });
}

function codexLine(role: 'user' | 'assistant', text: string): string {
	return JSON.stringify({ timestamp: '2026-11-28T03:06:00.000Z', type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
}

suite('Paradis bot sleeping chat', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-bot-sleeping-')));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('眠った会話を、エージェントを起こさずに Claude Code の transcript と Codex の rollout から読む。見つからなければ「読めない」、続けられないエージェントは読まない', async () => {
		const roots = { claudeConfigDir: join(root, 'claude'), codexHomes: [join(root, 'codex-a'), join(root, 'codex-b')] };
		await fs.mkdir(join(root, 'claude', 'projects', '-bots-bot-2'), { recursive: true });
		await fs.writeFile(join(root, 'claude', 'projects', '-bots-bot-2', `${CLAUDE_ID}.jsonl`), [claudeLine('user', '今夜は雨降る？'), 'not json', claudeLine('assistant', '降りません。')].join('\n') + '\n');
		await fs.mkdir(join(root, 'codex-b', 'sessions', '2026', '11', '27'), { recursive: true });
		await fs.writeFile(join(root, 'codex-b', 'sessions', '2026', '11', '27', `rollout-2026-11-27T21-04-00-${CODEX_ID}.jsonl`), [codexLine('user', '進み具合は？'), codexLine('assistant', '半分です。')].join('\n'));
		const shape = (chat: Awaited<ReturnType<typeof paradisReadBotSleepingChat>>) => chat === undefined ? undefined : { agent: chat.agent, unreadable: chat.unreadable ?? false, messages: chat.messages.map(message => `${message.rev} ${message.role}: ${message.text}`) };
		assert.deepStrictEqual({
			claude: shape(await paradisReadBotSleepingChat({ agent: 'claude', sessionId: CLAUDE_ID }, roots)),
			codex: shape(await paradisReadBotSleepingChat({ agent: 'codex', sessionId: CODEX_ID }, roots)),
			missing: shape(await paradisReadBotSleepingChat({ agent: 'claude', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000' }, roots)),
			badId: shape(await paradisReadBotSleepingChat({ agent: 'claude', sessionId: '../../etc/passwd' }, roots)),
			other: shape(await paradisReadBotSleepingChat({ agent: 'antigravity', sessionId: CLAUDE_ID }, roots)),
		}, {
			claude: { agent: 'claude', unreadable: false, messages: ['1 user: 今夜は雨降る？', '2 assistant: 降りません。'] },
			codex: { agent: 'codex', unreadable: false, messages: ['1 user: 進み具合は？', '2 assistant: 半分です。'] },
			missing: { agent: 'claude', unreadable: true, messages: [] },
			badId: { agent: 'claude', unreadable: true, messages: [] },
			other: undefined,
		});
	});
});
