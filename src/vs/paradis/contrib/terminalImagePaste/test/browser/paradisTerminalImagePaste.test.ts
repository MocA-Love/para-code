/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import type { VSBuffer } from '../../../../../base/common/buffer.js';
import { isString } from '../../../../../base/common/types.js';
import type { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
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

	test('writes the image onto the connected host and returns its path instead of Ctrl+V', async () => {
		const written: Array<{ path: string; authority: string; bytes: number }> = [];
		const inputs: string[] = [];
		const result = await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137, 80, 78, 71]) } as unknown as IClipboardService,
			{ raw: { input: (data: string) => inputs.push(data) } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: {
					writeFile: async (resource: URI, buffer: VSBuffer) => {
						written.push({ path: resource.path, authority: resource.authority, bytes: buffer.byteLength });
					},
					resolve: async () => ({ children: [] }),
					del: async () => { },
				} as unknown as IFileService,
				remoteAuthority: 'ssh-remote+paradis-pc',
				cwd: '/home/yuasa/develop/maguro/ai-zyusetu'
			}
		);

		assert.deepStrictEqual(
			{
				returnedPathDirectory: isString(result) ? result.slice(0, result.lastIndexOf('/')) : result,
				isPng: isString(result) && result.endsWith('.png'),
				wroteOnce: written.length,
				wroteToHost: written[0]?.authority,
				wroteBytes: written[0]?.bytes,
				sentCtrlV: inputs.length
			},
			{
				returnedPathDirectory: '/home/yuasa/develop/maguro/ai-zyusetu',
				isPng: true,
				wroteOnce: 1,
				wroteToHost: 'ssh-remote+paradis-pc',
				wroteBytes: 4,
				sentCtrlV: 0
			}
		);
	});

	test('falls through when connected but the terminal has no working directory', async () => {
		const inputs: string[] = [];
		const result = await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137]) } as unknown as IClipboardService,
			{ raw: { input: (data: string) => inputs.push(data) } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: {} as unknown as IFileService,
				remoteAuthority: 'ssh-remote+paradis-pc',
				cwd: undefined
			}
		);

		// 接続先の TUI はこちらのクリップボードを読めないので、0x16 を送っても紛らわしいだけ
		assert.deepStrictEqual({ result, sentCtrlV: inputs.length }, { result: false, sentCtrlV: 0 });
	});
});
