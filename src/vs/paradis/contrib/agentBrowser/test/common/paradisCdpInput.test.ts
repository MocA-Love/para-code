/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_CDP_INPUT_MAX_PARAMS_BYTES,
	paradisParseCdpInputCommand,
	paradisParseCdpInputDispatchResult,
} from '../../common/paradisAgentBrowser.js';

suite('Paradis CDP input protocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only the six focusless methods and returns a deeply copy-owned command', () => {
		const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
			['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'A', code: 'KeyA', modifiers: 2 }],
			['Input.insertText', { text: 'hello' }],
			['Input.imeSetComposition', { text: '変換', selectionStart: 0, selectionEnd: 2 }],
			['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 2 }],
			['Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 1, y: 2 }] }],
			['Input.dispatchDragEvent', {
				type: 'dragEnter', x: 1, y: 2,
				data: { items: [], files: [], dragOperationsMask: 1 },
			}],
		];

		for (const [method, params] of cases) {
			const command = paradisParseCdpInputCommand(method, JSON.stringify(params));
			assert.ok(command, method);
			assert.strictEqual(command.method, method);
			assert.deepStrictEqual(command.params, params);
			assert.strictEqual(Object.isFrozen(command), true);
			assert.strictEqual(Object.isFrozen(command.params), true);
		}

		assert.strictEqual(paradisParseCdpInputCommand('Input.setIgnoreInputEvents', '{}'), undefined);
		assert.strictEqual(paradisParseCdpInputCommand('Runtime.evaluate', '{}'), undefined);
	});

	test('strictly validates keyboard, IME, pointer, touch and drag fields', () => {
		const invalid: ReadonlyArray<readonly [string, unknown]> = [
			['Input.dispatchKeyEvent', { type: 'keyDown', key: 'A' }],
			['Input.dispatchKeyEvent', { type: 'unknown', key: 'A', code: 'KeyA' }],
			['Input.dispatchKeyEvent', { type: 'keyDown', key: 'A', code: 'KeyA', modifiers: 16 }],
			['Input.insertText', {}],
			['Input.insertText', { text: 1 }],
			['Input.imeSetComposition', { text: 'x', selectionStart: 0 }],
			['Input.imeSetComposition', { text: 'x', selectionStart: -1, selectionEnd: 0 }],
			['Input.dispatchMouseEvent', { type: 'mouseMoved', x: Number.NaN, y: 0 }],
			['Input.dispatchMouseEvent', { type: 'unknown', x: 0, y: 0 }],
			['Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [] }],
			['Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 0 }] }],
			['Input.dispatchDragEvent', { type: 'dragEnter', x: 0, y: 0, data: { items: [], dragOperationsMask: -1 } }],
			['Input.dispatchDragEvent', { type: 'dragEnter', x: 0, y: 0, data: { items: [{ mimeType: 'text/plain' }], dragOperationsMask: 1 } }],
			['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0, extra: true }],
		];

		for (const [method, params] of invalid) {
			assert.strictEqual(paradisParseCdpInputCommand(method, JSON.stringify(params)), undefined, `${method}: ${JSON.stringify(params)}`);
		}
		for (const malformed of ['', 'null', '[]', '{', '1', '"text"']) {
			assert.strictEqual(paradisParseCdpInputCommand('Input.insertText', malformed), undefined);
		}
	});

	test('bounds identifiers, collections and serialized params before Main dispatch', () => {
		assert.strictEqual(paradisParseCdpInputCommand('Input.insertText', JSON.stringify({ text: 'x'.repeat(PARADIS_CDP_INPUT_MAX_PARAMS_BYTES) })), undefined);
		assert.strictEqual(paradisParseCdpInputCommand('Input.dispatchKeyEvent', JSON.stringify({ type: 'keyDown', key: 'x'.repeat(129), code: 'KeyX' })), undefined);
		assert.strictEqual(paradisParseCdpInputCommand('Input.dispatchTouchEvent', JSON.stringify({
			type: 'touchStart', touchPoints: Array.from({ length: 33 }, (_, id) => ({ x: id, y: id })),
		})), undefined);
		assert.strictEqual(paradisParseCdpInputCommand('Input.dispatchDragEvent', JSON.stringify({
			type: 'dragEnter', x: 0, y: 0,
			data: { items: Array.from({ length: 65 }, () => ({ mimeType: 'text/plain', data: 'x' })), dragOperationsMask: 1 },
		})), undefined);
	});

	test('parses only bounded exact Main outcomes', () => {
		assert.deepStrictEqual(paradisParseCdpInputDispatchResult({ status: 'success', result: { applied: true } }), {
			status: 'success', result: { applied: true },
		});
		assert.deepStrictEqual(paradisParseCdpInputDispatchResult({ status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: focused' }), {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: focused',
		});
		assert.deepStrictEqual(paradisParseCdpInputDispatchResult({ status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: changed' }), {
			status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: changed',
		});

		for (const value of [
			null,
			{},
			{ status: 'success' },
			{ status: 'retryable', message: 'wrong-prefix' },
			{ status: 'outcome-unknown', message: 'PARA_BROWSER_RETRYABLE: wrong-kind' },
			{ status: 'success', result: {}, extra: true },
			{ status: 'retryable', message: `PARA_BROWSER_RETRYABLE: ${'x'.repeat(1024)}` },
		]) {
			assert.strictEqual(paradisParseCdpInputDispatchResult(value), undefined);
		}
	});
});
