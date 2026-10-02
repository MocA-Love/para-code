/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { basename, dirname, isEqualOrParent, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult } from '../../../../../platform/files/common/files.js';
import {
	IParadisConflictDecision,
	IParadisTransferChild,
	IParadisTransferConflict,
	IParadisTransferCopyOptions,
	IParadisTransferFileSystem,
	IParadisTransferItem,
	IParadisTransferSource,
	IParadisTransferStat,
	ParadisTransferConflictError,
	ParadisTransferQueue,
	paradisTransferTempName,
} from '../../common/paradisFileTransferQueue.js';

const CHUNK = 1000;
const CHUNK_MS = 250;

interface IFakeEntry {
	readonly isDirectory: boolean;
	readonly size: number;
	readonly mtime: number;
	readonly special?: boolean;
	readonly directoryLink?: boolean;
	readonly isSymbolicLink?: boolean;
	/** 中身の目印（どの実行がどの送り元から書いたか）。 */
	readonly content?: string;
}

/**
 * メモリ上のファイルシステム。本物の読み書きの口と同じく、一時名に書いてから置き換える。
 * 1 塊ごとに時計を進め、`hold` があればそこで待つ。
 */
class FakeFileSystem implements IParadisTransferFileSystem {

	now = 1_000_000;
	readonly entries = new Map<string, IFakeEntry>();
	readonly removed: string[] = [];
	readonly failures = new Map<string, Error>();
	hold: DeferredPromise<void> | undefined;
	/** 置き換えの直前に呼ぶ（置き換えの途中の取り消しを試すため）。 */
	beforeReplace: (() => Promise<void>) | undefined;
	started = 0;
	private readonly startedListeners: Array<() => void> = [];

	addDirectory(resource: URI, extra: Partial<IFakeEntry> = {}): void {
		this.entries.set(resource.toString(), { isDirectory: true, size: 0, mtime: this.now, ...extra });
	}

	addFile(resource: URI, size: number, extra: Partial<IFakeEntry> = {}): void {
		this.entries.set(resource.toString(), { isDirectory: false, size, mtime: this.now, ...extra });
	}

	get(resource: URI): IFakeEntry | undefined {
		return this.entries.get(resource.toString());
	}

	/** 一時ファイルが残っていないか。 */
	tempsLeft(): string[] {
		return [...this.entries.keys()].filter(key => key.includes('.paratransfer-'));
	}

	whenStarted(count: number): Promise<void> {
		return this.started >= count ? Promise.resolve() : new Promise(resolve => this.startedListeners.push(() => {
			if (this.started >= count) {
				resolve();
			}
		}));
	}

	async stat(resource: URI): Promise<IParadisTransferStat | undefined> {
		const entry = this.get(resource);
		return entry ? { isDirectory: entry.isDirectory, size: entry.size, mtime: entry.mtime, special: entry.special, isSymbolicLink: entry.isSymbolicLink } : undefined;
	}

	async readDirectory(resource: URI): Promise<readonly IParadisTransferChild[]> {
		const failure = this.failures.get(resource.toString());
		if (failure) {
			throw failure;
		}
		const children: IParadisTransferChild[] = [];
		for (const [key, entry] of this.entries) {
			const child = URI.parse(key);
			if (dirname(child).toString() === resource.toString() && child.toString() !== resource.toString()) {
				children.push({ name: basename(child), resource: child, ...entry });
			}
		}
		return children.sort((a, b) => a.name.localeCompare(b.name));
	}

	async createDirectory(resource: URI): Promise<void> {
		if (!this.get(resource)) {
			this.addDirectory(resource);
		}
	}

