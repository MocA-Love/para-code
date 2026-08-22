/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_SCREENSHOT_FETCH_PATH, ParadisScreenshotHandoff, paradisAppendScreenshotFetchHint, paradisReadScreenshotFile, paradisScreenshotContentType, paradisScreenshotIdFromUrl, paradisScreenshotPathsFromToolResult } from '../../node/paradisScreenshotHandoff.js';

function toolResult(...lines: string[]): unknown {
	return { content: [{ type: 'text', text: lines.join('\n') }] };
}

suite('ParadisScreenshotHandoff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks up the file the screenshot tool wrote, whichever way it was saved', () => {
		assert.deepStrictEqual(
			paradisScreenshotPathsFromToolResult(toolResult(
				'Took a screenshot of the current page\'s viewport.',
				// `filePath` 指定のときも、2MB超で一時ファイルへ逃げたときも、同じ1行を書く
				'Saved screenshot to /tmp/e2e-2178/before.png.',
			)),
			['/tmp/e2e-2178/before.png'],
		);
		assert.deepStrictEqual(
			paradisScreenshotPathsFromToolResult(toolResult('Saved screenshot to /var/folders/x/screenshot.v2.jpeg.')),
			['/var/folders/x/screenshot.v2.jpeg'],
		);
		// 画像が応答に直接載った場合（保存していない）は何も拾わない
		assert.deepStrictEqual(paradisScreenshotPathsFromToolResult(toolResult('Took a screenshot of the full current page.')), []);
		assert.deepStrictEqual(paradisScreenshotPathsFromToolResult({ content: [{ type: 'image', data: 'AAA' }] }), []);
		assert.deepStrictEqual(paradisScreenshotPathsFromToolResult(undefined), []);
	});

	test('adds the download line only when something was saved', () => {
		const saved = toolResult('Saved screenshot to /tmp/a.png.');
		const hinted = paradisAppendScreenshotFetchHint(saved, [{ id: 'abc', localPort: 47286 }]) as { content: { type: string; text: string }[] };
		assert.strictEqual(hinted.content.length, 2);
		const hint = hinted.content[1].text;
		// 手元向けには実際の番号を書く
		assert.ok(hint.includes('http://127.0.0.1:47286/paradis-mcp/screenshot/abc'));
		// 接続先向けは番号を焼き込まず、ポートファイルから読ませる (ssh が選ぶ番号は手元と違う)
		assert.ok(hint.includes('$PARA_CODE_MCP_PORT_FILE'));
		assert.ok(hint.includes('"http://127.0.0.1:$PORT/paradis-mcp/screenshot/abc"'));
		// 元の本文は触らない
		assert.strictEqual(hinted.content[0].text, 'Saved screenshot to /tmp/a.png.');

		const inline = toolResult('Took a screenshot.');
		assert.strictEqual(paradisAppendScreenshotFetchHint(inline, []), inline);
	});

	test('hands a saved screenshot back only to the pane that took it', () => {
		let next = 0;
		const handoff = new ParadisScreenshotHandoff(() => `id-${++next}`);
		const id = handoff.register('pane-a', '/tmp/a.png');

		assert.strictEqual(handoff.resolve('pane-a', id), '/tmp/a.png');
		// ペイントークンは端末の子プロセスなら誰でも名乗れるので、撮った本人だけに渡す
		assert.strictEqual(handoff.resolve('pane-b', id), undefined);
		assert.strictEqual(handoff.resolve('pane-a', 'id-999'), undefined);
	});

	test('keeps only the most recent handoffs', () => {
		let next = 0;
		const handoff = new ParadisScreenshotHandoff(() => `id-${++next}`);
		const first = handoff.register('pane-a', '/tmp/0.png');
		for (let i = 1; i <= 40; i++) {
			handoff.register('pane-a', `/tmp/${i}.png`);
		}
		assert.deepStrictEqual(
			[handoff.size, handoff.resolve('pane-a', first), handoff.resolve('pane-a', 'id-41')],
			[32, undefined, '/tmp/40.png'],
		);
	});

	test('accepts only the exact fetch shape', () => {
		assert.deepStrictEqual([
			paradisScreenshotIdFromUrl(`${PARADIS_SCREENSHOT_FETCH_PATH}/abc-123`),
			paradisScreenshotIdFromUrl(`${PARADIS_SCREENSHOT_FETCH_PATH}/abc-123?pane=x`),
			// パスは要求側に決めさせない
			paradisScreenshotIdFromUrl(`${PARADIS_SCREENSHOT_FETCH_PATH}/../../etc/passwd`),
			paradisScreenshotIdFromUrl(`${PARADIS_SCREENSHOT_FETCH_PATH}/a/b`),
			paradisScreenshotIdFromUrl(`${PARADIS_SCREENSHOT_FETCH_PATH}/`),
			paradisScreenshotIdFromUrl(`${PARADIS_SCREENSHOT_FETCH_PATH}x/abc`),
			paradisScreenshotIdFromUrl(undefined),
		], ['abc-123', 'abc-123', undefined, undefined, undefined, undefined, undefined]);
	});

	test('labels the download with the format that was captured', () => {
		assert.deepStrictEqual([
			paradisScreenshotContentType('/tmp/a.png'),
			paradisScreenshotContentType('/tmp/a.JPEG'),
			paradisScreenshotContentType('/tmp/a.webp'),
			paradisScreenshotContentType('/tmp/a'),
		], ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']);
	});

	suite('paradisReadScreenshotFile', () => {
		let dir: string;

		setup(() => {
			dir = mkdtempSync(join(tmpdir(), 'paradis-screenshot-read-'));
		});

		teardown(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		test('reads a normal file', async () => {
			const path = join(dir, 'a.png');
			writeFileSync(path, 'fake-png-bytes');

			const body = await paradisReadScreenshotFile(path);

			assert.strictEqual(body?.toString(), 'fake-png-bytes');
		});

		test('returns undefined for a missing file instead of throwing', async () => {
			const body = await paradisReadScreenshotFile(join(dir, 'missing.png'));

			assert.strictEqual(body, undefined);
		});

		// クライアント切断時に呼び出し側が signal を abort する経路の代わり。ingress 枠の
		// dispose 待ちを止めるための AbortSignal 接続が実際に効いていることを確認する。
		test('does not return file contents once the signal is already aborted', async () => {
			const path = join(dir, 'b.png');
			writeFileSync(path, 'fake-png-bytes');
			const controller = new AbortController();
			controller.abort();

			const body = await paradisReadScreenshotFile(path, controller.signal);

			assert.strictEqual(body, undefined);
		});

		test('aborts an in-flight read when the signal fires', async () => {
			const path = join(dir, 'c.png');
			writeFileSync(path, Buffer.alloc(8 * 1024 * 1024, 1));
			const controller = new AbortController();

			const pending = paradisReadScreenshotFile(path, controller.signal);
			controller.abort();

			assert.strictEqual(await pending, undefined);
		});
	});
});
