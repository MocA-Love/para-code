/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { fireParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { IParadisHistoryCursor, paradisDecodeHistoryCursor, paradisEncodeHistoryCursor, paradisReadTranscriptHistory } from '../../node/paradisAgentChatHistory.js';
import { ParadisMobileAgentChat, paradisIsValidAgentInboundForTest } from '../../node/paradisMobileAgentChat.js';

/** Claude の transcript の 1 行（ユーザーの発言）。 */
function userLine(text: string): string {
	return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-09-29T00:00:00.000Z' });
}

/** Claude の transcript の 1 行（本文とツール呼び出しの 2 件になる assistant の行）。 */
function assistantLine(text: string, toolUseId: string): string {
	return JSON.stringify({
		type: 'assistant', timestamp: '2026-09-29T00:00:00.000Z',
		message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: `echo ${text}` } }] },
	});
}

async function withFile(content: string, run: (path: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'paradis-history-'));
	try {
		const path = join(root, 'session.jsonl');
		await writeFile(path, content);
		await run(path);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function readPage(path: string, cursor: IParadisHistoryCursor, limit: number, lastRev: number, maxBytes?: number) {
	const handle = await open(path, 'r');
	try {
		return await paradisReadTranscriptHistory(handle, 'claude', cursor, limit, lastRev, maxBytes);
	} finally {
		await handle.close();
	}
}

suite('paradisAgentChatHistory (W2-30)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips the cursor and rejects other shapes', () => {
		assert.deepStrictEqual({
			encoded: paradisEncodeHistoryCursor({ offset: 1234, keep: 1 }),
			decoded: paradisDecodeHistoryCursor('f:1234:1'),
			garbage: paradisDecodeHistoryCursor('f:-1:0'),
			other: paradisDecodeHistoryCursor('h:1'),
		}, { encoded: 'f:1234:1', decoded: { offset: 1234, keep: 1 }, garbage: undefined, other: undefined });
	});

	test('pages backwards to the start without losing or repeating a message split across a page boundary', async () => {
		const lines = [userLine('u1'), assistantLine('a1', 't1'), userLine('u2'), assistantLine('a2', 't2'), userLine('u3')];
		const content = `${lines.join('\n')}\n`;
		await withFile(content, async path => {
			const texts: string[][] = [];
			const revs: number[][] = [];
			let cursor: IParadisHistoryCursor | undefined = { offset: Buffer.byteLength(content), keep: 0 };
			let lastRev = -1;
			while (cursor !== undefined) {
				const page = await readPage(path, cursor, 3, lastRev);
				texts.push(page.messages.map(message => message.text));
				revs.push(page.messages.map(message => message.rev));
				lastRev -= page.messages.length;
				cursor = page.next;
			}
			assert.deepStrictEqual({ texts, revs }, {
				// 7 件（u1, a1 の本文, a1 のツール, u2, a2 の本文, a2 のツール, u3）。2 ページ目の境目は a1 の行の途中
				texts: [['a2', '{"command":"echo a2"}', 'u3'], ['a1', '{"command":"echo a1"}', 'u2'], ['u1']],
				revs: [[-3, -2, -1], [-6, -5, -4], [-7]],
			});
		});
	});

	test('continues from the boundary line of the ring with only the first messages kept', async () => {
		const lines = [userLine('u1'), assistantLine('a1', 't1'), userLine('u2')];
		const content = `${lines.join('\n')}\n`;
		const assistantOffset = Buffer.byteLength(`${lines[0]}\n`);
		await withFile(content, async path => {
			// a1 の行の 2 件目（ツール呼び出し）だけがリングに残り、1 件目（本文）は押し出された
			const page = await readPage(path, { offset: assistantOffset, keep: 1 }, 10, -1);
			assert.deepStrictEqual({ texts: page.messages.map(message => message.text), next: page.next }, { texts: ['u1', 'a1'], next: undefined });
		});
	});

	test('skips a line too long to keep and still moves forward when the byte budget runs out', async () => {
		const big = userLine('x'.repeat(200_000));
		const content = `${[userLine('u1'), big, userLine('u2')].join('\n')}\n`;
		await withFile(content, async path => {
			const end = { offset: Buffer.byteLength(content), keep: 0 };
			// 予算 64KB では u2 のあと大きな行の途中で止まる。次の位置は前へ進む
			const first = await readPage(path, end, 10, -1, 64 * 1024);
			const second = await readPage(path, first.next!, 10, -2, 64 * 1024);
			assert.deepStrictEqual({
				first: first.messages.map(message => message.text),
				movedForward: first.next !== undefined && first.next.offset < end.offset,
				secondNextBefore: second.next === undefined || second.next.offset < first.next!.offset,
			}, { first: ['u2'], movedForward: true, secondNextBefore: true });
		});
	});

	test('drops the full-text and image payloads that cannot be fetched for old messages', async () => {
		const longResult = JSON.stringify({
			type: 'user', timestamp: '2026-09-29T00:00:00.000Z',
			message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r'.repeat(20_000) }] },
		});
		const content = `${longResult}\n`;
		await withFile(content, async path => {
			const page = await readPage(path, { offset: Buffer.byteLength(content), keep: 0 }, 10, -1);
			const message = page.messages[0] as unknown as Record<string, unknown>;
			assert.deepStrictEqual({ kind: message.kind, truncated: message.truncated, fullText: message.fullText, rev: message.rev }, { kind: 'tool_result', truncated: undefined, fullText: undefined, rev: -1 });
		});
	});

	test('validates the history request shape', () => {
		assert.deepStrictEqual({
			ring: paradisIsValidAgentInboundForTest({ t: 'history', id: 1, requestId: 'r', epoch: 'e', beforeRev: 10 }),
			file: paradisIsValidAgentInboundForTest({ t: 'history', id: 1, requestId: 'r', epoch: 'e', beforeRev: -60, cursor: 'f:100:0', limit: 60 }),
			badCursor: paradisIsValidAgentInboundForTest({ t: 'history', id: 1, requestId: 'r', epoch: 'e', beforeRev: 10, cursor: '../etc' }),
			bigLimit: paradisIsValidAgentInboundForTest({ t: 'history', id: 1, requestId: 'r', epoch: 'e', beforeRev: 10, limit: 1000 }),
			noEpoch: paradisIsValidAgentInboundForTest({ t: 'history', id: 1, requestId: 'r', beforeRev: 10 }),
		}, { ring: true, file: true, badCursor: false, bigLimit: false, noEpoch: false });
	});

	/** 会話を開いて（snapshot）、古い方へ最後まで読み、集めた発言と要求の回数を返す。 */
	async function readWholeConversation(lines: readonly string[], holdFrom?: number): Promise<{ readonly texts: readonly string[]; readonly revs: readonly number[]; readonly truncated: boolean | undefined; readonly ring: number; readonly requests: number }> {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-history-chat-')));
		const previous = process.env['CLAUDE_CONFIG_DIR'];
		process.env['CLAUDE_CONFIG_DIR'] = root;
		const token = 'pane-history';
		const transcriptPath = join(root, 'projects', 'demo', 'history.jsonl');
		const sent: Record<string, unknown>[] = [];
		const chat = new ParadisMobileAgentChat(
			(_mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
			() => { }, () => { }, new NullLogService(),
		);
		const access = chat as unknown as { tailers: Map<string, { readonly messages: readonly { readonly rev: number }[] }> };
		const inbound = (message: Record<string, unknown>) => chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify(message)));
		const waitForMessage = async (predicate: (message: Record<string, unknown>) => boolean) => {
			const deadline = Date.now() + 2_000;
			for (; ;) {
				const found = sent.find(predicate);
				if (found !== undefined) {
					return found;
				}
				if (Date.now() > deadline) {
					throw new Error('no reply');
				}
				await new Promise<void>(resolve => setTimeout(resolve, 5));
			}
		};
		try {
			await mkdir(join(root, 'projects', 'demo'), { recursive: true });
			await writeFile(transcriptPath, `${lines.join('\n')}\n`);
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({ token, event: 'UserPromptSubmit', sessionId: 'session-history', transcriptPath, cwd: '/workspace', at: Date.now() });
			inbound({ t: 'attach', id: 1, token });
			const snapshot = await waitForMessage(message => message.t === 'snapshot') as { epoch: string; messages: { rev: number; text: string }[]; truncated?: boolean };
			// holdFrom: モバイルが差分で集めてリングより多く持っている（いちばん古い rev がもうリングに無い）場合を真似る
			const collected = holdFrom !== undefined ? lines.slice(holdFrom).map((_, index) => ({ rev: holdFrom + index, text: `held${holdFrom + index}` })) : [...snapshot.messages];
			let cursor: string | undefined;
			let hasMore = true;
			let requests = 0;
			while (hasMore && requests < 40) {
				const requestId = `history-${requests++}`;
				inbound({ t: 'history', id: 1, token, requestId, epoch: snapshot.epoch, beforeRev: collected[0]!.rev, ...(cursor !== undefined ? { cursor } : {}), limit: 100 });
				const reply = await waitForMessage(message => message.requestId === requestId) as { messages: { rev: number; text: string }[]; cursor?: string; hasMore: boolean; error?: string };
				assert.strictEqual(reply.error, undefined);
				collected.unshift(...reply.messages);
				cursor = reply.cursor;
				hasMore = reply.hasMore;
			}
			return {
				texts: collected.map(message => message.text),
				revs: collected.map(message => message.rev),
				truncated: snapshot.truncated,
				ring: access.tailers.get(token)!.messages.length,
				requests,
			};
		} finally {
			chat.dispose();
			if (previous === undefined) {
				delete process.env['CLAUDE_CONFIG_DIR'];
			} else {
				process.env['CLAUDE_CONFIG_DIR'] = previous;
			}
			await rm(root, { recursive: true, force: true });
		}
	}

	test('serves the ring first, then the transcript before the ring, back to the first message', async () => {
		// 450 件。リング（400 件）から 50 件がはみ出す
		const result = await readWholeConversation(Array.from({ length: 450 }, (_, index) => userLine(`m${index}`)));
		assert.deepStrictEqual({
			truncated: result.truncated,
			count: result.texts.length,
			inOrder: result.texts.every((text, index) => text === `m${index}`),
			ring: result.ring,
			fileRevs: result.revs.filter(rev => rev < 0).slice(0, 2),
			requests: result.requests,
		}, { truncated: true, count: 450, inOrder: true, ring: 400, fileRevs: [-50, -49], requests: 3 });
	});

	test('reads back to the start of a transcript that was only tail-read on open (over 8MB)', async () => {
		// 1 行約 10KB × 900 行 ≈ 9MB。開いたときは末尾 4MB だけを読むので、行の頭の位置はその途中から数え始める
		const lines = Array.from({ length: 900 }, (_, index) => userLine(`m${index} ${'y'.repeat(10_000)}`));
		const result = await readWholeConversation(lines);
		assert.deepStrictEqual({
			count: result.texts.length,
			inOrder: result.texts.every((text, index) => text.startsWith(`m${index} `)),
		}, { count: 900, inOrder: true });
	});

	test('reads the transcript before the oldest message the phone holds even when the ring has already pushed it out (H3)', async () => {
		// 450 件。リングは rev 50〜449。モバイルは rev 20 から持っている（差分で 500 件まで持つため）
		const result = await readWholeConversation(Array.from({ length: 450 }, (_, index) => userLine(`m${index}`)), 20);
		assert.deepStrictEqual({
			older: result.texts.slice(0, 20),
			revs: result.revs.slice(0, 2),
			held: result.texts[20],
		}, { older: Array.from({ length: 20 }, (_, index) => `m${index}`), revs: [-20, -19], held: 'held20' });
	});

	test('keeps the half of a line that the ring pushed out when it split a two-message line', async () => {
		// 225 行 × 2 件 + 1 件 = 451 件。リングは 51 件を押し出し、26 行目の本文だけがリングの外に出る
		const lines = [...Array.from({ length: 225 }, (_, index) => assistantLine(`a${index}`, `t${index}`)), userLine('last')];
		const result = await readWholeConversation(lines);
		const expected = [...Array.from({ length: 225 }, (_, index) => [`a${index}`, `{"command":"echo a${index}"}`]).flat(), 'last'];
		assert.deepStrictEqual({ count: result.texts.length, same: JSON.stringify(result.texts) === JSON.stringify(expected), ring: result.ring }, { count: 451, same: true, ring: 400 });
	});
});
