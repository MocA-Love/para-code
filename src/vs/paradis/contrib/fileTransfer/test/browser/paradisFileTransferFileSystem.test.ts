/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode, IFileOpenOptions } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisReplaceTargetInfo, IParadisTransferMetadata, ParadisFileInfoResult, ParadisFileServiceTransferFileSystem } from '../../browser/paradisFileTransferFileSystem.js';
import { IParadisTransferCopyOptions, paradisClassifyTransferError, paradisIsTransferTempName } from '../../common/paradisFileTransferQueueTypes.js';

/** 2 回目の読み取りで失敗するプロバイダー（転送の途中で切れたときの代わり）。 */
class FailingReadProvider extends InMemoryFileSystemProvider {
	private reads = 0;
	override read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		if (++this.reads > 1) {
			return Promise.reject(new Error('Connection closed'));
		}
		return super.read(fd, pos, data, offset, length);
	}
}

/** rename が必ず失敗する接続先（置き換えの途中で切れた・ウイルス対策ソフトが掴んでいる、の代わり）。 */
class FailingRenameProvider extends InMemoryFileSystemProvider {
	override rename(): Promise<void> {
		return Promise.reject(createFileSystemProviderError('EBUSY', FileSystemProviderErrorCode.Unknown));
	}
}

/** 一時名のファイルを作れない接続先（ファイルには書けるがフォルダーには書けない、の代わり）。 */
class NoTempProvider extends InMemoryFileSystemProvider {
	override open(resource: URI, opts: IFileOpenOptions): Promise<number> {
		if (paradisIsTransferTempName(basename(resource))) {
			return Promise.reject(createFileSystemProviderError('EACCES', FileSystemProviderErrorCode.NoPermissions));
		}
		return super.open(resource, opts);
	}
	override writeFile(resource: URI, content: Uint8Array, opts: Parameters<InMemoryFileSystemProvider['writeFile']>[2]): Promise<void> {
		if (paradisIsTransferTempName(basename(resource))) {
			return Promise.reject(createFileSystemProviderError('EACCES', FileSystemProviderErrorCode.NoPermissions));
		}
		return super.writeFile(resource, content, opts);
	}
}

/** 権限のチャネルの代わり。送り先（vscode-remote）と送り元（file）の情報を差し替えられ、chmod と rename を記録する。 */
class FakeMetadata implements IParadisTransferMetadata {
	/** 送り先の情報。`undefined` は「古い REH で読めない」、Error は一時的な失敗。 */
	target: IParadisReplaceTargetInfo | Error | undefined;
	source: number | undefined;
	sourceIdentity: string | undefined;
	readonly chmods: Array<[string, string]> = [];
	readonly renames: string[] = [];
	/** 素の rename を使える相手か。使えるなら fileService の move で代わりに置き換える。 */
	renameWith: ((from: URI, to: URI) => Promise<void>) | undefined;
	async fileInfo(resource: URI): Promise<ParadisFileInfoResult> {
		if (resource.scheme === 'file') {
			return this.source === undefined ? { kind: 'unsupported' } : { kind: 'info', info: { mode: this.source, ownedByMe: true, linkCount: 1, identity: this.sourceIdentity } };
		}
		if (this.target instanceof Error) {
			throw this.target;
		}
		return this.target ? { kind: 'info', info: this.target } : { kind: 'unsupported' };
	}
	async chmod(resource: URI, mode: number): Promise<void> {
		this.chmods.push([paradisIsTransferTempName(basename(resource)) ? 'temp' : basename(resource), mode.toString(8)]);
	}
	async rename(from: URI, to: URI): Promise<boolean> {
		if (!this.renameWith) {
			return false;
		}
		this.renames.push(basename(to));
		await this.renameWith(from, to);
		return true;
	}
}

const REMOTE_DIR = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev', path: '/home/u/out' });

