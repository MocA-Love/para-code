/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { timeout } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult, FileSystemProviderCapabilities, IFileStatWithMetadata, IStat, IWriteFileOptions } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { hasWorkspaceFileExtension } from '../../../../../platform/workspace/common/workspace.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { paradisBeginFolderUpdateTrace } from '../../common/paradisFolderUpdateTrace.js';
import { IParadisWorkspaceFileSnapshot, ParadisWorkspaceFileWriteCache, paradisTakeWrittenWorkspaceContent } from '../../common/paradisWorkspaceFileWriteCache.js';
import { paradisSetManagedWorkspaceWindowForTest } from '../../common/paradisWorkspaceSwitch.js';

/** 呼び出しを数える（往復の数の代わり）。atomic に書けるかを切り替えられる。 */
class CountingProvider extends InMemoryFileSystemProvider {
	readonly calls: string[] = [];
	atomic = true;
	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | (this.atomic ? FileSystemProviderCapabilities.FileAtomicWrite : 0);
	}
	override async stat(resource: URI): Promise<IStat> {
		this.calls.push('stat');
		return super.stat(resource);
	}
	override async readFile(resource: URI): Promise<Uint8Array> {
		this.calls.push('readFile');
		return super.readFile(resource);
	}
}

const FORMATTING = { tabSize: 4, insertSpaces: false, eol: '\n' };

function workspaceContent(...paths: string[]): string {
	return JSON.stringify({ folders: paths.map(path => ({ path })), settings: { 'editor.tabSize': 2 } }, null, '\t');
}

function foldersOf(content: string): string[] {
	return (JSON.parse(content) as { folders: { path: string }[] }).folders.map(folder => folder.path);
}

function shortcutsOf(summary: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(summary).filter(([key]) => /_(cached|conflict)$/.test(key)));
}

const FOLDERS_B = [{ path: ['folders'], value: [{ path: '/repo/b' }] }];

