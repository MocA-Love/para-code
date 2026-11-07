/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisParseClaudeAdvisorsEntries, paradisParseClaudePersistedActivityEntries, paradisParseCodexPersistedActivityEntries, paradisParseTranscriptEntries } from '../../node/paradisPersistedAgentActivity.js';
import { IParadisTranscriptFile, ParadisTranscriptEntryWindows } from '../../node/paradisTranscriptEntryWindow.js';

const HEAD = 48;
const TAIL = 96;

/** 差分読みにする前の読み方（毎回ファイル全体を「先頭＋末尾」の窓で読み直す）。 */
function readWholeWindow(content: Buffer): Record<string, unknown>[] {
	if (content.length <= 0) {
		return [];
	}
	if (content.length <= HEAD + TAIL) {
		return paradisParseTranscriptEntries(content.toString('utf8').split('\n').filter(Boolean));
	}
	const headLines = content.subarray(0, HEAD).toString('utf8').split('\n');
	headLines.pop();
	const tailLines = content.subarray(content.length - TAIL).toString('utf8').split('\n');
	tailLines.shift();
	return paradisParseTranscriptEntries([...headLines, ...tailLines].filter(Boolean));
}

class FakeFile implements IParadisTranscriptFile {
	content = Buffer.alloc(0);
	ino = 1;
	reads = 0;
	async stat() { return { size: this.content.length, dev: 1, ino: this.ino }; }
	async read(buffer: Buffer, offset: number, length: number, position: number) {
		this.reads += length;
		const bytesRead = this.content.copy(buffer, offset, position, Math.min(this.content.length, position + length));
		return { bytesRead };
	}
}

/** 決まった種から作る行（長さを散らし、日本語も混ぜる）。 */
function makeLines(seed: number, count: number): string[] {
	let state = seed;
	const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
	return Array.from({ length: count }, (_, index) => JSON.stringify({ type: 'assistant', n: index, s: seed, text: 'あいう'.repeat(Math.floor(next() * 6)) + 'x'.repeat(Math.floor(next() * 30)) }));
}

