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
import { IJSONValue } from '../../../../../workbench/services/configuration/common/jsonEditing.js';
import { IParadisWorkspaceFileSnapshot, ParadisWorkspaceFileWriteCache, paradisTakeWrittenWorkspaceContent, paradisWhenWorkspaceFileFlushed } from '../../common/paradisWorkspaceFileWriteCache.js';
import { paradisSetManagedWorkspaceWindowForTest } from '../../common/paradisWorkspaceSwitch.js';

/** 呼び出しを数える（往復の数の代わり）。atomic に書けるかを切り替えられる。 */
class CountingProvider extends InMemoryFileSystemProvider {
	readonly calls: string[] = [];
	atomic = true;
	/** これが解けるまで stat を返さない（接続先が詰まっている回）。 */
	statGate: Promise<void> | undefined;
	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | (this.atomic ? FileSystemProviderCapabilities.FileAtomicWrite : 0);
	}
	override async stat(resource: URI): Promise<IStat> {
		this.calls.push('stat');
		await this.statGate;
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
	return Object.fromEntries(Object.entries(summary).filter(([key]) => /_(write_behind|flush_waited|reload_cached)$/.test(key)));
}

const FOLDERS_B = [{ path: ['folders'], value: [{ path: '/repo/b' }] }];
const FOLDERS_C = [{ path: ['folders'], value: [{ path: '/repo/c' }] }];