	async copyFile(source: URI, target: URI, options: IParadisTransferCopyOptions): Promise<void> {
		this.started++;
		this.startedListeners.forEach(listener => listener());
		const failure = this.failures.get(source.toString());
		if (failure) {
			throw failure;
		}
		const temp = joinPath(dirname(target), paradisTransferTempName(options.runId));
		this.addFile(temp, 0);
		try {
			const size = this.get(source)!.size;
			for (let done = 0; done < size; done += CHUNK) {
				if (this.hold) {
					await this.hold.p;
				}
				if (options.token.isCancellationRequested) {
					throw new CancellationError();
				}
				this.now += CHUNK_MS;
				options.onBytes(Math.min(CHUNK, size - done));
			}
			if (this.beforeReplace) {
				await this.beforeReplace();
			}
			const existing = this.get(target);
			if (existing?.isDirectory || existing?.isSymbolicLink || (existing && !options.overwrite)) {
				throw new ParadisTransferConflictError(target);
			}
			this.addFile(target, size, { content: `${source.path}#${options.runId}` });
		} finally {
			this.entries.delete(temp.toString());
		}
	}

	async removeForReplace(resource: URI): Promise<void> {
		this.removed.push(resource.path);
		for (const key of [...this.entries.keys()]) {
			if (isEqualOrParent(URI.parse(key), resource)) {
				this.entries.delete(key);
			}
		}
	}
}

const LOCAL = URI.file('/Users/example/web-app');
const REMOTE = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev-server', path: '/home/example/apps' });

function source(name: string, isDirectory = false): IParadisTransferSource {
	return { resource: joinPath(LOCAL, name), name, isDirectory };
}

function request(sources: IParadisTransferSource[]) {
	return { sources, targetDirectory: REMOTE, targetLabel: 'dev-server', direction: 'toRemote' as const };
}

async function until(queue: ParadisTransferQueue, predicate: () => boolean): Promise<void> {
	while (!predicate()) {
		await Event.toPromise(queue.onDidChange);
	}
}

async function settled(queue: ParadisTransferQueue): Promise<void> {
	await until(queue, () => queue.items.every(item => item.state !== 'waiting' && item.state !== 'running'));
	await queue.whenIdle();
}

function pick(item: IParadisTransferItem) {
	return {
		name: item.name,
		target: item.target.path,
		state: item.state,
		doneBytes: item.doneBytes,
		totalBytes: item.totalBytes,
		doneFiles: item.doneFiles,
		totalFiles: item.totalFiles,
		skipped: item.skipped,
		error: item.error?.kind,
	};
}

const neverAsked = async (): Promise<IParadisConflictDecision> => { throw new Error('unexpected conflict'); };

