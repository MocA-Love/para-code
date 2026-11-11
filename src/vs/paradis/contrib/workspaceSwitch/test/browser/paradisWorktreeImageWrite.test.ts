/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { paradisTryTerminalImagePaste } from '../../../terminalImagePaste/browser/paradisTerminalImagePaste.js';
import { paradisWriteWorktreeImages } from '../../browser/paradisWorktreeImageWrite.js';
import { IParadisWorktreeImage, paradisWorktreeImageFileName } from '../../common/paradisWorktreeImageAttach.js';

suite('paradisWorktreeImageWrite', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const images: IParadisWorktreeImage[] = [
		{ name: 'shot.png', mime: 'image/png', data: VSBuffer.wrap(new Uint8Array([137, 80, 78, 71])) },
		{ name: 'photo.jpg', mime: 'image/jpeg', data: VSBuffer.wrap(new Uint8Array([255, 216, 255])) },
	];

	/** 書いたファイルを覚え、`exists` にそのまま答える偽物。 */
	function fileService(write: (resource: URI, buffer: VSBuffer) => void): IFileService {
		const files = new Set<string>();
		return {
			exists: async (resource: URI) => files.has(resource.toString()),
			writeFile: async (resource: URI, buffer: VSBuffer) => {
				files.add(resource.toString());
				write(resource, buffer);
				return {} as never;
			},
		} as unknown as IFileService;
	}

	test('writes .gitignore and then the images into the space on the SSH host, and returns paths relative to the space', async () => {
		const written: string[] = [];
		const space = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev-pc', path: '/home/user/repo-worktrees/fix-login' });
		const result = await paradisWriteWorktreeImages(fileService(resource => written.push(`${resource.scheme}://${resource.authority}${resource.path}`)), space, images, 1762876411000);
		assert.deepStrictEqual({ result, written }, {
			result: { kind: 'written', paths: ['.para-code/pasted-images/1762876411000-1.png', '.para-code/pasted-images/1762876411000-2.jpg'] },
			written: [
				'vscode-remote://ssh-remote+dev-pc/home/user/repo-worktrees/fix-login/.para-code/pasted-images/.gitignore',
				'vscode-remote://ssh-remote+dev-pc/home/user/repo-worktrees/fix-login/.para-code/pasted-images/1762876411000-1.png',
				'vscode-remote://ssh-remote+dev-pc/home/user/repo-worktrees/fix-login/.para-code/pasted-images/1762876411000-2.jpg',
			],
		});
	});

	test('passes no image when one of them cannot be written', async () => {
		const service = {
			exists: async () => true,
			writeFile: async (resource: URI) => {
				if (resource.path.endsWith('-2.jpg')) {
					throw new Error('connection lost');
				}
				return {} as never;
			},
		} as unknown as IFileService;
		const result = await paradisWriteWorktreeImages(service, URI.file('/tmp/space'), images, 1);
		assert.deepStrictEqual(result, { kind: 'failed' });
	});

	test('the hourly clean-up of pasted terminal images leaves the attached images alone', async () => {
		const stale = Date.now() - 2 * 60 * 60 * 1000;
		const directory = 'vscode-remote://ssh-remote+dev-pc/home/user/.para-code/pasted-images';
		const attached = [paradisWorktreeImageFileName(stale, 0, 'image/png'), paradisWorktreeImageFileName(stale, 1, 'image/jpeg')];
		const deleted: string[] = [];
		await paradisTryTerminalImagePaste(
			{ readImage: async () => new Uint8Array([137, 80, 78, 71]) } as unknown as IClipboardService,
			{ raw: { input: () => { } } } as unknown as { raw: RawXtermTerminal },
			{
				fileService: {
					exists: async () => true,
					writeFile: async () => ({} as never),
					resolve: async () => ({
						children: [`${stale}.png`, ...attached].map(name => ({ name, isDirectory: false, resource: URI.parse(`${directory}/${name}`) })),
					}),
					del: async (resource: URI) => { deleted.push(resource.path); },
				} as unknown as IFileService,
				remoteAuthority: 'ssh-remote+dev-pc',
				cwd: '/home/user',
			},
		);
		assert.deepStrictEqual(deleted, [`/home/user/.para-code/pasted-images/${stale}.png`]);
	});
});
