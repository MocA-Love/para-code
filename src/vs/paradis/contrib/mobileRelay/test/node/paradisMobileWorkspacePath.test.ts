/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisCreateMobileUploadTarget, paradisResolveMobileWorkspacePath } from '../../common/paradisMobileWorkspacePath.js';

suite('Mobile workspace path security', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const root = URI.file('/workspace/repository');

	function fileServiceWithRealpaths(realpaths: ReadonlyMap<string, URI>): Pick<IFileService, 'realpath'> {
		return {
			realpath: async resource => realpaths.get(resource.toString()) ?? resource,
		};
	}

	function createDiskFileService(): FileService {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new DiskFileSystemProvider(new NullLogService()))));
		return fileService;
	}

	test('rejects traversal and absolute paths before resolving the filesystem', async () => {
		let realpathCalls = 0;
		const fileService = {
			realpath: async () => { realpathCalls++; return root; },
		};

		const resolved = await Promise.all([
			'../secret.txt',
			'safe/../../secret.txt',
			'/etc/passwd',
			'C:/Users/Public/secret.txt',
			'C:\\Users\\Public\\secret.txt',
			'\\\\server\\share\\secret.txt',
		].map(candidate => paradisResolveMobileWorkspacePath(fileService, root, candidate)));

		assert.deepStrictEqual({ resolved, realpathCalls }, {
			resolved: [undefined, undefined, undefined, undefined, undefined, undefined],
			realpathCalls: 0,
		});
	});

	test('rejects a real symlink whose target escapes the workspace root', async () => {
		const fixture = await mkdtemp(join(tmpdir(), 'paradis-mobile-path-'));
		try {
			const workspacePath = join(fixture, 'workspace');
			const outsidePath = join(fixture, 'outside');
			await Promise.all([mkdir(workspacePath), mkdir(outsidePath)]);
			await writeFile(join(outsidePath, 'secret.txt'), 'outside secret');
			await symlink(join(outsidePath, 'secret.txt'), join(workspacePath, 'secret-link'));

			assert.strictEqual(await paradisResolveMobileWorkspacePath(createDiskFileService(), URI.file(workspacePath), 'secret-link'), undefined);
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	test('returns the canonical in-root target so replacing the checked alias cannot redirect the read', async () => {
		const fixture = await mkdtemp(join(tmpdir(), 'paradis-mobile-path-'));
		try {
			const workspacePath = join(fixture, 'workspace');
			const insidePath = join(workspacePath, 'inside.txt');
			const outsidePath = join(fixture, 'outside.txt');
			const aliasPath = join(workspacePath, 'document-link');
			await mkdir(workspacePath);
			await Promise.all([writeFile(insidePath, 'inside document'), writeFile(outsidePath, 'outside secret')]);
			await symlink(insidePath, aliasPath);
			const fileService = createDiskFileService();
			const resolved = await paradisResolveMobileWorkspacePath(fileService, URI.file(workspacePath), 'document-link');
			await unlink(aliasPath);
			await symlink(outsidePath, aliasPath);

			assert.deepStrictEqual({
				resolved: resolved?.fsPath,
				content: resolved ? (await fileService.readFile(resolved)).value.toString() : undefined,
			}, {
				resolved: await realpath(insidePath),
				content: 'inside document',
			});
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	for (const swap of ['file', 'ancestor'] as const) {
		test(`rejects when the checked canonical ${swap} is replaced by an outside symlink before read`, async () => {
			const fixture = await mkdtemp(join(tmpdir(), 'paradis-mobile-path-'));
			try {
				const workspacePath = join(fixture, 'workspace');
				const directoryPath = join(workspacePath, 'documents');
				const filePath = join(directoryPath, 'guide.txt');
				const outsideDirectoryPath = join(fixture, 'outside');
				const outsideFilePath = join(outsideDirectoryPath, 'guide.txt');
				await Promise.all([mkdir(directoryPath, { recursive: true }), mkdir(outsideDirectoryPath)]);
				await Promise.all([writeFile(filePath, 'inside document'), writeFile(outsideFilePath, 'outside secret')]);
				const diskFileService = createDiskFileService();
				let candidateRealpathCalls = 0;
				const racingFileService: Pick<IFileService, 'realpath'> = {
					realpath: async resource => {
						const resolved = await diskFileService.realpath(resource);
						if (resource.fsPath === filePath && ++candidateRealpathCalls === 1) {
							if (swap === 'file') {
								await unlink(filePath);
								await symlink(outsideFilePath, filePath);
							} else {
								await rm(directoryPath, { recursive: true });
								await symlink(outsideDirectoryPath, directoryPath);
							}
						}
						return resolved;
					},
				};

				assert.strictEqual(await paradisResolveMobileWorkspacePath(racingFileService, URI.file(workspacePath), 'documents/guide.txt'), undefined);
			} finally {
				await rm(fixture, { recursive: true, force: true });
			}
		});
	}

	test('uses case-sensitive containment for a non-file workspace provider', async () => {
		const remoteRoot = URI.parse('vscode-remote://ssh-remote+host/home/repo');
		const candidate = URI.parse('vscode-remote://ssh-remote+host/home/repo/secret.txt');
		const fileService = fileServiceWithRealpaths(new Map([
			[remoteRoot.toString(), remoteRoot],
			[candidate.toString(), URI.parse('vscode-remote://ssh-remote+host/home/REPO/secret.txt')],
		]));

		assert.strictEqual(await paradisResolveMobileWorkspacePath(fileService, remoteRoot, 'secret.txt'), undefined);
	});

	test('keeps normal reads and sanitized uploads inside their dedicated roots', async () => {
		const document = URI.file('/workspace/repository/docs/guide.txt');
		const fileService = fileServiceWithRealpaths(new Map([
			[root.toString(), root],
			[document.toString(), document],
		]));
		const uploadHome = URI.file('/user/data');

		assert.deepStrictEqual({
			read: await paradisResolveMobileWorkspacePath(fileService, root, 'docs/guide.txt'),
			upload: paradisCreateMobileUploadTarget(uploadHome, '../../secret.PNG.exe', 1234, 'abc123'),
			imageUpload: paradisCreateMobileUploadTarget(uploadHome, '/etc/passwd.JpG', 1234, 'abc123'),
		}, {
			read: document,
			upload: URI.file('/user/data/paraMobileUploads/attachment-1234-abc123.exe'),
			imageUpload: URI.file('/user/data/paraMobileUploads/attachment-1234-abc123.JpG'),
		});
	});
});
