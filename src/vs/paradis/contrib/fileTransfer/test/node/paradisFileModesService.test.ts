/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisFileModesChannel, ParadisFileModesService } from '../../node/paradisFileModesService.js';
import { IParadisFileStatInfo, PARADIS_FILE_MODES_PROTOCOL_VERSION } from '../../common/paradisFileTransfer.js';

// chmod の意味が POSIX と違うので Windows では走らせない
(isWindows ? suite.skip : suite)('Paradis file transfer - file modes channel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fsp.mkdtemp(join(tmpdir(), 'paradis-file-modes-'));
		await fsp.mkdir(join(root, 'dir'));
		await fsp.writeFile(join(root, 'dir', 'plain.txt'), 'x');
		await fsp.writeFile(join(root, 'dir', 'run.sh'), 'x');
		await fsp.writeFile(join(root, 'readme.md'), 'hello');
		await fsp.symlink(join(root, 'dir'), join(root, 'link'));
		await fsp.chmod(join(root, 'dir'), 0o700);
		await fsp.chmod(join(root, 'dir', 'plain.txt'), 0o600);
		await fsp.chmod(join(root, 'dir', 'run.sh'), 0o700);
		await fsp.chmod(join(root, 'readme.md'), 0o644);
	});

	teardown(async () => {
		await fsp.rm(root, { recursive: true, force: true });
	});

	test('lists names, kinds, sizes and modes in one call', async () => {
		const service = new ParadisFileModesService();
		const listing = await service.list({ resource: URI.file(root) });
		const entries = [...listing.entries]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(entry => ({ name: entry.name, kind: entry.kind, isDirectory: entry.isDirectory, mode: entry.mode.toString(8), size: entry.kind === 'file' ? entry.size : undefined }));
		assert.deepStrictEqual({ truncated: listing.truncated, entries }, {
			truncated: false,
			entries: [
				{ name: 'dir', kind: 'directory', isDirectory: true, mode: '700', size: undefined },
				{ name: 'link', kind: 'symlink', isDirectory: true, mode: (await fsp.lstat(join(root, 'link'))).mode.toString(8).slice(-3), size: undefined },
				{ name: 'readme.md', kind: 'file', isDirectory: false, mode: '644', size: 5 },
			],
		});
	});

	test('chmod applies to the folder, and recursively keeps whether files were executable', async () => {
		const channel = new ParadisFileModesChannel<string>(new ParadisFileModesService());
		const version = await channel.call<number>('', 'version');
		await channel.call('', 'chmod', { resource: URI.file(join(root, 'dir')), mode: 0o755, recursive: true });
		const mode = async (path: string) => ((await fsp.lstat(join(root, path))).mode & 0o7777).toString(8);
		assert.deepStrictEqual({
			version,
			dir: await mode('dir'),
			plain: await mode('dir/plain.txt'),
			run: await mode('dir/run.sh'),
			untouched: await mode('readme.md'),
		}, {
			version: PARADIS_FILE_MODES_PROTOCOL_VERSION,
			dir: '755',
			plain: '644',
			run: '755',
			untouched: '644',
		});
	});

	test('refuses to chmod a link (chmod would change the link target), and strips special bits from files', async () => {
		const service = new ParadisFileModesService();
		const onLink = await service.chmod({ resource: URI.file(join(root, 'link')), mode: 0o700, recursive: false }).then(() => 'ok', () => 'rejected');
		await service.chmod({ resource: URI.file(join(root, 'dir')), mode: 0o2775, recursive: true });
		const mode = async (path: string) => ((await fsp.lstat(join(root, path))).mode & 0o7777).toString(8);
		assert.deepStrictEqual({ onLink, dirStill: await mode('dir'), run: await mode('dir/run.sh'), plain: await mode('dir/plain.txt') }, {
			onLink: 'rejected',
			dirStill: '2775',
			run: '775',
			plain: '664',
		});
	});

	test('statFile reports mode, owner, hard links and links, and nothing for a missing file', async () => {
		await fsp.link(join(root, 'readme.md'), join(root, 'readme-hard.md'));
		const channel = new ParadisFileModesChannel<string>(new ParadisFileModesService());
		const stat = (path: string) => channel.call<IParadisFileStatInfo | undefined>('', 'statFile', { resource: URI.file(join(root, path)) });
		const [file, link, missing] = await Promise.all([stat('readme.md'), stat('link'), stat('missing')]);
		assert.deepStrictEqual({
			file: file && { mode: file.mode.toString(8), ownedByMe: file.ownedByMe, linkCount: file.linkCount, isSymbolicLink: file.isSymbolicLink },
			link: link && { isSymbolicLink: link.isSymbolicLink },
			missing,
		}, {
			file: { mode: '644', ownedByMe: true, linkCount: 2, isSymbolicLink: false },
			link: { isSymbolicLink: true },
			missing: undefined,
		});
	});

	test('rename replaces a file with a plain fs.rename, refuses a folder, and identity tells hard links apart from copies', async () => {
		const service = new ParadisFileModesService();
		await fsp.writeFile(join(root, 'temp'), 'new');
		await fsp.writeFile(join(root, 'temp2'), 'x');
		await service.rename({ from: URI.file(join(root, 'temp')), to: URI.file(join(root, 'readme.md')) });
		const ontoFolder = await service.rename({ from: URI.file(join(root, 'temp2')), to: URI.file(join(root, 'dir')) }).then(() => 'ok', (error: NodeJS.ErrnoException) => error.code);
		await fsp.link(join(root, 'readme.md'), join(root, 'readme-hard.md'));
		await fsp.copyFile(join(root, 'readme.md'), join(root, 'readme-copy.md'));
		const identity = async (path: string) => (await service.statFile({ resource: URI.file(join(root, path)) }))?.identity;
		assert.deepStrictEqual({
			content: await fsp.readFile(join(root, 'readme.md'), 'utf8'),
			ontoFolder,
			dirKept: (await fsp.lstat(join(root, 'dir'))).isDirectory(),
			hardLinkSame: await identity('readme.md') === await identity('readme-hard.md'),
			copySame: await identity('readme.md') === await identity('readme-copy.md'),
		}, { content: 'new', ontoFolder: 'EISDIR', dirKept: true, hardLinkSame: true, copySame: false });
	});

	test('lists a FIFO as a special entry', async () => {
		execFileSync('mkfifo', [join(root, 'pipe')]);
		const listing = await new ParadisFileModesService().list({ resource: URI.file(root) });
		assert.deepStrictEqual(listing.entries.filter(entry => entry.name === 'pipe').map(entry => [entry.kind, entry.isDirectory]), [['other', false]]);
	});

	test('rejects invalid modes and non-file URIs', async () => {
		const service = new ParadisFileModesService();
		const errors = await Promise.all([
			service.chmod({ resource: URI.file(join(root, 'readme.md')), mode: 0o10000, recursive: false }).then(() => 'ok', () => 'rejected'),
			service.list({ resource: URI.from({ scheme: 'vscode-remote', authority: 'x', path: root }) }).then(() => 'ok', () => 'rejected'),
		]);
		assert.deepStrictEqual(errors, ['rejected', 'rejected']);
	});
});
