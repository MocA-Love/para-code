/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_REMOTE_FILE_COPY_TTL_MS } from '../../common/paradisRemoteFileBridge.js';
import { ParadisRemoteFileBridge } from '../../electron-browser/paradisRemoteFileBridge.js';

const AUTHORITY = 'ssh-remote+dev';
const NOW = 1_800_000_000_000;
const USER_FOLDER = '/home/example/.para-code/browser-files';

function remote(path: string): URI {
	return URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path });
}

interface IFakeFileSystem {
	readonly files: Map<string, { data: Uint8Array; mtime: number }>;
	readonly folders: Set<string>;
	/** Paths that exist but are neither files nor folders (a device, a socket). */
	readonly special: Set<string>;
	/** A path mapped to the real path it resolves to (a symbolic link, or a folder below one). */
	links: Map<string, string>;
	/** Called before each write, to swap a folder for a link between the check and the write. */
	beforeWrite?: () => void;
}

function createFileService(fs: IFakeFileSystem) {
	const realpathOf = (path: string): string => {
		for (const [link, target] of fs.links) {
			if (path === link || path.startsWith(`${link}/`)) {
				return target + path.slice(link.length);
			}
		}
		return path;
	};
	const notFound = (resource: URI) => new FileOperationError(`not found: ${resource.path}`, FileOperationResult.FILE_NOT_FOUND);
	const stat = async (resource: URI) => {
		const path = realpathOf(resource.path);
		if (fs.folders.has(path)) {
			return { isDirectory: true, isFile: false, size: 0 };
		}
		if (fs.special.has(path)) {
			return { isDirectory: false, isFile: false, size: 0 };
		}
		const file = fs.files.get(path);
		if (file !== undefined) {
			return { isDirectory: false, isFile: true, size: file.data.byteLength };
		}
		throw notFound(resource);
	};
	return {
		stat,
		realpath: async (resource: URI) => resource.with({ path: realpathOf(resource.path) }),
		readFile: async (resource: URI) => {
			const file = fs.files.get(realpathOf(resource.path));
			if (file === undefined) {
				throw notFound(resource);
			}
			return { value: VSBuffer.wrap(file.data) };
		},
		writeFile: async (resource: URI, data: VSBuffer) => {
			fs.beforeWrite?.();
			fs.files.set(realpathOf(resource.path), { data: data.buffer, mtime: NOW });
		},
		createFolder: async (resource: URI) => {
			let path = realpathOf(resource.path);
			while (path.length > 1) {
				fs.folders.add(path);
				path = path.slice(0, path.lastIndexOf('/')) || '/';
			}
		},
		resolve: async (resource: URI) => ({
			children: [...fs.files].filter(([path]) => path.startsWith(`${resource.path}/`)).map(([path, file]) => ({ resource: resource.with({ path }), isFile: true, mtime: file.mtime })),
		}),
		del: async (resource: URI) => { fs.files.delete(realpathOf(resource.path)); },
	} as unknown as IFileService;
}