suite('Paradis file transfer - IFileService adapter', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(providers: { source?: InMemoryFileSystemProvider; target?: InMemoryFileSystemProvider } = {}) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(providers.source ?? new InMemoryFileSystemProvider())));
		store.add(fileService.registerProvider('vscode-remote', store.add(providers.target ?? new InMemoryFileSystemProvider())));
		const metadata = new FakeMetadata();
		const journal: string[] = [];
		const fileSystem = new ParadisFileServiceTransferFileSystem(fileService, {
			metadata,
			journal: { add: uri => journal.push(`+${paradisIsTransferTempName(basename(uri))}`), remove: uri => journal.push(`-${paradisIsTransferTempName(basename(uri))}`) },
		});
		return { fileService, fileSystem, metadata, journal };
	}

	function options(overwrite: boolean, onBytes: (bytes: number) => void = () => { }, token: CancellationToken = CancellationToken.None, onWriteInPlace?: () => void): IParadisTransferCopyOptions {
		return { overwrite, runId: '1-1-x-y', onBytes, token, onWriteInPlace };
	}

	async function names(fileService: FileService, folder: URI): Promise<string[]> {
		return ((await fileService.resolve(folder)).children ?? []).map(child => child.name).sort();
	}

	async function text(fileService: FileService, resource: URI): Promise<string> {
		return (await fileService.readFile(resource)).value.toString();
	}

	test('copies a new file through a temporary name with the source mode, counting written bytes', async () => {
		const { fileService, fileSystem, metadata, journal } = setup();
		const source = URI.file('/work/data.bin');
		const target = joinPath(REMOTE_DIR, 'data.bin');
		const content = VSBuffer.fromString('x'.repeat(600_000));
		await fileService.writeFile(source, content);
		await fileSystem.createDirectory(REMOTE_DIR);
		metadata.source = 0o600;

		let counted = 0;
		await fileSystem.copyFile(source, target, options(false, bytes => counted += bytes));

		assert.deepStrictEqual({
			counted,
			same: (await text(fileService, target)) === content.toString(),
			left: await names(fileService, REMOTE_DIR),
			chmods: metadata.chmods,
			journal,
			missing: await fileSystem.stat(joinPath(REMOTE_DIR, 'nope')),
			missingFolder: await fileSystem.readDirectory(joinPath(REMOTE_DIR, 'nope')),
		}, {
			counted: 600_000,
			same: true,
			left: ['data.bin'],
			chmods: [['temp', '600']],
			journal: ['+true', '-true'],
			missing: undefined,
			missingFolder: [],
		});
	});

	test('overwriting keeps the mode of the existing file (a 0600 file stays 0600)', async () => {
		const { fileService, fileSystem, metadata } = setup();
		const source = URI.file('/work/.env');
		await fileService.writeFile(source, VSBuffer.fromString('new'));
		await fileService.writeFile(joinPath(REMOTE_DIR, '.env'), VSBuffer.fromString('old'));
		metadata.target = { mode: 0o600, ownedByMe: true, linkCount: 1 };
		metadata.source = 0o644;

		await fileSystem.copyFile(source, joinPath(REMOTE_DIR, '.env'), options(true));

		assert.deepStrictEqual({ chmods: metadata.chmods, content: await text(fileService, joinPath(REMOTE_DIR, '.env')), left: await names(fileService, REMOTE_DIR) }, {
			chmods: [['temp', '600']],
			content: 'new',
			left: ['.env'],
		});
	});

	test('writes in place when the target belongs to someone else, has hard links, or its mode cannot be read', async () => {
		const results: Array<[string, string, number, boolean]> = [];
		for (const [label, info] of [
			['other owner', { mode: 0o644, ownedByMe: false, linkCount: 1 }],
			['hard links', { mode: 0o644, ownedByMe: true, linkCount: 2 }],
			['old server', undefined],
		] as const) {
			const { fileService, fileSystem, metadata, journal } = setup();
			const source = URI.file('/work/a.txt');
			await fileService.writeFile(source, VSBuffer.fromString('new'));
			await fileService.writeFile(joinPath(REMOTE_DIR, 'a.txt'), VSBuffer.fromString('old'));
			metadata.target = info;
			let inPlace = false;
			await fileSystem.copyFile(source, joinPath(REMOTE_DIR, 'a.txt'), options(true, () => { }, CancellationToken.None, () => inPlace = true));
			results.push([label, await text(fileService, joinPath(REMOTE_DIR, 'a.txt')), journal.length + metadata.chmods.length, inPlace]);
		}
		// どれも一時ファイルを使わず（控えも chmod も無し）、その場で書いたことを知らせている
		assert.deepStrictEqual(results, [['other owner', 'new', 0, true], ['hard links', 'new', 0, true], ['old server', 'new', 0, true]]);
	});

	test('a temporary failure to read the target fails the item instead of writing in place', async () => {
		const { fileService, fileSystem, metadata, journal } = setup();
		const source = URI.file('/work/a.txt');
		await fileService.writeFile(source, VSBuffer.fromString('new'));
		await fileService.writeFile(joinPath(REMOTE_DIR, 'a.txt'), VSBuffer.fromString('old'));
		metadata.target = new Error('Connection timed out');

		const result = await fileSystem.copyFile(source, joinPath(REMOTE_DIR, 'a.txt'), options(true)).then(() => 'resolved', error => error.message);

		assert.deepStrictEqual({ result, original: await text(fileService, joinPath(REMOTE_DIR, 'a.txt')), journal, left: await names(fileService, REMOTE_DIR) }, {
			result: 'Connection timed out', original: 'old', journal: [], left: ['a.txt'],
		});
	});

	test('refuses to copy a file onto itself (same dev / ino / size / mtime)', async () => {
		const { fileService, fileSystem, metadata } = setup();
		const source = URI.file('/work/a.txt');
		await fileService.writeFile(source, VSBuffer.fromString('new'));
		await fileService.writeFile(joinPath(REMOTE_DIR, 'a.txt'), VSBuffer.fromString('old'));
		metadata.source = 0o644;
		metadata.sourceIdentity = '1:42:3:1000';
		metadata.target = { mode: 0o644, ownedByMe: false, linkCount: 1, identity: '1:42:3:1000' };

		const kind = await fileSystem.copyFile(source, joinPath(REMOTE_DIR, 'a.txt'), options(true)).then(() => 'resolved', error => paradisClassifyTransferError(error));

		assert.deepStrictEqual({ kind, original: await text(fileService, joinPath(REMOTE_DIR, 'a.txt')) }, { kind: 'sameFile', original: 'old' });
	});

	test('overwrites with the plain rename of the channel when the server has it', async () => {
		const { fileService, fileSystem, metadata } = setup();
		const source = URI.file('/work/a.txt');
		await fileService.writeFile(source, VSBuffer.fromString('new'));
		await fileService.writeFile(joinPath(REMOTE_DIR, 'a.txt'), VSBuffer.fromString('old'));
		await fileService.writeFile(URI.file('/work/b.txt'), VSBuffer.fromString('b'));
		metadata.target = { mode: 0o644, ownedByMe: true, linkCount: 1 };
		metadata.renameWith = (from, to) => fileService.move(from, to, true).then(() => undefined);

		await fileSystem.copyFile(source, joinPath(REMOTE_DIR, 'a.txt'), options(true));
		// 新しく作るときは、送り先の有無を確かめる provider の rename を使う
		await fileSystem.copyFile(URI.file('/work/b.txt'), joinPath(REMOTE_DIR, 'b.txt'), options(false));

		assert.deepStrictEqual({ renames: metadata.renames, a: await text(fileService, joinPath(REMOTE_DIR, 'a.txt')), b: await text(fileService, joinPath(REMOTE_DIR, 'b.txt')) }, {
			renames: ['a.txt'], a: 'new', b: 'b',
		});
	});

	test('falls back to writing in place when a temporary file cannot be created', async () => {
		const { fileService, fileSystem, metadata } = setup({ target: new NoTempProvider() });
		const source = URI.file('/work/a.txt');
		await fileService.writeFile(source, VSBuffer.fromString('new'));
		await fileService.writeFile(joinPath(REMOTE_DIR, 'a.txt'), VSBuffer.fromString('old'));
		metadata.target = { mode: 0o644, ownedByMe: true, linkCount: 1 };

		await fileSystem.copyFile(source, joinPath(REMOTE_DIR, 'a.txt'), options(true));

		assert.deepStrictEqual({ content: await text(fileService, joinPath(REMOTE_DIR, 'a.txt')), left: await names(fileService, REMOTE_DIR) }, { content: 'new', left: ['a.txt'] });
	});

	test('a failed rename keeps both the original and the written temporary file, and says where it is', async () => {
		const { fileService, fileSystem, metadata, journal } = setup({ target: new FailingRenameProvider() });
		const source = URI.file('/work/a.txt');
		await fileService.writeFile(source, VSBuffer.fromString('new'));
		await fileService.writeFile(joinPath(REMOTE_DIR, 'a.txt'), VSBuffer.fromString('old'));
		metadata.target = { mode: 0o644, ownedByMe: true, linkCount: 1 };

		const error = await fileSystem.copyFile(source, joinPath(REMOTE_DIR, 'a.txt'), options(true)).then(() => undefined, failure => failure);
		const left = await names(fileService, REMOTE_DIR);
		const temp = left.find(paradisIsTransferTempName);

		assert.deepStrictEqual({
			kind: paradisClassifyTransferError(error),
			mentionsTemp: !!temp && String(error?.message).includes(temp),
			original: await text(fileService, joinPath(REMOTE_DIR, 'a.txt')),
			written: temp ? await text(fileService, joinPath(REMOTE_DIR, temp)) : undefined,
			// 自動の片付けの対象から外している
			journal,
		}, { kind: 'replaceFailed', mentionsTemp: true, original: 'old', written: 'new', journal: ['+true', '-true'] });
	});

	test('a failure in the middle keeps the existing file and leaves no temporary file', async () => {
		const { fileService, fileSystem, metadata } = setup({ source: new FailingReadProvider() });
		const source = URI.file('/work/data.bin');
		const target = joinPath(REMOTE_DIR, 'data.bin');
		await fileService.writeFile(source, VSBuffer.fromString('y'.repeat(600_000)));
		await fileService.writeFile(target, VSBuffer.fromString('original'));
		metadata.target = { mode: 0o644, ownedByMe: true, linkCount: 1 };

		const result = await fileSystem.copyFile(source, target, options(true)).then(() => 'resolved', error => error.message);

		assert.deepStrictEqual({ failed: result !== 'resolved', original: await text(fileService, target), left: await names(fileService, REMOTE_DIR) }, {
			failed: true, original: 'original', left: ['data.bin'],
		});
	});

	test('without overwrite an existing target is a conflict, and a folder is never overwritten', async () => {
		const { fileService, fileSystem } = setup();
		const source = URI.file('/work/a.txt');
		await fileService.writeFile(source, VSBuffer.fromString('new'));
		await fileService.writeFile(joinPath(REMOTE_DIR, 'a.txt'), VSBuffer.fromString('original'));
		await fileService.writeFile(joinPath(REMOTE_DIR, 'logs', 'app.log'), VSBuffer.fromString('keep'));

		const noOverwrite = await fileSystem.copyFile(source, joinPath(REMOTE_DIR, 'a.txt'), options(false)).then(() => 'resolved', error => paradisClassifyTransferError(error));
		const ontoFolder = await fileSystem.copyFile(source, joinPath(REMOTE_DIR, 'logs'), options(true)).then(() => 'resolved', error => paradisClassifyTransferError(error));

		assert.deepStrictEqual({
			noOverwrite,
			ontoFolder,
			original: await text(fileService, joinPath(REMOTE_DIR, 'a.txt')),
			folderKept: await text(fileService, joinPath(REMOTE_DIR, 'logs', 'app.log')),
			left: await names(fileService, REMOTE_DIR),
		}, { noOverwrite: 'conflict', ontoFolder: 'conflict', original: 'original', folderKept: 'keep', left: ['a.txt', 'logs'] });
	});

	test('a cancelled copy rejects and writes nothing', async () => {
		const { fileService, fileSystem } = setup();
		const source = URI.file('/work/data.bin');
		await fileService.writeFile(source, VSBuffer.fromString('abc'));
		await fileService.createFolder(REMOTE_DIR);
		const cancellation = new CancellationTokenSource();
		cancellation.cancel();
		const result = await fileSystem.copyFile(source, joinPath(REMOTE_DIR, 'data.bin'), options(true, () => { }, cancellation.token)).then(() => 'resolved', () => 'rejected');
		cancellation.dispose();
		assert.deepStrictEqual({ result, left: await names(fileService, REMOTE_DIR) }, { result: 'rejected', left: [] });
	});

	test('removeForReplace removes a folder with its content', async () => {
		const { fileService, fileSystem } = setup();
		await fileService.writeFile(joinPath(REMOTE_DIR, 'logs', 'app.log'), VSBuffer.fromString('x'));
		await fileSystem.removeForReplace(joinPath(REMOTE_DIR, 'logs'));
		assert.deepStrictEqual(await names(fileService, REMOTE_DIR), []);
	});
});