suite('ParadisWorkspaceFileWriteCache', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let provider: CountingProvider;
	let fileService: FileService;
	let openModels: Set<string>;
	let writeHook: ((resource: URI, value: string, options: IWriteFileOptions) => Promise<IFileStatWithMetadata>) | undefined;
	let writeOptions: unknown[];
	/** upstream の経路（テキストモデルで書く）に回した回の folders。 */
	let modelWrites: unknown[];
	let modelWriteFails: boolean;
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
		// upstream の経路の代わり: ディスクを読み、folders だけを当てて保存し、書いた中身を覚え直す。
		const writeThroughModel = async (resource: URI, values: IJSONValue[]) => {
			modelWrites.push(values[0].value);
			if (modelWriteFails) {
				return; // upstream は保存の失敗を投げずにモデルへ残す（覚え直さない）
			}
			const disk = JSON.parse((await fileService.readFile(resource)).value.toString()) as Record<string, unknown>;
			const content = JSON.stringify({ ...disk, folders: values[0].value }, null, '\t');
			const stat = await fileService.writeFile(resource, VSBuffer.fromString(content));
			created.remember(resource, stat, { content, etag: stat.etag, mtime: stat.mtime, encoding: undefined, formatting: FORMATTING });
		};
		const created: ParadisWorkspaceFileWriteCache = new ParadisWorkspaceFileWriteCache(fileService, textFileService, writeThroughModel, undefined, applies === 'default' ? undefined : applies);
		disposables.add(created);
		return created;
	}

	/** upstream の経路で書いた後と同じ状態にする（ディスクの中身と stat を覚えさせる）。 */
	async function seed(resource: URI, content: string, target = cache): Promise<void> {
		const stat = await fileService.writeFile(resource, VSBuffer.fromString(content));
		const snapshot: IParadisWorkspaceFileSnapshot = { content, etag: stat.etag, mtime: stat.mtime, encoding: undefined, formatting: FORMATTING };
		target.remember(resource, stat, snapshot);
		// 自分の書き込みの通知を流し切る（InMemory の通知は少し遅れて届く）。上の remember の読み直しの
		// 申し出も、この通知で取り下がる。
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
		modelWrites = [];
		modelWriteFails = false;
		cache = createCache();
	});

	test('changes the content without waiting for the disk, hands it to every reload until the background write lands, and writes only the last of two quick switches', async () => {
		const resource = URI.file('/example/space.code-workspace');
		await seed(resource, workspaceContent('/repo/a'));
		// 接続先が詰まっていて、ファイルの IPC が返らない回。
		let releaseStat!: () => void;
		provider.statGate = new Promise<void>(resolve => releaseStat = resolve);

		const trace = paradisBeginFolderUpdateTrace();
		const written = await cache.tryWrite(resource, FOLDERS_B);
		const reloaded = paradisTakeWrittenWorkspaceContent(resource);
		const summary = trace.summarize(undefined);
		trace.end();
		// 書き込みが止まっている間の次の切り替えと、その間に届いた通知の後の読み直し。
		const writtenAgain = await cache.tryWrite(resource, FOLDERS_C);
		await timeout(20);
		const reloadedWhileWriting = paradisTakeWrittenWorkspaceContent(resource);
		const flushing = paradisWhenWorkspaceFileFlushed();
		provider.statGate = undefined;
		releaseStat();
		const flushed = await flushing;
		await timeout(20);

		assert.deepStrictEqual({
			written,
			writtenAgain,
			reloaded: reloaded === undefined ? undefined : foldersOf(reloaded),
			reloadedWhileWriting: reloadedWhileWriting === undefined ? undefined : foldersOf(reloadedWhileWriting),
			flushed: { ...flushed, ms: undefined },
			afterFlush: paradisWhenWorkspaceFileFlushed(),
			// 書き終わって通知が来た後は、読み直しはディスクを読む。
			reloadedAfterFlush: paradisTakeWrittenWorkspaceContent(resource),
			// B を書く前に C が来たので、書いたのは C の 1 回だけ。
			atomic: writeOptions,
			folders: foldersOf(await readDisk(resource)),
			// folders 以外はそのまま残す。
			settings: (JSON.parse(await readDisk(resource)) as { settings: unknown }).settings,
			shortcuts: shortcutsOf(summary),
		}, {
			written: true,
			writtenAgain: true,
			reloaded: ['/repo/b'],
			reloadedWhileWriting: ['/repo/c'],
			flushed: { ok: true, ms: undefined, writes: 2, fallback: false },
			afterFlush: undefined,
			reloadedAfterFlush: undefined,
			atomic: [{ postfix: '.vsctmp' }],
			folders: ['/repo/c'],
			settings: { 'editor.tabSize': 2 },
			shortcuts: { safe_update_folders_write_behind: 1, safe_update_folders_flush_waited: 0, safe_update_folders_reload_cached: 1 },
		});
	});

	test('keeps an external change by writing through the upstream path when the file changed on disk, was deleted, or the write conflicts', async () => {
		const resource = URI.file('/example/space.code-workspace');

		// 外部での変更（folders 以外も変わっている）。
		await seed(resource, workspaceContent('/repo/a'));
		await timeout(5);
		await fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify({ folders: [{ path: '/repo/x' }], settings: { 'editor.tabSize': 8 } }, null, '\t')));
		const sameSize = await cache.tryWrite(resource, FOLDERS_B);
		const sameSizeFlush = await paradisWhenWorkspaceFileFlushed();
		const afterSameSize = JSON.parse(await readDisk(resource));

		// 書き込みそのものの衝突。
		await seed(resource, workspaceContent('/repo/a'));
		writeHook = async () => { throw new FileOperationError('modified since', FileOperationResult.FILE_MODIFIED_SINCE); };
		const conflicted = await cache.tryWrite(resource, FOLDERS_C);
		const conflictFlush = await paradisWhenWorkspaceFileFlushed();
		writeHook = undefined;

		assert.deepStrictEqual({
			sameSize,
			sameSizeFlush: { ...sameSizeFlush, ms: undefined },
			afterSameSize,
			conflicted,
			conflictFlush: { ...conflictFlush, ms: undefined },
			disk: foldersOf(await readDisk(resource)),
			modelWrites,
		}, {
			sameSize: true,
			sameSizeFlush: { ok: true, ms: undefined, writes: 1, fallback: true },
			// 外部で変えた settings を残し、folders だけをメモリの中身に揃える。
			afterSameSize: { folders: [{ path: '/repo/b' }], settings: { 'editor.tabSize': 8 } },
			conflicted: true,
			conflictFlush: { ok: true, ms: undefined, writes: 1, fallback: true },
			disk: ['/repo/c'],
			modelWrites: [[{ path: '/repo/b' }], [{ path: '/repo/c' }]],
		});
	});

	test('keeps handing the switched content to reloads and reports the failure when the background write fails, until a later write lands', async () => {
		const resource = URI.file('/example/space.code-workspace');
		await seed(resource, workspaceContent('/repo/a'));
		writeHook = async () => { throw new FileOperationError('no space', FileOperationResult.FILE_OTHER_ERROR); };
		modelWriteFails = true;

		const written = await cache.tryWrite(resource, FOLDERS_B);
		const failed = await paradisWhenWorkspaceFileFlushed();
		await timeout(20);
		const reloadedAfterFailure = paradisTakeWrittenWorkspaceContent(resource);
		const stillFailed = await paradisWhenWorkspaceFileFlushed();
		// 覚えた中身は捨ててあるので、次は upstream の経路（呼び出し元）へ回す。
		const next = await cache.tryWrite(resource, FOLDERS_C);
		// upstream の経路で書けたら（`rememberModel`）、失敗は消える。
		writeHook = undefined;
		await seed(resource, workspaceContent('/repo/c'));

		assert.deepStrictEqual({
			written,
			failed: { ...failed, ms: undefined },
			reloadedAfterFailure: reloadedAfterFailure === undefined ? undefined : foldersOf(reloadedAfterFailure),
			stillFailed: stillFailed === failed,
			next,
			afterLaterWrite: paradisWhenWorkspaceFileFlushed(),
			reloadedAfterLaterWrite: paradisTakeWrittenWorkspaceContent(resource),
		}, {
			written: true,
			failed: { ok: false, ms: undefined, writes: 1, fallback: true },
			reloadedAfterFailure: ['/repo/b'],
			stillFailed: true,
			next: false,
			afterLaterWrite: undefined,
			reloadedAfterLaterWrite: undefined,
		});
	});

	test('waits for the background write of the same file before leaving a write to the upstream path, without holding up other files', async () => {
		const resource = URI.file('/example/space.code-workspace');
		await seed(resource, workspaceContent('/repo/a'));
		// 後ろの書き込みが、外部での変更を確かめる stat で止まっている間。
		let releaseStat!: () => void;
		provider.statGate = new Promise<void>(resolve => releaseStat = resolve);
		const order: string[] = [];

		assert.strictEqual(await cache.tryWrite(resource, FOLDERS_B), true);
		// ほかのファイルは待たせない。
		const settings = URI.file('/example/.vscode/settings.json');
		assert.strictEqual(await cache.tryWrite(settings, [{ path: ['a'], value: 1 }]), false);
		order.push('other file');
		// エディタで開かれたら upstream の経路だが、後ろの書き込みを追い越さない。
		openModels.add(resource.toString());
		const trace = paradisBeginFolderUpdateTrace();
		const opened = cache.tryWrite(resource, FOLDERS_C).then(result => { order.push('opened'); return result; });
		await timeout(10);
		order.push('released');
		provider.statGate = undefined;
		releaseStat();
		const openedResult = await opened;
		const summary = trace.summarize(undefined);
		trace.end();
		openModels.clear();

		assert.deepStrictEqual({ order, openedResult, shortcuts: shortcutsOf(summary), modelWrites, disk: foldersOf(await readDisk(resource)) }, {
			order: ['other file', 'released', 'opened'],
			openedResult: false,
			shortcuts: { safe_update_folders_write_behind: 0, safe_update_folders_flush_waited: 1, safe_update_folders_reload_cached: 0 },
			// B を書く前にモデルが開かれたので、B は upstream の経路（モデル）で書いた。
			modelWrites: [[{ path: '/repo/b' }]],
			disk: ['/repo/b'],
		});
	});

	test('hands the content written through the upstream path to the next reload once, and not after a file change notification', async () => {
		const resource = URI.file('/example/space.code-workspace');
		const stat = await fileService.writeFile(resource, VSBuffer.fromString(workspaceContent('/repo/a')));
		cache.remember(resource, stat, { content: workspaceContent('/repo/a'), etag: stat.etag, mtime: stat.mtime, encoding: undefined, formatting: FORMATTING });
		const offered = paradisTakeWrittenWorkspaceContent(resource);
		const offeredAgain = paradisTakeWrittenWorkspaceContent(resource);
		cache.remember(resource, stat, { content: workspaceContent('/repo/a'), etag: stat.etag, mtime: stat.mtime, encoding: undefined, formatting: FORMATTING });
		await fileService.writeFile(resource, VSBuffer.fromString(workspaceContent('/repo/x')));
		await timeout(20);
		const afterNotification = paradisTakeWrittenWorkspaceContent(resource);
		assert.deepStrictEqual({ offered: offered === undefined ? undefined : foldersOf(offered), offeredAgain, afterNotification }, {
			offered: ['/repo/a'],
			offeredAgain: undefined,
			afterNotification: undefined,
		});
	});

	test('works the same for a workspace file on an SSH remote, and leaves other files, open models and non-atomic providers to upstream', async () => {
		const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+example', path: '/home/example/space.code-workspace' });
		await seed(remote, workspaceContent('/home/example/a'));
		const remoteWritten = await cache.tryWrite(remote, [{ path: ['folders'], value: [{ path: '/home/example/b' }] }]);
		await paradisWhenWorkspaceFileFlushed();
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
			// 外部での変更を確かめる stat、書き込みの中の etag の確認と書き込み後の stat。存在確認と読み込みはしない。
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
			await paradisWhenWorkspaceFileFlushed();

			assert.deepStrictEqual({ outside, otherFile, windowFile }, { outside: false, otherFile: false, windowFile: true });
		} finally {
			paradisSetManagedWorkspaceWindowForTest(previous);
		}
	});
});