suite('ParadisRemoteFileBridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createBridge(options: { links?: Map<string, string>; paneUnresolved?: boolean; maxBytes?: number } = {}) {
		const fs: IFakeFileSystem = {
			files: new Map([
				['/home/example/repo/data.csv', { data: new TextEncoder().encode('a,b'), mtime: NOW }],
				['/home/example/secret.txt', { data: new TextEncoder().encode('secret'), mtime: NOW }],
				['/tmp/upload.csv', { data: new TextEncoder().encode('x'), mtime: NOW }],
			]),
			folders: new Set(['/', '/home', '/home/example', '/home/example/repo', '/home/example/repo/out', '/home/example/repo/.git', '/tmp']),
			special: new Set(['/home/example/repo/fifo']),
			links: options.links ?? new Map(),
		};
		const bridge = new ParadisRemoteFileBridge(createFileService(fs), {
			paneFolders: () => options.paneUnresolved ? undefined : [remote('/home/example/repo'), URI.file('/Users/example/local')],
			remoteFolders: async authority => authority === AUTHORITY ? { userHome: remote('/home/example'), tmpDir: remote('/tmp') } : undefined,
		}, new NullLogService(), options.maxBytes, () => NOW);
		return { bridge, fs };
	}

	const data = VSBuffer.fromString('png');

	test('writes inside the pane space folder and the user folder only, never into /tmp or a version control folder', async () => {
		const { bridge, fs } = createBridge();
		const results = {
			space: await bridge.write('pane', AUTHORITY, '/home/example/repo/out/shot.png', data),
			missingFolder: await bridge.write('pane', AUTHORITY, '/home/example/repo/out/new/shot.png', data),
			userFolder: await bridge.write('pane', AUTHORITY, `${USER_FOLDER}/shot.png`, data),
			sharedTemporary: await bridge.write('pane', AUTHORITY, '/tmp/shot.png', data),
			outside: await bridge.write('pane', AUTHORITY, '/home/example/shot.png', data),
			git: await bridge.write('pane', AUTHORITY, '/home/example/repo/.git/hooks/pre-commit', data),
			otherAuthority: await bridge.write('pane', 'ssh-remote+other', '/home/example/repo/shot.png', data),
			relative: await bridge.write('pane', AUTHORITY, 'shot.png', data),
			backslash: await bridge.write('pane', AUTHORITY, '/home/example/repo/a\\b.png', data),
			traversal: await bridge.write('pane', AUTHORITY, '/home/example/repo/../secret.txt', data),
			folder: await bridge.write('pane', AUTHORITY, '/home/example/repo/out', data),
			special: await bridge.write('pane', AUTHORITY, '/home/example/repo/fifo', data),
		};
		assert.deepStrictEqual({ results, written: [...fs.files.keys()].filter(path => path.endsWith('shot.png')).sort() }, {
			results: {
				space: { ok: true, path: '/home/example/repo/out/shot.png' },
				missingFolder: { ok: false, reason: 'parentMissing' },
				userFolder: { ok: true, path: `${USER_FOLDER}/shot.png`, userFolder: USER_FOLDER },
				sharedTemporary: { ok: false, reason: 'outsideAllowedFolders' },
				outside: { ok: false, reason: 'outsideAllowedFolders' },
				git: { ok: false, reason: 'versionControlFolder' },
				otherAuthority: { ok: false, reason: 'outsideAllowedFolders' },
				relative: { ok: false, reason: 'invalidPath' },
				backslash: { ok: false, reason: 'invalidPath' },
				traversal: { ok: false, reason: 'invalidPath' },
				folder: { ok: false, reason: 'isDirectory' },
				special: { ok: false, reason: 'notAFile' },
			},
			written: [`${USER_FOLDER}/shot.png`, '/home/example/repo/out/shot.png'],
		});
	});

	test('creates the user folder only for copies and for writes into it', async () => {
		const { bridge, fs } = createBridge();
		await bridge.write('pane', AUTHORITY, '/home/example/repo/out/shot.png', data);
		await bridge.checkWrite('pane', AUTHORITY, '/home/example/repo/out/other.png');
		const afterSpaceWrites = fs.folders.has(USER_FOLDER);
		const copied = await bridge.writeTemporary('pane', AUTHORITY, 'a.pdf', data);
		assert.deepStrictEqual({ afterSpaceWrites, afterCopy: fs.folders.has(USER_FOLDER), copied: copied.ok }, { afterSpaceWrites: false, afterCopy: true, copied: true });
	});

	test('does not reach a version control folder through a symbolic link, before or after writing, and does not read from one', async () => {
		const { bridge, fs } = createBridge({ links: new Map([['/home/example/repo/hooks', '/home/example/repo/.git/hooks'], ['/home/example/repo/config-link', '/home/example/repo/.git/config']]) });
		fs.folders.add('/home/example/repo/.git/hooks');
		fs.files.set('/home/example/repo/.git/config', { data: new TextEncoder().encode('[core]'), mtime: NOW });
		const swapped = createBridge();
		swapped.fs.beforeWrite = () => swapped.fs.links.set('/home/example/repo/out', '/home/example/repo/.git');
		const racedWrite = await swapped.bridge.write('pane', AUTHORITY, '/home/example/repo/out/HEAD', data);
		assert.deepStrictEqual({
			throughFolderLink: await bridge.write('pane', AUTHORITY, '/home/example/repo/hooks/pre-commit', data),
			throughFileLink: await bridge.write('pane', AUTHORITY, '/home/example/repo/config-link', data),
			readThroughLink: await bridge.read('pane', AUTHORITY, '/home/example/repo/config-link', 1024),
			readDirect: await bridge.read('pane', AUTHORITY, '/home/example/repo/.git/config', 1024),
			racedWrite,
			racedFileLeft: swapped.fs.files.has('/home/example/repo/.git/HEAD'),
		}, {
			throughFolderLink: { ok: false, reason: 'versionControlFolder' },
			throughFileLink: { ok: false, reason: 'versionControlFolder' },
			readThroughLink: { ok: false, reason: 'versionControlFolder' },
			readDirect: { ok: false, reason: 'versionControlFolder' },
			racedWrite: { ok: false, reason: 'versionControlFolder' },
			racedFileLeft: true,
		});
	});

	test('removes nothing when a new file name ends up on an existing file outside after the folder is swapped for a link', async () => {
		const swapped = createBridge();
		swapped.fs.files.set('/home/example/notes.txt', { data: new TextEncoder().encode('outside'), mtime: NOW });
		// The check sees /home/example/repo/out/notes.txt as a new file in an allowed folder.
		swapped.fs.beforeWrite = () => swapped.fs.links.set('/home/example/repo/out', '/home/example');
		const result = await swapped.bridge.write('pane', AUTHORITY, '/home/example/repo/out/notes.txt', data);
		assert.deepStrictEqual({ result, outsideStillThere: swapped.fs.files.has('/home/example/notes.txt') }, {
			result: { ok: false, reason: 'outsideAllowedFolders' },
			outsideStillThere: true,
		});
	});

	test('leaves a file that already existed when a write turns out to have landed outside', async () => {
		const swapped = createBridge();
		swapped.fs.files.set('/home/example/repo/out/existing.png', { data: new TextEncoder().encode('old'), mtime: NOW });
		swapped.fs.files.set('/home/example/existing.png', { data: new TextEncoder().encode('outside'), mtime: NOW });
		swapped.fs.beforeWrite = () => swapped.fs.links.set('/home/example/repo/out', '/home/example');
		const result = await swapped.bridge.write('pane', AUTHORITY, '/home/example/repo/out/existing.png', data);
		assert.deepStrictEqual({ result, outsideStillThere: swapped.fs.files.has('/home/example/existing.png') }, {
			result: { ok: false, reason: 'outsideAllowedFolders' },
			outsideStillThere: true,
		});
	});

	test('does not follow a symbolic link out of the allowed folders, before or after writing', async () => {
		const { bridge } = createBridge({ links: new Map([['/home/example/repo/escape', '/home/example'], ['/home/example/repo/data-link.csv', '/home/example/secret.txt']]) });
		const swapped = createBridge();
		// The folder is swapped for a link to outside right after the check passed.
		swapped.fs.beforeWrite = () => swapped.fs.links.set('/home/example/repo/out', '/home/example');
		const racedWrite = await swapped.bridge.write('pane', AUTHORITY, '/home/example/repo/out/raced.png', data);
		assert.deepStrictEqual({
			write: await bridge.write('pane', AUTHORITY, '/home/example/repo/escape/shot.png', data),
			read: await bridge.read('pane', AUTHORITY, '/home/example/repo/data-link.csv', 1024),
			racedWrite,
			racedFileLeft: swapped.fs.files.has('/home/example/raced.png'),
		}, {
			write: { ok: false, reason: 'outsideAllowedFolders' },
			read: { ok: false, reason: 'outsideAllowedFolders' },
			racedWrite: { ok: false, reason: 'outsideAllowedFolders' },
			racedFileLeft: true,
		});
	});

	test('reads regular files inside the allowed folders or /tmp, up to the size limit', async () => {
		const { bridge } = createBridge({ maxBytes: 2 });
		const small = createBridge();
		const read = await small.bridge.read('pane', AUTHORITY, '/home/example/repo/data.csv', 1024);
		const fromTemporary = await small.bridge.read('pane', AUTHORITY, '/tmp/upload.csv', 1024);
		assert.deepStrictEqual({
			read: read.ok ? { name: read.name, text: read.data.toString() } : read,
			fromTemporary: fromTemporary.ok,
			tooLarge: await bridge.read('pane', AUTHORITY, '/home/example/repo/data.csv', 1024),
			missing: await small.bridge.read('pane', AUTHORITY, '/home/example/repo/missing.csv', 1024),
			outside: await small.bridge.read('pane', AUTHORITY, '/home/example/secret.txt', 1024),
			folder: await small.bridge.read('pane', AUTHORITY, '/home/example/repo/out', 1024),
			special: await small.bridge.read('pane', AUTHORITY, '/home/example/repo/fifo', 1024),
		}, {
			read: { name: 'data.csv', text: 'a,b' },
			fromTemporary: true,
			tooLarge: { ok: false, reason: 'tooLarge' },
			missing: { ok: false, reason: 'notFound' },
			outside: { ok: false, reason: 'outsideAllowedFolders' },
			folder: { ok: false, reason: 'isDirectory' },
			special: { ok: false, reason: 'notAFile' },
		});
	});

	test('copies downloads into the user folder, removes old copies, and needs a known pane', async () => {
		const unresolved = createBridge({ paneUnresolved: true });
		const { bridge, fs } = createBridge();
		fs.files.set(`${USER_FOLDER}/old-report.pdf`, { data: new Uint8Array(1), mtime: NOW - PARADIS_REMOTE_FILE_COPY_TTL_MS - 1 });
		fs.files.set(`${USER_FOLDER}/recent-report.pdf`, { data: new Uint8Array(1), mtime: NOW - 1000 });
		const copied = await bridge.writeTemporary('pane', AUTHORITY, 'Example Page.pdf', data);
		assert.deepStrictEqual({
			unresolved: await unresolved.bridge.writeTemporary('pane', AUTHORITY, 'a.pdf', data),
			copied: copied.ok && /^\/home\/example\/\.para-code\/browser-files\/[0-9a-f]{8}-Example Page\.pdf$/.test(copied.path) && fs.files.has(copied.path),
			oldRemoved: !fs.files.has(`${USER_FOLDER}/old-report.pdf`),
			recentKept: fs.files.has(`${USER_FOLDER}/recent-report.pdf`),
			badName: await bridge.writeTemporary('pane', AUTHORITY, '../escape.pdf', data),
			noHome: await bridge.writeTemporary('pane', 'ssh-remote+other', 'a.pdf', data),
		}, {
			unresolved: { ok: false, reason: 'paneUnresolved' },
			copied: true,
			oldRemoved: true,
			recentKept: true,
			badName: { ok: false, reason: 'invalidPath' },
			noHome: { ok: false, reason: 'noTemporaryFolder' },
		});
	});
});
