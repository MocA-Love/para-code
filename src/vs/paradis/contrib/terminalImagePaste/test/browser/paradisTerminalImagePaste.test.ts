/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { paradisTryTerminalImagePaste } from '../../browser/paradisTerminalImagePaste.js';

type XtermFake = { raw: Pick<RawXtermTerminal, 'input'> };

suite('ParadisTerminalImagePaste', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends literal Ctrl+V as user input when the clipboard contains image bytes', async () => {
		const inputs: Array<{ data: string; wasUserInput: boolean | undefined }> = [];
		const clipboardService = {
			readImage: async () => new Uint8Array([137, 80, 78, 71]),
		} satisfies Pick<IClipboardService, 'readImage'>;
		const xterm = {
			raw: {
				input: (data: string, wasUserInput?: boolean) => inputs.push({ data, wasUserInput }),
			},
		} satisfies XtermFake;

		const handled = await paradisTryTerminalImagePaste(
			clipboardService as unknown as IClipboardService,
			xterm as unknown as { raw: RawXtermTerminal },
		);

		assert.strictEqual(handled, true);
		assert.deepStrictEqual(inputs, [{ data: '\x16', wasUserInput: true }]);
	});

	test('does not write terminal input for an empty or unreadable image clipboard', async () => {
		let inputCalls = 0;
		const xterm = {
			raw: {
				input: () => inputCalls++,
			},
		} satisfies XtermFake;
		const emptyClipboard = {
			readImage: async () => new Uint8Array(),
		} satisfies Pick<IClipboardService, 'readImage'>;
		const failingClipboard = {
			readImage: async (): Promise<Uint8Array> => {
				throw new Error('clipboard unavailable');
			},
		} satisfies Pick<IClipboardService, 'readImage'>;

		assert.strictEqual(await paradisTryTerminalImagePaste(
			emptyClipboard as unknown as IClipboardService,
			xterm as unknown as { raw: RawXtermTerminal },
		), false);
		assert.strictEqual(await paradisTryTerminalImagePaste(
			failingClipboard as unknown as IClipboardService,
			xterm as unknown as { raw: RawXtermTerminal },
		), false);
		assert.strictEqual(inputCalls, 0);
	});
});
