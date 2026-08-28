/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { readFile, stat } from 'fs/promises';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_FILE_DROP_MAX_BYTES,
	ParadisFileDropStaging,
	paradisBuildFileDropDragCancelCommand,
	paradisBuildFileDropDragCommands,
	paradisDecodeFileDropContent,
	paradisParseResolvedDropTarget,
	paradisSanitizeFileDropName,
} from '../../node/paradisFileDropUpload.js';

function evaluateScriptResult(...lines: string[]): unknown {
	return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function targetJson(overrides: Partial<{ x: number; y: number; width: number; height: number; inMainFrame: boolean; viewW: number; viewH: number; occluded: boolean }> = {}): string {
	return JSON.stringify({ x: 12.5, y: 40, width: 100, height: 20, inMainFrame: true, viewW: 1280, viewH: 800, occluded: false, ...overrides });
}

suite('paradisFileDropUpload', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('paradisParseResolvedDropTarget', () => {
		test('parses the fenced JSON block evaluate_script returns, including frame/viewport/occlusion fields', () => {
			const result = evaluateScriptResult('Script ran on page and returned:', '```json', targetJson(), '```');
			assert.deepStrictEqual(paradisParseResolvedDropTarget(result), {
				x: 12.5, y: 40, width: 100, height: 20, inMainFrame: true, viewportWidth: 1280, viewportHeight: 800, occluded: false,
			});
		});

		test('parses occluded: true when a sticky header or modal covers the element', () => {
			const result = evaluateScriptResult('```json', targetJson({ occluded: true }), '```');
			assert.strictEqual(paradisParseResolvedDropTarget(result)?.occluded, true);
		});

		test('rejects a missing fence, non-numeric fields, missing frame/viewport/occlusion fields, and non-object content', () => {
			assert.strictEqual(paradisParseResolvedDropTarget(evaluateScriptResult('no fence here')), undefined);
			assert.strictEqual(paradisParseResolvedDropTarget(evaluateScriptResult('```json', '{"x":"a","y":1,"width":1,"height":1}', '```')), undefined);
			// inMainFrame/viewW/viewH/occludedが欠けている（HIGH-2対応前のevaluate_script出力形状）は拒否する
			assert.strictEqual(paradisParseResolvedDropTarget(evaluateScriptResult('```json', '{"x":1,"y":1,"width":1,"height":1}', '```')), undefined);
			assert.strictEqual(paradisParseResolvedDropTarget(evaluateScriptResult('```json', targetJson({ inMainFrame: undefined as unknown as boolean }), '```')), undefined);
			assert.strictEqual(paradisParseResolvedDropTarget(evaluateScriptResult('```json', targetJson({ occluded: undefined as unknown as boolean }), '```')), undefined);
			assert.strictEqual(paradisParseResolvedDropTarget({ content: [{ type: 'image', data: 'AAA' }] }), undefined);
			assert.strictEqual(paradisParseResolvedDropTarget(undefined), undefined);
		});
	});

	suite('paradisDecodeFileDropContent', () => {
		test('decodes valid base64, strips whitespace/newlines, and rejects malformed input', () => {
			const decoded = paradisDecodeFileDropContent(Buffer.from('hello').toString('base64'));
			assert.strictEqual(decoded?.toString(), 'hello');

			// エージェント側で折り返された(改行入りの)base64でも通る
			const wrapped = Buffer.from('hello, wrapped base64!').toString('base64').replace(/(.{4})/g, '$1\n');
			assert.strictEqual(paradisDecodeFileDropContent(wrapped)?.toString(), 'hello, wrapped base64!');

			assert.strictEqual(paradisDecodeFileDropContent(''), undefined);
			assert.strictEqual(paradisDecodeFileDropContent('   '), undefined);
			assert.strictEqual(paradisDecodeFileDropContent(123), undefined);
			assert.strictEqual(paradisDecodeFileDropContent('not-base64!!'), undefined);
		});

		test('accepts exactly the transport-limited byte cap and rejects one byte over it', () => {
			// PARADIS_FILE_DROP_MAX_BYTES ちょうど: 通る
			const atLimit = Buffer.alloc(PARADIS_FILE_DROP_MAX_BYTES, 7).toString('base64');
			const decoded = paradisDecodeFileDropContent(atLimit);
			assert.strictEqual(decoded?.byteLength, PARADIS_FILE_DROP_MAX_BYTES);

			// +1バイト: 弾かれる（旧テストは長さ上限の事前チェックにしか当たらない値を使っており、
			// この境界の分岐を実質検証できていなかった）
			const overLimit = Buffer.alloc(PARADIS_FILE_DROP_MAX_BYTES + 1, 7).toString('base64');
			assert.strictEqual(paradisDecodeFileDropContent(overLimit), undefined);
		});
	});

	suite('paradisSanitizeFileDropName', () => {
		test('accepts a plain file name and rejects traversal, separators, control characters, and Windows-reserved characters', () => {
			assert.strictEqual(paradisSanitizeFileDropName('photo.png'), 'photo.png');
			assert.strictEqual(paradisSanitizeFileDropName('  spaced.txt  '), 'spaced.txt');
			assert.strictEqual(paradisSanitizeFileDropName('..'), undefined);
			assert.strictEqual(paradisSanitizeFileDropName('.'), undefined);
			assert.strictEqual(paradisSanitizeFileDropName('../etc/passwd'), undefined);
			assert.strictEqual(paradisSanitizeFileDropName('a/b.png'), undefined);
			assert.strictEqual(paradisSanitizeFileDropName('a\\b.png'), undefined);
			assert.strictEqual(paradisSanitizeFileDropName('bad\0name.png'), undefined);
			assert.strictEqual(paradisSanitizeFileDropName(42), undefined);
			// Windows予約文字（`:` はNTFSの代替データストリーム記法回避のため他OSでも一律禁止）
			for (const reserved of ['<', '>', ':', '"', '|', '?', '*']) {
				assert.strictEqual(paradisSanitizeFileDropName(`bad${reserved}name.png`), undefined, `expected "${reserved}" to be rejected`);
			}
		});
	});

	suite('paradisBuildFileDropDragCommands', () => {
		test('builds a dragEnter, dragOver, drop sequence carrying the same staged file', () => {
			const commands = paradisBuildFileDropDragCommands(10, 20, '/tmp/paradis-mcp-drop-x/photo.png');
			assert.strictEqual(commands.length, 3);
			for (const command of commands) {
				assert.strictEqual(command.method, 'Input.dispatchDragEvent');
			}
			const parsed = commands.map(command => JSON.parse(command.paramsJson));
			assert.deepStrictEqual(parsed.map(entry => entry.type), ['dragEnter', 'dragOver', 'drop']);
			for (const entry of parsed) {
				assert.strictEqual(entry.x, 10);
				assert.strictEqual(entry.y, 20);
				assert.deepStrictEqual(entry.data, { items: [], dragOperationsMask: 1, files: ['/tmp/paradis-mcp-drop-x/photo.png'] });
			}
		});
	});

	suite('paradisBuildFileDropDragCancelCommand', () => {
		test('builds a dragCancel carrying the same staged file, for cleanup after a failed drop', () => {
			const cancel = paradisBuildFileDropDragCancelCommand(10, 20, '/tmp/paradis-mcp-drop-x/photo.png');
			assert.strictEqual(cancel.method, 'Input.dispatchDragEvent');
			const parsed = JSON.parse(cancel.paramsJson);
			assert.strictEqual(parsed.type, 'dragCancel');
			assert.deepStrictEqual(parsed.data, { items: [], dragOperationsMask: 1, files: ['/tmp/paradis-mcp-drop-x/photo.png'] });
		});
	});

	suite('ParadisFileDropStaging', () => {
		test('writes the content under a fresh directory and disposes it immediately', async () => {
			const staging = new ParadisFileDropStaging();
			const filePath = await staging.stage(Buffer.from('file-bytes'), 'photo.png');

			assert.strictEqual(filePath.endsWith('photo.png'), true);
			assert.strictEqual((await readFile(filePath)).toString(), 'file-bytes');

			staging.dispose();
			// dispose()の掃除は非同期(fire-and-forget)なので、消えるまで少し待つ。
			await new Promise(resolve => setTimeout(resolve, 50));
			await assert.rejects(stat(filePath));
		});

		test('keeps two uploads with the same file name from colliding', async () => {
			const staging = new ParadisFileDropStaging();
			const first = await staging.stage(Buffer.from('a'), 'same.png');
			const second = await staging.stage(Buffer.from('b'), 'same.png');

			assert.notStrictEqual(first, second);
			assert.strictEqual((await readFile(first)).toString(), 'a');
			assert.strictEqual((await readFile(second)).toString(), 'b');

			staging.dispose();
		});

		test('evicts the oldest entry once the entry-count cap is reached', async () => {
			const staging = new ParadisFileDropStaging(10 * 60_000, 2, 1024 * 1024);
			const first = await staging.stage(Buffer.from('1'), 'a.bin');
			const second = await staging.stage(Buffer.from('2'), 'b.bin');
			// 3件目で上限(2件)に達するため、最古(first)が即時掃除される
			const third = await staging.stage(Buffer.from('3'), 'c.bin');

			await new Promise(resolve => setTimeout(resolve, 50));
			await assert.rejects(stat(first));
			assert.strictEqual((await readFile(second)).toString(), '2');
			assert.strictEqual((await readFile(third)).toString(), '3');

			staging.dispose();
		});

		test('evicts the oldest entries once the total-byte cap is reached', async () => {
			const staging = new ParadisFileDropStaging(10 * 60_000, 32, 10);
			const first = await staging.stage(Buffer.alloc(6, 1), 'a.bin');
			// 2件目(6バイト)を足すと合計12バイトで上限(10バイト)を超えるため、最古(first)を掃除してから書く
			const second = await staging.stage(Buffer.alloc(6, 2), 'b.bin');

			await new Promise(resolve => setTimeout(resolve, 50));
			await assert.rejects(stat(first));
			assert.strictEqual((await readFile(second)).byteLength, 6);

			staging.dispose();
		});
	});
});
