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
import { IStat } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { hasWorkspaceFileExtension } from '../../../../../platform/workspace/common/workspace.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { paradisBeginFolderUpdateTrace } from '../../common/paradisFolderUpdateTrace.js';
import { IParadisWorkspaceFileSnapshot, ParadisWorkspaceFileWriteCache, paradisTakeWrittenWorkspaceContent } from '../../common/paradisWorkspaceFileWriteCache.js';

/** 呼び出しを数える（往復の数の代わり）。 */
class CountingProvider extends InMemoryFileSystemProvider {
	readonly calls: string[] = [];
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
	return Object.fromEntries(Object.entries(summary).filter(([key]) => /_(cached|verified|conflict)$/.test(key)));
}

suite('ParadisWorkspaceFileWriteCache', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let provider: CountingProvider;
	let fileService: FileService;
	let openModels: Set<string>;
	let cache: ParadisWorkspaceFileWriteCache;

	function createCache(applies: (resource: URI) => boolean = resource => hasWorkspaceFileExtension(resource)): ParadisWorkspaceFileWriteCache {
		const textFileService = {
			files: { get: (resource: URI) => openModels.has(resource.toString()) ? {} : undefined },
			write: (resource: URI, value: string, options: { etag?: string; mtime?: number }) => fileService.writeFile(resource, VSBuffer.fromString(value), options),
		} as unknown as ITextFileService;
		const created = new ParadisWorkspaceFileWriteCache(fileService, textFileService, undefined, applies);
		disposables.add(created);
		return created;
	}

	/** upstream の経路で書いた後と同じ状態にする（ディスクの中身と stat を覚えさせる）。 */
	async function seed(resource: URI, content: string): Promise<void> {
		const stat = await fileService.writeFile(resource, VSBuffer.fromString(content));
		const snapshot: IParadisWorkspaceFileSnapshot = { content, etag: stat.etag, mtime: stat.mtime, encoding: undefined, formatting: FORMATTING };
		cache.remember(resource, stat, snapshot);
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
		cache = createCache();
	});

	test('writes from the remembered content without checking or reading the file, and hands the written content to the next reload once', async () => {
		const resource = URI.file('/example/space.code-workspace');
		await seed(resource, workspaceContent('/repo/a'));

		const trace = paradisBeginFolderUpdateTrace();
		const written = await cache.tryWrite(resource, [{ path: ['folders'], value: [{ path: '/repo/b' }] }]);
		const calls = [...provider.calls];
		const reloaded = paradisTakeWrittenWorkspaceContent(resource);
		const reloadedAgain = paradisTakeWrittenWorkspaceContent(resource);
		const summary = trace.summarize(undefined);
		trace.end();
		const disk = await readDisk(resource);

		assert.deepStrictEqual({
			written,
			// 書き込みの中の etag の確認と書き込み後の stat だけ。存在確認と読み込みはしない。
			calls,
			folders: foldersOf(disk),
			// folders 以外はそのまま残す。
			settings: (JSON.parse(disk) as { settings: unknown }).settings,
			reloadedIsDisk: reloaded === disk,
			reloadedAgain,
			shortcuts: shortcutsOf(summary),
		}, {
			written: true,
			calls: ['stat', 'stat'],
			folders: ['/repo/b'],
			settings: { 'editor.tabSize': 2 },
			reloadedIsDisk: true,
			reloadedAgain: undefined,
			shortcuts: { safe_update_folders_resolve_cached: 1, safe_update_folders_resolve_verified: 0, safe_update_folders_resolve_conflict: 0, safe_update_folders_reload_cached: 1 },
		});
	});

	test('keeps the remembered content after the notification of its own write, and drops it after an external change', async () => {
		const resource = URI.file('/example/space.code-workspace');
		await seed(resource, workspaceContent('/repo/a'));

		// 自分の書き込みの通知: etag が同じなので残す。
		assert.strictEqual(await cache.tryWrite(resource, [{ path: ['folders'], value: [{ path: '/repo/b' }] }]), true);
		await timeout(20);
		const afterOwnWrite = await cache.tryWrite(resource, [{ path: ['folders'], value: [{ path: '/repo/c' }] }]);

		// 外部での変更（別のエディタ・git の切り替え）: 通知の後の stat で etag が違うので捨てる。
		await timeout(5);
		await fileService.writeFile(resource, VSBuffer.fromString(workspaceContent('/repo/external')));
		await timeout(20);
		const afterExternal = await cache.tryWrite(resource, [{ path: ['folders'], value: [{ path: '/repo/d' }] }]);

		assert.deepStrictEqual({ afterOwnWrite, afterExternal, disk: foldersOf(await readDisk(resource)), reload: paradisTakeWrittenWorkspaceContent(resource) }, {
			afterOwnWrite: true,
			// upstream の経路（読み直して書く）に任せる。ディスクは外部の中身のまま。
			afterExternal: false,
			disk: ['/repo/external'],
			reload: undefined,
		});
	});

	test('falls back to the upstream path on an etag conflict the watcher did not report, without overwriting the file', async () => {
		const resource = URI.file('/example/space.code-workspace');
		await fileService.writeFile(resource, VSBuffer.fromString(workspaceContent('/repo/external')));
		// 通知を取りこぼした状態: 覚えている etag と mtime が古い。
		cache.remember(resource, { etag: 'stale', mtime: 1 }, { content: workspaceContent('/repo/a'), etag: 'stale', mtime: 1, encoding: undefined, formatting: FORMATTING });

		const trace = paradisBeginFolderUpdateTrace();
		const written = await cache.tryWrite(resource, [{ path: ['folders'], value: [{ path: '/repo/b' }] }]);
		const summary = trace.summarize(undefined);
		trace.end();
		const writtenAgain = await cache.tryWrite(resource, [{ path: ['folders'], value: [{ path: '/repo/b' }] }]);

		assert.deepStrictEqual({ written, writtenAgain, disk: foldersOf(await readDisk(resource)), conflict: summary.safe_update_folders_resolve_conflict }, {
			written: false,
			// 捨ててあるので、次も upstream の経路。
			writtenAgain: false,
			disk: ['/repo/external'],
			conflict: 1,
		});
	});

	test('works the same for a workspace file on an SSH remote, and leaves other files and open models to upstream', async () => {
		const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+example', path: '/home/example/space.code-workspace' });
		await seed(remote, workspaceContent('/home/example/a'));
		const remoteWritten = await cache.tryWrite(remote, [{ path: ['folders'], value: [{ path: '/home/example/b' }] }]);
		const remoteCalls = [...provider.calls];
		assert.ok(paradisTakeWrittenWorkspaceContent(remote) !== undefined);

		// 手元に同じパスの別のファイルがあっても、覚えたもの（接続先）とは別扱い。
		const local = URI.file('/home/example/space.code-workspace');
		const localWritten = await cache.tryWrite(local, [{ path: ['folders'], value: [{ path: '/x' }] }]);

		// 設定ファイルは対象外。
		const settings = URI.file('/example/.vscode/settings.json');
		await fileService.writeFile(settings, VSBuffer.fromString('{}'));
		cache.remember(settings, { etag: 'e', mtime: 1 }, { content: '{}', etag: 'e', mtime: 1, encoding: undefined, formatting: FORMATTING });
		const settingsWritten = await cache.tryWrite(settings, [{ path: ['a'], value: 1 }]);

		// エディタで開いているモデルがあれば使わない（未保存の編集を素通りして書かない）。
		await timeout(20);
		openModels.add(remote.toString());
		const openWritten = await cache.tryWrite(remote, [{ path: ['folders'], value: [{ path: '/home/example/c' }] }]);

		assert.deepStrictEqual({ remoteWritten, remoteCalls, localWritten, settingsWritten, openWritten, disk: foldersOf(await readDisk(remote)) }, {
			remoteWritten: true,
			remoteCalls: ['stat', 'stat'],
			localWritten: false,
			settingsWritten: false,
			openWritten: false,
			disk: ['/home/example/b'],
		});
	});

	test('does nothing outside a Para Code window', async () => {
		const outside = createCache(() => false);
		const resource = URI.file('/example/space.code-workspace');
		const stat = await fileService.writeFile(resource, VSBuffer.fromString(workspaceContent('/repo/a')));
		outside.remember(resource, stat, { content: workspaceContent('/repo/a'), etag: stat.etag, mtime: stat.mtime, encoding: undefined, formatting: FORMATTING });
		assert.strictEqual(await outside.tryWrite(resource, [{ path: ['folders'], value: [{ path: '/repo/b' }] }]), false);
	});
});
