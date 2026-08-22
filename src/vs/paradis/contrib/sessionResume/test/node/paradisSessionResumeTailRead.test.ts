/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import {
	extractLatestMessage,
	LAST_MESSAGE_CHARS,
	LAST_MESSAGE_TAIL_BYTES,
	readFileTail,
} from '../../node/paradisSessionResumeChannel.js';

function claudeMessage(role: 'user' | 'assistant', text: string, timestamp = '2026-08-13T01:00:00.000Z'): string {
	return JSON.stringify({ type: role, timestamp, message: { content: [{ type: 'text', text }] } });
}

function codexMessage(role: 'user' | 'assistant', text: string, timestamp = '2026-08-13T01:00:00.000Z'): string {
	return JSON.stringify({
		type: 'response_item',
		timestamp,
		payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
	});
}

suite('ParadisSessionResume tail read', () => {
	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-session-resume-tail-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function write(name: string, content: string): Promise<string> {
		const filePath = join(root, name);
		await fs.writeFile(filePath, content);
		return filePath;
	}

	suite('readFileTail', () => {
		test('returns the whole content when the file fits the limit and ends with a complete line', async () => {
			const filePath = await write('complete.jsonl', 'FIRST\nSECOND\n');
			assert.strictEqual(await readFileTail(filePath, root, LAST_MESSAGE_TAIL_BYTES), 'FIRST\nSECOND\n');
		});

		test('drops only the partially cut first line when the window starts mid-line and keeps later complete lines', async () => {
			const longLine = 'z'.repeat(LAST_MESSAGE_TAIL_BYTES + 32);
			const filePath = await write('cut-mid-line.jsonl', `${longLine}\nLAST-LINE\n`);
			assert.strictEqual(await readFileTail(filePath, root, LAST_MESSAGE_TAIL_BYTES), 'LAST-LINE\n');
		});

		test('discards everything when the last line itself exceeds the limit so extraction falls back', async () => {
			const filePath = await write('huge-last-line.jsonl', `${'x'.repeat(LAST_MESSAGE_TAIL_BYTES * 2)}\n`);
			const tail = await readFileTail(filePath, root, LAST_MESSAGE_TAIL_BYTES);
			assert.strictEqual(tail, '');
			assert.strictEqual(extractLatestMessage(tail, 'claude'), undefined);
		});

		test('returns an empty tail for an empty file', async () => {
			const filePath = await write('empty.jsonl', '');
			assert.strictEqual(await readFileTail(filePath, root, LAST_MESSAGE_TAIL_BYTES), '');
		});

		test('keeps CRLF line endings parseable for message extraction', async () => {
			const content = [
				claudeMessage('user', 'CRLF first'),
				claudeMessage('assistant', 'CRLF latest'),
			].join('\r\n') + '\r\n';
			const filePath = await write('crlf.jsonl', content);
			const tail = await readFileTail(filePath, root, LAST_MESSAGE_TAIL_BYTES);
			assert.deepStrictEqual(extractLatestMessage(tail, 'claude'), { role: 'assistant', text: 'CRLF latest' });
		});

		test('rejects a transcript outside the allowed root', async () => {
			const insideDir = join(root, 'inside');
			const outsideDir = join(root, 'outside');
			await Promise.all([fs.mkdir(insideDir), fs.mkdir(outsideDir)]);
			const outsidePath = join(outsideDir, 'secret.jsonl');
			await fs.writeFile(outsidePath, 'SECRET\n');
			await assert.rejects(readFileTail(outsidePath, insideDir, 1024), /outside the allowed history directory/);
		});
	});

	suite('extractLatestMessage', () => {
		test('scans backwards past partial and non-message lines to the newest complete message', () => {
			const tail = [
				'{"partial": true', // 行途中で切れた不完全行
				JSON.stringify({ type: 'progress' }), // メッセージではない行
				claudeMessage('user', 'Older prompt'),
				claudeMessage('assistant', 'Newest reply'),
			].join('\n');
			assert.deepStrictEqual(extractLatestMessage(tail, 'claude'), { role: 'assistant', text: 'Newest reply' });
		});

		test('collapses whitespace in the extracted message', () => {
			const tail = claudeMessage('user', 'line one\n\tline two   spaced\r\n');
			assert.deepStrictEqual(extractLatestMessage(tail, 'claude'), { role: 'user', text: 'line one line two spaced' });
		});

		test('clips long messages to the preview character limit with an ellipsis', () => {
			const longText = 'a'.repeat(LAST_MESSAGE_CHARS + 50);
			const result = extractLatestMessage(claudeMessage('user', longText), 'claude');
			assert.ok(result);
			assert.strictEqual(result.text.length, LAST_MESSAGE_CHARS + 1);
			assert.ok(result.text.endsWith('…'));
		});

		test('extracts codex messages while skipping injected context lines', () => {
			const tail = [
				codexMessage('user', '<environment_context>injected</environment_context>'),
				codexMessage('assistant', 'Codex reply'),
			].join('\n');
			assert.deepStrictEqual(extractLatestMessage(tail, 'codex'), { role: 'assistant', text: 'Codex reply' });
		});

		test('returns undefined for an empty or message-less tail', () => {
			assert.strictEqual(extractLatestMessage('', 'claude'), undefined);
			assert.strictEqual(extractLatestMessage('\n\n', 'codex'), undefined);
		});
	});
});