suite('ParadisTranscriptEntryWindows', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns what reading the whole window returns while the log grows, is cut and is replaced', async () => {
		const windows = new ParadisTranscriptEntryWindows(HEAD, TAIL, 1024 * 1024);
		const file = new FakeFile();
		const mismatches: string[] = [];
		const check = async (step: string) => {
			const actual = await windows.read('log', file);
			if (JSON.stringify(actual) !== JSON.stringify(readWholeWindow(file.content))) {
				mismatches.push(step);
			}
		};
		const lines = makeLines(7, 60);
		// 1 行を何回かに分けて書く（書きかけの行・改行だけの追記を含む）
		for (const [index, line] of lines.slice(0, 30).entries()) {
			const cut = index % 3 === 0 ? Math.floor(line.length / 2) : line.length;
			file.content = Buffer.concat([file.content, Buffer.from(line.slice(0, cut))]);
			await check(`write ${index} (part)`);
			file.content = Buffer.concat([file.content, Buffer.from(line.slice(cut) + '\n')]);
			await check(`write ${index}`);
		}
		// 空行と、末尾の窓より長い 1 行
		file.content = Buffer.concat([file.content, Buffer.from('\n\n' + JSON.stringify({ type: 'user', big: 'y'.repeat(TAIL * 2) }))]);
		await check('long line (part)');
		file.content = Buffer.concat([file.content, Buffer.from('\n' + lines[30] + '\n')]);
		await check('after long line');
		// 切り詰め（作り直し）
		file.content = Buffer.from(lines.slice(31, 33).join('\n') + '\n');
		await check('truncated');
		// 同じ大きさ以上に書き直す（ino はそのまま）
		file.content = Buffer.from(lines.slice(33, 40).join('\n') + '\n');
		await check('rewritten in place');
		// 置き換え（別のファイルが同じ名前に来る）
		file.ino = 2;
		file.content = Buffer.concat([file.content, Buffer.from(lines.slice(40).join('\n') + '\n')]);
		await check('replaced');
		assert.deepStrictEqual(mismatches, []);
	});

	test('the parsers do not change the parsed lines, which are shared between reads', async () => {
		const windows = new ParadisTranscriptEntryWindows(1024, 4096, 1024 * 1024);
		const file = new FakeFile();
		const at = '2026-11-07T00:00:00.000Z';
		file.content = Buffer.from([
			{ type: 'user', timestamp: at, message: { content: 'start' } },
			{ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', name: 'Agent', id: 'tu1', input: { description: 'look', subagent_type: 'Explore' } }, { type: 'server_tool_use', name: 'advisor', id: 'adv1' }] } },
			{ type: 'user', timestamp: at, toolUseResult: { agentId: 'a1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'Async agent launched agentId: a1' }] }] } },
			{ type: 'assistant', timestamp: at, message: { stop_reason: 'end_turn', content: [{ type: 'advisor_tool_result', tool_use_id: 'adv1', content: { type: 'advisor_result', text: 'ok' } }, { type: 'text', text: 'done' }] } },
			{ type: 'session_meta', timestamp: at, payload: { agent_nickname: 'child' } },
			{ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] } },
			{ type: 'event_msg', timestamp: at, payload: { type: 'task_complete' } },
		].map(line => JSON.stringify(line)).join('\n') + '\n');
		const freeze = (value: unknown): void => {
			if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
				Object.freeze(value);
				Object.values(value).forEach(freeze);
			}
		};
		const run = async () => {
			const entries = await windows.read('log', file);
			entries.forEach(freeze);
			const now = Date.parse(at) + 1000;
			return JSON.stringify([
				paradisParseClaudePersistedActivityEntries('owner', entries, now, now),
				paradisParseClaudeAdvisorsEntries(undefined, entries, now),
				paradisParseCodexPersistedActivityEntries('c1', '{}', entries, now, now),
			], (_key, value) => value instanceof Map ? [...value] : value);
		};
		// 凍らせた行で例外が出ず（書き換えれば strict mode で TypeError）、2 回目の結果も同じ
		assert.strictEqual(await run(), await run());
	});

	test('reads only what was appended after the first read', async () => {
		const windows = new ParadisTranscriptEntryWindows(1024, 4096, 1024 * 1024);
		const file = new FakeFile();
		file.content = Buffer.from(makeLines(3, 20).join('\n') + '\n');
		await windows.read('log', file);
		file.reads = 0;
		const appended = makeLines(4, 1)[0] + '\n';
		file.content = Buffer.concat([file.content, Buffer.from(appended)]);
		await windows.read('log', file);
		// 追記した分と、同じファイルかの確かめ（先頭 64 バイトと読んだ位置の直前 1 バイト）
		assert.strictEqual(file.reads, appended.length + 64 + 1);
	});

	test('keeps no more than its budget across files', async () => {
		const first = new FakeFile();
		const second = new FakeFile();
		first.content = Buffer.from(makeLines(5, 3).join('\n') + '\n');
		second.content = Buffer.from(makeLines(6, 3).join('\n') + '\n');
		// どちらか 1 つなら覚えられるが、2 つは覚えられない
		const windows = new ParadisTranscriptEntryWindows(1024, 4096, Math.max(first.content.length, second.content.length));
		await windows.read('first', first);
		await windows.read('second', second);
		first.reads = 0;
		const again = await windows.read('first', first);
		// first は second に押し出されたので最初から読み直す（結果は同じ）
		assert.deepStrictEqual({ reads: first.reads > first.content.length, same: JSON.stringify(again) === JSON.stringify(paradisParseTranscriptEntries(first.content.toString('utf8').split('\n'))) }, { reads: true, same: true });
	});
});
