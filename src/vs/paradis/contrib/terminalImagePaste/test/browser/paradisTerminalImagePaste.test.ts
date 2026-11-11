/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { isString } from '../../../../../base/common/types.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { Severity, type INotification, type INotificationService } from '../../../../../platform/notification/common/notification.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { paradisIsLocalImagePathText, paradisTryTerminalImagePaste } from '../../browser/paradisTerminalImagePaste.js';

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

	function makeFileService(overrides: Partial<IFileService> = {}): IFileService {
		return {
			writeFile: async () => ({} as never),
			resolve: async () => ({ children: [] }),
			del: async () => { },
			exists: async () => false,
			...overrides,
		} as unknown as IFileService;
	}

	test('writes .gitignore before the image, so untracked .png is never visible on its own', async () => {
		const written: Array<{ path: string; authority: string; bytes: number }> = [];
		const inputs: string[] = [];
		const result = await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137, 80, 78, 71]) } as unknown as IClipboardService,
			{ raw: { input: (data: string) => inputs.push(data) } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: makeFileService({
					writeFile: async (resource: URI, buffer: VSBuffer) => {
						written.push({ path: resource.path, authority: resource.authority, bytes: buffer.byteLength });
						return {} as never;
					},
				}),
				remoteAuthority: 'ssh-remote+dev-pc',
				cwd: '/home/user/develop/workspace/sample-app'
			}
		);

		assert.deepStrictEqual(
			{
				returnedPathDirectory: isString(result) ? result.slice(0, result.lastIndexOf('/')) : result,
				isPng: isString(result) && result.endsWith('.png'),
				writeOrder: written.map(w => w.path.endsWith('.gitignore') ? 'gitignore' : w.path.endsWith('.png') ? 'image' : w.path),
				wroteToHost: written[0]?.authority,
				wroteImageBytes: written.find(w => w.path.endsWith('.png'))?.bytes,
				sentCtrlV: inputs.length
			},
			{
				returnedPathDirectory: '/home/user/develop/workspace/sample-app/.para-code/pasted-images',
				isPng: true,
				writeOrder: ['gitignore', 'image'],
				wroteToHost: 'ssh-remote+dev-pc',
				wroteImageBytes: 4,
				sentCtrlV: 0
			}
		);
	});

	test('creates .para-code/pasted-images/.gitignore with a wildcard when missing', async () => {
		const written = new Map<string, string>();
		await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137, 80, 78, 71]) } as unknown as IClipboardService,
			{ raw: { input: () => { } } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: makeFileService({
					writeFile: async (resource: URI, buffer: VSBuffer) => {
						written.set(resource.path, buffer.toString());
						return {} as never;
					},
				}),
				remoteAuthority: 'ssh-remote+dev-pc',
				cwd: '/home/user/develop/workspace/sample-app/packages/app'
			}
		);

		assert.strictEqual(
			written.get('/home/user/develop/workspace/sample-app/packages/app/.para-code/pasted-images/.gitignore'),
			'*\n'
		);
	});

	test('does not touch .gitignore again when it already exists, but still writes the image', async () => {
		const written: Array<{ path: string; content: string }> = [];
		const gitignorePath = '/home/user/develop/workspace/.para-code/pasted-images/.gitignore';
		const imagePath = '/home/user/develop/workspace/.para-code/pasted-images/'; // prefix check below
		const result = await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137, 80, 78, 71]) } as unknown as IClipboardService,
			{ raw: { input: () => { } } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: makeFileService({
					writeFile: async (resource: URI, buffer: VSBuffer) => {
						written.push({ path: resource.path, content: buffer.toString() });
						return {} as never;
					},
					exists: async (resource: URI) => resource.path === gitignorePath,
				}),
				remoteAuthority: 'ssh-remote+dev-pc',
				cwd: '/home/user/develop/workspace'
			}
		);

		assert.deepStrictEqual(
			{
				touchedGitignore: written.some(w => w.path === gitignorePath),
				wroteImage: isString(result) && result.startsWith(imagePath) && result.endsWith('.png'),
				writeCount: written.length,
			},
			{
				touchedGitignore: false,
				wroteImage: true,
				writeCount: 1,
			}
		);
	});

	test('still writes the image and returns its path even if preparing .gitignore fails', async () => {
		const result = await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137, 80, 78, 71]) } as unknown as IClipboardService,
			{ raw: { input: () => { } } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: makeFileService({
					exists: async (resource: URI) => {
						if (resource.path.endsWith('.gitignore')) {
							throw new Error('stat failed');
						}
						return false;
					},
				}),
				remoteAuthority: 'ssh-remote+dev-pc',
				cwd: '/home/user/develop/workspace'
			}
		);

		assert.strictEqual(isString(result) && result.endsWith('.png'), true);
	});

	test('cleans up only stale timestamped png files, sparing an oddly named .png and unrelated files', async () => {
		const now = Date.now();
		const staleTimestamp = now - 2 * 60 * 60 * 1000;
		const freshTimestamp = now - 60 * 1000;
		const deleted: string[] = [];
		await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137, 80, 78, 71]) } as unknown as IClipboardService,
			{ raw: { input: () => { } } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: makeFileService({
					resolve: async () => ({
						children: [
							{ name: `${staleTimestamp}.png`, isDirectory: false, resource: URI.parse(`vscode-remote://ssh-remote+dev-pc/home/user/.para-code/pasted-images/${staleTimestamp}.png`) },
							{ name: `${freshTimestamp}.png`, isDirectory: false, resource: URI.parse(`vscode-remote://ssh-remote+dev-pc/home/user/.para-code/pasted-images/${freshTimestamp}.png`) },
							{ name: '.png', isDirectory: false, resource: URI.parse('vscode-remote://ssh-remote+dev-pc/home/user/.para-code/pasted-images/.png') },
							{ name: '.gitignore', isDirectory: false, resource: URI.parse('vscode-remote://ssh-remote+dev-pc/home/user/.para-code/pasted-images/.gitignore') },
						],
					} as never),
					del: async (resource: URI) => { deleted.push(resource.path); },
				}),
				remoteAuthority: 'ssh-remote+dev-pc',
				cwd: '/home/user'
			}
		);

		assert.deepStrictEqual(deleted, [`/home/user/.para-code/pasted-images/${staleTimestamp}.png`]);
	});

	test('fills an empty cwd from the speculative cwd, so a restored editor terminal still receives the image', async () => {
		const written: string[] = [];
		const notified: string[] = [];
		const result = await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137, 80, 78, 71]) } as unknown as IClipboardService,
			{ raw: { input: () => { } } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: makeFileService({
					writeFile: async (resource: URI) => {
						written.push(resource.path);
						return {} as never;
					},
				}),
				remoteAuthority: 'ssh-remote+dev-pc',
				cwd: '',
				getSpeculativeCwd: async () => '/home/user/develop/workspace',
				notificationService: { notify: (n: INotification) => { notified.push(String(n.message)); } } as unknown as INotificationService,
			}
		);

		assert.deepStrictEqual(
			{
				returnedPathDirectory: isString(result) ? result.slice(0, result.lastIndexOf('/')) : result,
				wroteImage: written.some(path => path.startsWith('/home/user/develop/workspace/.para-code/pasted-images/') && path.endsWith('.png')),
				notified: notified.length,
			},
			{
				returnedPathDirectory: '/home/user/develop/workspace/.para-code/pasted-images',
				wroteImage: true,
				notified: 0,
			}
		);
	});

	test('notifies and reports handled (no empty paste) when connected but no working directory is known', async () => {
		const inputs: string[] = [];
		const notified: Severity[] = [];
		const reports: Array<{ operation: string; safeExtra: Record<string, unknown> | undefined }> = [];
		let writeCalls = 0;
		configureParadisDiagnosticReporter((_scope, _feature, operation, _error, safeExtra) => reports.push({ operation, safeExtra }));
		const result = await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137]) } as unknown as IClipboardService,
			{ raw: { input: (data: string) => inputs.push(data) } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: makeFileService({
					writeFile: async () => {
						writeCalls++;
						return {} as never;
					},
				}),
				remoteAuthority: 'ssh-remote+dev-pc',
				cwd: '',
				getSpeculativeCwd: async () => '',
				notificationService: { notify: (n: INotification) => { notified.push(n.severity); } } as unknown as INotificationService,
			}
		);

		configureParadisDiagnosticReporter(() => { });

		// true を返すので呼び出し元は空の bracketed paste を送らない。接続先の TUI はこちらの
		// クリップボードを読めないので、0x16 も送らない。Sentry の属性名は sensitiveFields
		// （cwd・path 等）に部分一致するとサーバー側で消されるので、その語を含まない名前にする
		assert.deepStrictEqual(
			{ result, sentCtrlV: inputs.length, writeCalls, notified, reports },
			{
				result: true, sentCtrlV: 0, writeCalls: 0, notified: [Severity.Warning],
				reports: [{ operation: 'remote-cwd-missing', safeExtra: { safe_has_fallback_dir: true, safe_fallback_dir_failed: false } }]
			}
		);
	});

	test('notifies and reports handled when writing the image to the connected host fails', async () => {
		const notified: Severity[] = [];
		const result = await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137]) } as unknown as IClipboardService,
			{ raw: { input: () => { } } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: makeFileService({
					writeFile: async (resource: URI) => {
						if (resource.path.endsWith('.png')) {
							throw new Error('permission denied');
						}
						return {} as never;
					},
				}),
				remoteAuthority: 'ssh-remote+dev-pc',
				cwd: '/home/user/develop/workspace',
				notificationService: { notify: (n: INotification) => { notified.push(n.severity); } } as unknown as INotificationService,
			}
		);

		assert.deepStrictEqual({ result, notified }, { result: true, notified: [Severity.Warning] });
	});

	test('routes a pasted local image path to the image path only in SSH terminals', () => {
		const cases = [
			'/var/folders/5l/T/DroppyCapture-1/Screenshot_2026_09-30_12-23-26.png',
			'/Users/example/Desktop/shot.JPG\n',
			'file:///Users/example/shot.webp',
			'C:\\Users\\example\\shot.gif',
			'/Users/example/notes.txt',
			'shot.png',
			'/Users/example/a.png\n/Users/example/b.png',
			'see /Users/example/shot.png',
		];
		assert.deepStrictEqual(
			cases.map(text => [paradisIsLocalImagePathText(text, 'ssh-remote+host'), paradisIsLocalImagePathText(text, undefined)]),
			[[true, false], [true, false], [true, false], [true, false], [false, false], [false, false], [false, false], [false, false]]
		);
	});
});