suite('Paradis file transfer - queue', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createQueue(fileSystem: FakeFileSystem, options: { concurrency?: number; disconnected?: boolean } = {}): ParadisTransferQueue {
		return store.add(new ParadisTransferQueue({
			fileSystem,
			concurrency: options.concurrency,
			now: () => fileSystem.now,
			isDisconnected: () => !!options.disconnected,
		}));
	}

	test('reports progress, speed and remaining time while copying', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'build.tar.gz'), 4 * CHUNK);
		const queue = createQueue(fileSystem);

		let chunks = 0;
		const halfway = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		const copyFile = fileSystem.copyFile.bind(fileSystem);
		fileSystem.copyFile = (from, to, options) => copyFile(from, to, {
			...options, onBytes: bytes => {
				options.onBytes(bytes);
				if (++chunks === 2) {
					fileSystem.hold = release;
					halfway.complete();
				}
			}
		});

		await queue.enqueue(request([source('build.tar.gz')]), neverAsked);
		await halfway.p;
		const middle = queue.items[0];
		const middleSnapshot = { ...pick(middle), bytesPerSecond: middle.bytesPerSecond, remainingSeconds: middle.remainingSeconds, summary: queue.getSummary() };

		fileSystem.hold = undefined;
		release.complete();
		await settled(queue);

		assert.deepStrictEqual({
			middle: middleSnapshot,
			end: { ...pick(queue.items[0]), bytesPerSecond: queue.items[0].bytesPerSecond, summary: queue.getSummary() },
			written: fileSystem.get(joinPath(REMOTE, 'build.tar.gz'))?.size,
			temps: fileSystem.tempsLeft(),
		}, {
			middle: {
				name: 'build.tar.gz', target: '/home/example/apps/build.tar.gz', state: 'running', doneBytes: 2000, totalBytes: 4000, doneFiles: 0, totalFiles: 1, skipped: 0, error: undefined,
				bytesPerSecond: 4000, remainingSeconds: 0.5,
				summary: { active: 1, running: 1, failed: 0, preparing: 0, percent: 50, remainingSeconds: 0.5 },
			},
			end: {
				name: 'build.tar.gz', target: '/home/example/apps/build.tar.gz', state: 'done', doneBytes: 4000, totalBytes: 4000, doneFiles: 1, totalFiles: 1, skipped: 0, error: undefined,
				bytesPerSecond: 4000,
				summary: { active: 0, running: 0, failed: 0, preparing: 0, percent: undefined, remainingSeconds: undefined },
			},
			written: 4000,
			temps: [],
		});
	});

	test('copies a folder recursively, and skips folder links, special files and unreadable entries with a count', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addDirectory(joinPath(LOCAL, 'dist'));
		fileSystem.addFile(joinPath(LOCAL, 'dist', 'index.html'), 1500);
		fileSystem.addDirectory(joinPath(LOCAL, 'dist', 'assets'));
		fileSystem.addFile(joinPath(LOCAL, 'dist', 'assets', 'app.js'), 2500);
		fileSystem.addDirectory(joinPath(LOCAL, 'dist', 'parent'), { directoryLink: true });
		fileSystem.addFile(joinPath(LOCAL, 'dist', 'pipe'), 0, { special: true });
		fileSystem.addFile(joinPath(LOCAL, 'dist', 'secret.key'), 10);
		fileSystem.failures.set(joinPath(LOCAL, 'dist', 'secret.key').toString(), new FileOperationError('EACCES', FileOperationResult.FILE_PERMISSION_DENIED));
		fileSystem.addDirectory(joinPath(LOCAL, 'dist', 'locked'));
		fileSystem.failures.set(joinPath(LOCAL, 'dist', 'locked').toString(), new FileOperationError('EACCES', FileOperationResult.FILE_PERMISSION_DENIED));
		const queue = createQueue(fileSystem);

		await queue.enqueue(request([source('dist', true)]), neverAsked);
		await settled(queue);

		assert.deepStrictEqual({
			item: pick(queue.items[0]),
			created: ['dist', 'dist/assets', 'dist/index.html', 'dist/assets/app.js', 'dist/parent', 'dist/pipe', 'dist/secret.key'].map(path => !!fileSystem.get(joinPath(REMOTE, path))),
		}, {
			// 飛ばしたのは リンク・FIFO・読めないファイル・読めないフォルダー の 4 件
			item: { name: 'dist', target: '/home/example/apps/dist', state: 'done', doneBytes: 4000, totalBytes: 4010, doneFiles: 2, totalFiles: 3, skipped: 4, error: undefined },
			created: [true, true, true, true, false, false, false],
		});
	});

	test('cancelling before anything is written keeps the existing file and removes only the temporary file (H1)', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'big.bin'), 10 * CHUNK);
		fileSystem.addFile(joinPath(REMOTE, 'big.bin'), 7, { content: 'original' });
		const queue = createQueue(fileSystem);
		const hold = fileSystem.hold = new DeferredPromise<void>();

		await queue.enqueue(request([source('big.bin')]), async () => ({ action: 'overwrite', applyToAll: false }));
		await fileSystem.whenStarted(1);
		queue.cancel(queue.items[0].id);
		const stateRightAfterCancel = queue.items[0].state;
		hold.complete();
		await queue.whenIdle();

		assert.deepStrictEqual({
			stateRightAfterCancel,
			state: queue.items[0].state,
			original: fileSystem.get(joinPath(REMOTE, 'big.bin'))?.content,
			temps: fileSystem.tempsLeft(),
		}, {
			stateRightAfterCancel: 'cancelled',
			state: 'cancelled',
			original: 'original',
			temps: [],
		});
	});

	test('a failure in the middle keeps the existing file (H2)', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'a.txt'), 3 * CHUNK);
		fileSystem.addFile(joinPath(REMOTE, 'a.txt'), 7, { content: 'original' });
		const queue = createQueue(fileSystem);
		const copyFile = fileSystem.copyFile.bind(fileSystem);
		fileSystem.copyFile = (from, to, options) => copyFile(from, to, {
			...options, onBytes: () => { throw new Error('connection reset'); }
		});

		await queue.enqueue(request([source('a.txt')]), async () => ({ action: 'overwrite', applyToAll: false }));
		await settled(queue);

		assert.deepStrictEqual({ state: queue.items[0].state, original: fileSystem.get(joinPath(REMOTE, 'a.txt'))?.content, temps: fileSystem.tempsLeft() }, {
			state: 'error', original: 'original', temps: [],
		});
	});

	test('a retry right after cancelling waits for the old run, and the old run counts against the limit (H3)', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'a.bin'), 2 * CHUNK);
		fileSystem.addFile(joinPath(LOCAL, 'b.bin'), CHUNK);
		const queue = createQueue(fileSystem, { concurrency: 1 });
		const hold = fileSystem.hold = new DeferredPromise<void>();

		await queue.enqueue(request([source('a.bin'), source('b.bin')]), neverAsked);
		await fileSystem.whenStarted(1);
		const [a, b] = queue.items;
		queue.cancel(a.id);
		const retried = queue.retry(a.id);
		// 取り消した a はまだ片付け中なので、b も再試行した a も始まらない
		await Promise.resolve();
		const whileCleaning = { started: fileSystem.started, b: queue.items[1].state, a: queue.items[0].state };
		fileSystem.hold = undefined;
		hold.complete();
		await retried;
		await settled(queue);

		assert.deepStrictEqual({
			whileCleaning,
			final: queue.items.map(item => [item.name, item.state]),
			// 新しい実行の成果物は、前の実行の片付けで消えていない
			a: fileSystem.get(joinPath(REMOTE, 'a.bin'))?.size,
			b: b.id !== a.id,
		}, {
			whileCleaning: { started: 1, b: 'waiting', a: 'cancelled' },
			final: [['a.bin', 'done'], ['b.bin', 'done']],
			a: 2000,
			b: true,
		});
	});

	test('runs two at a time and the rest wait', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		for (const name of ['a.bin', 'b.bin', 'c.bin']) {
			fileSystem.addFile(joinPath(LOCAL, name), CHUNK);
		}
		const queue = createQueue(fileSystem);
		const hold = fileSystem.hold = new DeferredPromise<void>();

		await queue.enqueue(request([source('a.bin'), source('b.bin'), source('c.bin')]), neverAsked);
		await fileSystem.whenStarted(2);
		const whileHeld = queue.items.map(item => item.state);
		fileSystem.hold = undefined;
		hold.complete();
		await settled(queue);

		assert.deepStrictEqual({ whileHeld, after: queue.items.map(item => item.state) }, {
			whileHeld: ['running', 'running', 'waiting'],
			after: ['done', 'done', 'done'],
		});
	});

	test('asks about each name conflict and applies rename / skip / overwrite', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		for (const name of ['a.txt', 'b.txt', 'c.txt']) {
			fileSystem.addFile(joinPath(LOCAL, name), 100);
		}
		fileSystem.addFile(joinPath(REMOTE, 'a.txt'), 50);
		fileSystem.addFile(joinPath(REMOTE, 'b.txt'), 50);
		const queue = createQueue(fileSystem);
		const asked: Array<Pick<IParadisTransferConflict, 'name' | 'index' | 'total' | 'renamedName' | 'allowApplyToAll'>> = [];
		const answers: IParadisConflictDecision[] = [{ action: 'rename', applyToAll: false }, { action: 'skip', applyToAll: false }];

		const queued = await queue.enqueue(request([source('a.txt'), source('b.txt'), source('c.txt')]), async conflict => {
			asked.push({ name: conflict.name, index: conflict.index, total: conflict.total, renamedName: conflict.renamedName, allowApplyToAll: conflict.allowApplyToAll });
			return answers.shift()!;
		});
		await settled(queue);

		assert.deepStrictEqual({ queued, asked, targets: queue.items.map(item => item.target.path) }, {
			queued: 2,
			asked: [
				{ name: 'a.txt', index: 1, total: 2, renamedName: 'a (1).txt', allowApplyToAll: true },
				{ name: 'b.txt', index: 2, total: 2, renamedName: 'b (1).txt', allowApplyToAll: true },
			],
			targets: ['/home/example/apps/c.txt', '/home/example/apps/a (1).txt'],
		});
	});

	test('"apply to all" stops asking, and "cancel" queues nothing', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		for (const name of ['a.txt', 'b.txt']) {
			fileSystem.addFile(joinPath(LOCAL, name), 100);
			fileSystem.addFile(joinPath(REMOTE, name), 50);
		}
		const queue = createQueue(fileSystem);
		const both = request([source('a.txt'), source('b.txt')]);

		let cancelAsked = 0;
		const cancelled = await queue.enqueue(both, async () => {
			cancelAsked++;
			return { action: 'cancel', applyToAll: false };
		});
		let overwriteAsked = 0;
		const overwritten = await queue.enqueue(both, async () => {
			overwriteAsked++;
			return { action: 'overwrite', applyToAll: true };
		});
		await settled(queue);

		assert.deepStrictEqual({
			cancelled, cancelAsked, overwritten, overwriteAsked,
			sizes: ['a.txt', 'b.txt'].map(name => fileSystem.get(joinPath(REMOTE, name))?.size),
		}, { cancelled: 0, cancelAsked: 1, overwritten: 2, overwriteAsked: 1, sizes: [100, 100] });
	});

	test('a file replacing a folder of the same name is asked every time, and the folder goes through removeForReplace (H4)', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		for (const name of ['a.txt', 'logs', 'b.txt']) {
			fileSystem.addFile(joinPath(LOCAL, name), 10);
		}
		fileSystem.addFile(joinPath(REMOTE, 'a.txt'), 5);
		fileSystem.addDirectory(joinPath(REMOTE, 'logs'));
		fileSystem.addFile(joinPath(REMOTE, 'logs', 'app.log'), 5);
		fileSystem.addFile(joinPath(REMOTE, 'b.txt'), 5);
		const queue = createQueue(fileSystem);
		const asked: Array<[string, boolean, boolean]> = [];

		await queue.enqueue(request([source('a.txt'), source('logs'), source('b.txt')]), async conflict => {
			asked.push([conflict.name, conflict.kindMismatch, conflict.allowApplyToAll]);
			return { action: 'overwrite', applyToAll: true };
		});
		await settled(queue);

		assert.deepStrictEqual({
			asked,
			removed: fileSystem.removed,
			logs: (({ isDirectory, size }) => ({ isDirectory, size }))(fileSystem.get(joinPath(REMOTE, 'logs'))!),
			states: queue.items.map(item => item.state),
		}, {
			// a.txt で「以後すべて」を選んでも、種類の違う logs は改めて聞く。b.txt は聞かない
			asked: [['a.txt', false, true], ['logs', true, false]],
			removed: ['/home/example/apps/logs'],
			logs: { isDirectory: false, size: 10 },
			states: ['done', 'done', 'done'],
		});
	});

	test('a name that appears while waiting is asked about at run time, and an automatic retry fails instead of overwriting', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'a.bin'), CHUNK);
		fileSystem.addFile(joinPath(LOCAL, 'late.txt'), 10);
		fileSystem.addFile(joinPath(LOCAL, 'auto.txt'), 10);
		const queue = createQueue(fileSystem, { concurrency: 1 });
		const hold = fileSystem.hold = new DeferredPromise<void>();
		const asked: Array<[string, number, boolean]> = [];

		await queue.enqueue(request([source('a.bin'), source('late.txt')]), async conflict => {
			asked.push([conflict.name, conflict.total, conflict.allowApplyToAll]);
			return { action: 'rename', applyToAll: false };
		});
		await fileSystem.whenStarted(1);
		// late.txt が待っている間に、送り先へ同じ名前ができる
		fileSystem.addFile(joinPath(REMOTE, 'late.txt'), 3, { content: 'someone else' });
		fileSystem.hold = undefined;
		hold.complete();
		await settled(queue);

		// 接続が戻ったときの自動の流し直し（聞く相手がいない）は、同名があれば失敗にする
		fileSystem.failures.set(joinPath(LOCAL, 'auto.txt').toString(), new Error('Connection closed'));
		await queue.enqueue(request([source('auto.txt')]), neverAsked);
		await settled(queue);
		fileSystem.failures.clear();
		fileSystem.addFile(joinPath(REMOTE, 'auto.txt'), 3, { content: 'someone else' });
		queue.retryWhere(item => item.name === 'auto.txt');
		await until(queue, () => queue.items[2].state === 'error' && queue.items[2].error?.kind === 'conflict');
		await queue.whenIdle();

		assert.deepStrictEqual({
			asked,
			targets: queue.items.map(item => [item.target.path, item.state, item.error?.kind]),
			kept: [fileSystem.get(joinPath(REMOTE, 'late.txt'))?.content, fileSystem.get(joinPath(REMOTE, 'auto.txt'))?.content],
		}, {
			asked: [['late.txt', 1, false]],
			targets: [
				['/home/example/apps/a.bin', 'done', undefined],
				['/home/example/apps/late (1).txt', 'done', undefined],
				['/home/example/apps/auto.txt', 'error', 'conflict'],
			],
			kept: ['someone else', 'someone else'],
		});
	});

	test('a link at the target is treated like a different kind: asked every time and removed before writing', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		for (const name of ['a.txt', 'current']) {
			fileSystem.addFile(joinPath(LOCAL, name), 10);
		}
		fileSystem.addFile(joinPath(REMOTE, 'a.txt'), 5);
		fileSystem.addFile(joinPath(REMOTE, 'current'), 5, { isSymbolicLink: true });
		const queue = createQueue(fileSystem);
		const asked: Array<[string, boolean]> = [];

		await queue.enqueue(request([source('a.txt'), source('current')]), async conflict => {
			asked.push([conflict.name, conflict.kindMismatch]);
			return { action: 'overwrite', applyToAll: true };
		});
		await settled(queue);

		assert.deepStrictEqual({ asked, removed: fileSystem.removed, current: fileSystem.get(joinPath(REMOTE, 'current'))?.isSymbolicLink, states: queue.items.map(item => item.state) }, {
			asked: [['a.txt', false], ['current', true]],
			removed: ['/home/example/apps/current'],
			current: undefined,
			states: ['done', 'done'],
		});
	});

	test('an item waiting for a run-time conflict dialog does not hold a slot', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'late.txt'), 10);
		fileSystem.addFile(joinPath(LOCAL, 'b.txt'), 10);
		const queue = createQueue(fileSystem, { concurrency: 1 });
		const decision = new DeferredPromise<IParadisConflictDecision>();
		const asking = new DeferredPromise<void>();
		const prepared = new DeferredPromise<void>();
		// late.txt を積んだ後、実行の直前までに同じ名前ができる
		const stat = fileSystem.stat.bind(fileSystem);
		let first = true;
		fileSystem.stat = async resource => {
			if (first && resource.path.endsWith('/late.txt') && resource.scheme === 'vscode-remote') {
				first = false;
				fileSystem.addFile(joinPath(REMOTE, 'late.txt'), 3);
				prepared.complete();
			}
			return stat(resource);
		};

		await queue.enqueue(request([source('late.txt'), source('b.txt')]), async () => {
			asking.complete();
			return decision.p;
		});
		await asking.p;
		await until(queue, () => queue.items[1].state === 'done');
		const whileAsking = queue.items.map(item => item.state);
		await queue.whenIdle({ ignoreAwaitingDecision: true });
		decision.complete({ action: 'skip', applyToAll: false });
		await settled(queue);

		assert.deepStrictEqual({ whileAsking, final: queue.items.map(item => item.state) }, {
			whileAsking: ['running', 'done'],
			final: ['cancelled', 'done'],
		});
	});

	test('cancelling while the replacement is finishing still reports the item as done', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'a.bin'), CHUNK);
		const queue = createQueue(fileSystem);
		const replacing = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		fileSystem.beforeReplace = async () => {
			replacing.complete();
			await release.p;
		};

		await queue.enqueue(request([source('a.bin')]), neverAsked);
		await replacing.p;
		queue.cancel(queue.items[0].id);
		const afterCancel = queue.items[0].state;
		release.complete();
		await settled(queue);

		assert.deepStrictEqual({ afterCancel, final: queue.items[0].state, written: !!fileSystem.get(joinPath(REMOTE, 'a.bin')) }, {
			afterCancel: 'cancelled',
			final: 'done',
			written: true,
		});
	});

	test('a run-time rename avoids names other queued items will create', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'a.txt'), 10);
		fileSystem.addFile(joinPath(LOCAL, 'a (1).txt'), 10);
		fileSystem.addFile(joinPath(LOCAL, 'hold.bin'), CHUNK);
		const queue = createQueue(fileSystem, { concurrency: 1 });
		const hold = fileSystem.hold = new DeferredPromise<void>();

		await queue.enqueue(request([source('hold.bin'), source('a.txt'), source('a (1).txt')]), async () => ({ action: 'rename', applyToAll: false }));
		await fileSystem.whenStarted(1);
		// a.txt が待っている間に同じ名前ができる。a (1).txt は待ち行列の別の項目が作る予定
		fileSystem.addFile(joinPath(REMOTE, 'a.txt'), 3);
		fileSystem.hold = undefined;
		hold.complete();
		await settled(queue);

		assert.deepStrictEqual(queue.items.map(item => item.target.path), ['/home/example/apps/hold.bin', '/home/example/apps/a (2).txt', '/home/example/apps/a (1).txt']);
	});

	test('a rename does not collide with another item of the same transfer', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'a.txt'), 10);
		fileSystem.addFile(joinPath(LOCAL, 'a (1).txt'), 10);
		fileSystem.addFile(joinPath(REMOTE, 'a.txt'), 10);
		const queue = createQueue(fileSystem);

		await queue.enqueue(request([source('a.txt'), source('a (1).txt')]), async () => ({ action: 'rename', applyToAll: false }));
		await settled(queue);

		assert.deepStrictEqual(queue.items.map(item => item.target.path), ['/home/example/apps/a (1).txt', '/home/example/apps/a (2).txt']);
	});

	test('classifies failures, and a retry runs the item again', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addFile(joinPath(LOCAL, 'nginx.conf'), 10);
		fileSystem.failures.set(joinPath(LOCAL, 'nginx.conf').toString(), new FileOperationError('Unable to write file (NoPermissions)', FileOperationResult.FILE_PERMISSION_DENIED));
		const queue = createQueue(fileSystem);

		await queue.enqueue(request([source('nginx.conf')]), neverAsked);
		await settled(queue);
		const failed = { ...pick(queue.items[0]), message: queue.items[0].error?.message, summary: queue.getSummary() };

		fileSystem.failures.clear();
		await queue.retry(queue.items[0].id);
		await settled(queue);

		assert.deepStrictEqual({ failed, retried: pick(queue.items[0]) }, {
			failed: {
				name: 'nginx.conf', target: '/home/example/apps/nginx.conf', state: 'error', doneBytes: 0, totalBytes: 10, doneFiles: 0, totalFiles: 1, skipped: 0, error: 'permission',
				message: '権限がありません',
				summary: { active: 0, running: 0, failed: 1, preparing: 0, percent: undefined, remainingSeconds: undefined },
			},
			retried: { name: 'nginx.conf', target: '/home/example/apps/nginx.conf', state: 'done', doneBytes: 10, totalBytes: 10, doneFiles: 1, totalFiles: 1, skipped: 0, error: undefined },
		});
	});

	test('a failure while disconnected is reported as a lost connection, and copying into itself is refused', async () => {
		const fileSystem = new FakeFileSystem();
		fileSystem.addDirectory(REMOTE);
		fileSystem.addDirectory(LOCAL);
		fileSystem.addFile(joinPath(LOCAL, 'a.txt'), 10);
		fileSystem.failures.set(joinPath(LOCAL, 'a.txt').toString(), new Error('Connection closed'));
		const queue = createQueue(fileSystem, { disconnected: true });

		await queue.enqueue(request([source('a.txt')]), neverAsked);
		await queue.enqueue({ sources: [{ resource: LOCAL, name: 'web-app', isDirectory: true }], targetDirectory: LOCAL, targetLabel: 'このマシン', direction: 'toLocal' }, neverAsked);
		await settled(queue);

		assert.deepStrictEqual(queue.items.map(item => [item.name, item.state, item.error?.kind]), [
			['a.txt', 'error', 'disconnected'],
			['web-app', 'error', 'other'],
		]);
	});
});