suite('ParadisWorkspaceFileWriteCache', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let provider: CountingProvider;
	let fileService: FileService;
	let openModels: Set<string>;
	let writeHook: ((resource: URI, value: string, options: IWriteFileOptions) => Promise<IFileStatWithMetadata>) | undefined;
	let writeOptions: unknown[];
	let cache: ParadisWorkspaceFileWriteCache;

	/** `'default'` は本番と同じ判定（Para Code のウィンドウのワークスペースのファイルだけ）。 */
	function createCache(applies: ((resource: URI) => boolean) | 'default' = resource => hasWorkspaceFileExtension(resource)): ParadisWorkspaceFileWriteCache {
		const textFileService = {
			files: { get: (resource: URI) => openModels.has(resource.toString()) ? {} : undefined },
			write: (resource: URI, value: string, options: IWriteFileOptions) => {
				writeOptions.push(options.atomic);
				return writeHook ? writeHook(resource, value, options) : fileService.writeFile(resource, VSBuffer.fromString(value), options);
			},
		} as unknown as ITextFileService;
		const created = new ParadisWorkspaceFileWriteCache(fileService, textFileService, undefined, applies === 'default' ? undefined : applies);
		disposables.add(created);
		return created;
	}

	/** upstream の経路で書いた後と同じ状態にする（ディスクの中身と stat を覚えさせる）。 */
	async function seed(resource: URI, content: string, target = cache): Promise<void> {
		const stat = await fileService.writeFile(resource, VSBuffer.fromString(content));
		const snapshot: IParadisWorkspaceFileSnapshot = { content, etag: stat.etag, mtime: stat.mtime, encoding: undefined, formatting: FORMATTING };
		target.remember(resource, stat, snapshot);
		// 自分の書き込みの通知を流し切る（InMemory の通知は少し遅れて届く）。
		await timeout(20);
		provider.calls.length = 0;
	}

	async function readDisk(resource: URI): Promise<string> {
		return (await fileService.readFile(resource)).value.toString();
	}

	setup(() => {
		provider = disposables.add(new CountingProvider());
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', provider));
		disposables.add(fileService.registerProvider('vscode-remote', provider));
		openModels = new Set();
		writeHook = undefined;
		writeOptions = [];
		cache = createCache();
	});

	test('writes from the remembered content after one stat instead of checking and reading the file, and hands the written content to the next reload once', async () => {
		const resource = URI.file('/example/space.code-workspace');
		await seed(resource, workspaceContent('/repo/a'));

		const trace = paradisBeginFolderUpdateTrace();
		const written = await cache.tryWrite(resource, FOLDERS_B);
		const calls = [...provider.calls];
		const reloaded = paradisTakeWrittenWorkspaceContent(resource);
		const reloadedAgain = paradisTakeWrittenWorkspaceContent(resource);
		const summary = trace.summarize(undefined);
		trace.end();
		// 自分の書き込みの通知の後も、etag が同じなので次も覚えた中身で書く。
		await timeout(20);
		const writtenAgain = await cache.tryWrite(resource, [{ path: ['folders'], value: [{ path: '/repo/c' }] }]);
		const disk = await readDisk(resource);

		assert.deepStrictEqual({
			written,
			writtenAgain,
			// 外部での変更を確かめる stat、書き込みの中の etag の確認と書き込み後の stat。存在確認と読み込みはしない。
			calls,
			atomic: writeOptions,
			folders: foldersOf(disk),
			// folders 以外はそのまま残す。
			settings: (JSON.parse(disk) as { settings: unknown }).settings,
			reloadedHasB: reloaded !== undefined && foldersOf(reloaded)[0] === '/repo/b',
			reloadedAgain,
			shortcuts: shortcutsOf(summary),
		}, {
			written: true,
			writtenAgain: true,
			calls: ['stat', 'stat', 'stat'],
			atomic: [{ postfix: '.vsctmp' }, { postfix: '.vsctmp' }],
			folders: ['/repo/c'],
			settings: { 'editor.tabSize': 2 },
			reloadedHasB: true,
			reloadedAgain: undefined,
			shortcuts: { safe_update_folders_resolve_cached: 1, safe_update_folders_resolve_conflict: 0, safe_update_folders_reload_cached: 1 },
		});
	});

	test('leaves an external change of the same size, a deletion and an unreported change to the upstream path without overwriting them', async () => {
		const resource = URI.file('/example/space.code-workspace');

		// サイズの変わらない外部での変更（書き込みの etag の確認だけでは見逃す）。
		await seed(resource, workspaceContent('/repo/a'));
		await timeout(5);
		await fileService.writeFile(resource, VSBuffer.fromString(workspaceContent('/repo/x')));
		const sameSize = await cache.tryWrite(resource, FOLDERS_B);
		const afterSameSize = foldersOf(await readDisk(resource));
		// 捨ててあるので次も upstream の経路。
		const sameSizeAgain = await cache.tryWrite(resource, FOLDERS_B);

		// 削除: upstream は '{}' から作り直す。覚えた中身（古い settings）で作り直さない。
		await seed(resource, workspaceContent('/repo/a'));
		await fileService.del(resource);
		const deleted = await cache.tryWrite(resource, FOLDERS_B);
		const deletedExists = await fileService.exists(resource);

		// 通知が来ない変更でも、覚えた etag が古ければ書かない。
		await fileService.writeFile(resource, VSBuffer.fromString(workspaceContent('/repo/external')));
		cache.remember(resource, { etag: 'stale', mtime: 1 }, { content: workspaceContent('/repo/a'), etag: 'stale', mtime: 1, encoding: undefined, formatting: FORMATTING });
		const stale = await cache.tryWrite(resource, FOLDERS_B);

		assert.deepStrictEqual({ sameSize, afterSameSize, sameSizeAgain, deleted, deletedExists, stale, disk: foldersOf(await readDisk(resource)), writes: writeOptions.length }, {
			sameSize: false,
			afterSameSize: ['/repo/x'],
			sameSizeAgain: false,
			deleted: false,
			deletedExists: false,
			stale: false,
			disk: ['/repo/external'],
			writes: 0,
		});
	});

	test('falls back to the upstream path when the write itself conflicts or fails', async () => {
		const resource = URI.file('/example/space.code-workspace');
		await seed(resource, workspaceContent('/repo/a'));
		writeHook = async () => { throw new FileOperationError('modified since', FileOperationResult.FILE_MODIFIED_SINCE); };

		const trace = paradisBeginFolderUpdateTrace();
		const written = await cache.tryWrite(resource, FOLDERS_B);
		const summary = trace.summarize(undefined);
		trace.end();
		writeHook = undefined;
		const writtenAgain = await cache.tryWrite(resource, FOLDERS_B);

		assert.deepStrictEqual({ written, writtenAgain, conflict: summary.safe_update_folders_resolve_conflict, disk: foldersOf(await readDisk(resource)) }, {
			written: false,
			writtenAgain: false,
			conflict: 1,
			disk: ['/repo/a'],
		});
	});

	test('does not hand the written content to a reload after a file change notification', async () => {
		const resource = URI.file('/example/space.code-workspace');
		await seed(resource, workspaceContent('/repo/a'));
		assert.strictEqual(await cache.tryWrite(resource, FOLDERS_B), true);
		// 自分の書き込みでも外部でも、通知の後の読み直しは upstream が自分で読む。
		await timeout(20);
		assert.strictEqual(paradisTakeWrittenWorkspaceContent(resource), undefined);
	});

	test('works the same for a workspace file on an SSH remote, and leaves other files, open models and non-atomic providers to upstream', async () => {
		const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+example', path: '/home/example/space.code-workspace' });
		await seed(remote, workspaceContent('/home/example/a'));
		const remoteWritten = await cache.tryWrite(remote, [{ path: ['folders'], value: [{ path: '/home/example/b' }] }]);
		const remoteCalls = [...provider.calls];

		// 手元に同じパスの別のファイルがあっても、覚えたもの（接続先）とは別扱い。
		const local = URI.file('/home/example/space.code-workspace');
		const localWritten = await cache.tryWrite(local, [{ path: ['folders'], value: [{ path: '/x' }] }]);

		// 設定ファイルは対象外。
		const settings = URI.file('/example/.vscode/settings.json');
		await fileService.writeFile(settings, VSBuffer.fromString('{}'));
		cache.remember(settings, { etag: 'e', mtime: 1 }, { content: '{}', etag: 'e', mtime: 1, encoding: undefined, formatting: FORMATTING });
		const settingsWritten = await cache.tryWrite(settings, [{ path: ['a'], value: 1 }]);

		// エディタで開いているモデルがあれば使わない（未保存の編集を素通りして書かない）。
		await seed(remote, workspaceContent('/home/example/b'));
		openModels.add(remote.toString());
		const openWritten = await cache.tryWrite(remote, [{ path: ['folders'], value: [{ path: '/home/example/c' }] }]);
		openModels.clear();

		// atomic に書けない provider では使わない（途中で失敗してファイルを切り詰めない）。
		await seed(remote, workspaceContent('/home/example/b'));
		provider.atomic = false;
		const nonAtomicWritten = await cache.tryWrite(remote, [{ path: ['folders'], value: [{ path: '/home/example/c' }] }]);

		assert.deepStrictEqual({ remoteWritten, remoteCalls, localWritten, settingsWritten, openWritten, nonAtomicWritten, disk: foldersOf(await readDisk(remote)) }, {
			remoteWritten: true,
			remoteCalls: ['stat', 'stat', 'stat'],
			localWritten: false,
			settingsWritten: false,
			openWritten: false,
			nonAtomicWritten: false,
			disk: ['/home/example/b'],
		});
	});

	test('remembers only the workspace file of a Para Code window', async () => {
		const resource = URI.file('/example/space.code-workspace');
		const other = URI.file('/example/saved-as.code-workspace');
		const previous = paradisSetManagedWorkspaceWindowForTest(false);
		try {
			const byDefault = createCache('default');
			// 通常のウィンドウでは何もしない。
			paradisTakeWrittenWorkspaceContent(resource);
			await seed(resource, workspaceContent('/repo/a'), byDefault);
			const outside = await byDefault.tryWrite(resource, FOLDERS_B);

			// Para Code のウィンドウでも、このウィンドウのワークスペースのファイル（読み直しが読むもの）だけ。
			paradisSetManagedWorkspaceWindowForTest(true);
			await seed(other, workspaceContent('/repo/a'), byDefault);
			const otherFile = await byDefault.tryWrite(other, FOLDERS_B);
			await seed(resource, workspaceContent('/repo/a'), byDefault);
			const windowFile = await byDefault.tryWrite(resource, FOLDERS_B);

			assert.deepStrictEqual({ outside, otherFile, windowFile }, { outside: false, otherFile: false, windowFile: true });
		} finally {
			paradisSetManagedWorkspaceWindowForTest(previous);
		}
	});
});
