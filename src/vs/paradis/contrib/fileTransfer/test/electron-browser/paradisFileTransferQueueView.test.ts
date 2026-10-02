/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IParadisTransferChild, IParadisTransferCopyOptions, IParadisTransferFileSystem, IParadisTransferItem, IParadisTransferStat, ParadisTransferQueue } from '../../common/paradisFileTransferQueue.js';
import { paradisQueueDoneText, ParadisFileTransferQueueView } from '../../electron-browser/paradisFileTransferQueueView.js';

/** 送り先は常に空で、コピーは `hold` が解けるまで 1 塊目で止まる読み書き。 */
class HeldFileSystem implements IParadisTransferFileSystem {
	readonly hold = new DeferredPromise<void>();
	onBytes: ((bytes: number) => void) | undefined;
	async stat(resource: URI): Promise<IParadisTransferStat | undefined> {
		return resource.scheme === 'file' ? { isDirectory: false, size: 2000, mtime: 0 } : undefined;
	}
	async readDirectory(): Promise<readonly IParadisTransferChild[]> {
		return [];
	}
	async createDirectory(): Promise<void> { }
	async copyFile(_source: URI, _target: URI, options: IParadisTransferCopyOptions): Promise<void> {
		this.onBytes = options.onBytes;
		options.onBytes(1000);
		await this.hold.p;
		// 本物と同じく、置き換えの前に取り消されていたらやめる
		if (options.token.isCancellationRequested) {
			throw new CancellationError();
		}
	}
	async removeForReplace(): Promise<void> { }
}

function nextFrame(): Promise<void> {
	return new Promise(resolve => mainWindow.requestAnimationFrame(() => resolve()));
}

suite('Paradis file transfer - queue view', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the same row and buttons while progress updates arrive', async () => {
		const fileSystem = new HeldFileSystem();
		let clock = 0;
		const queue = store.add(new ParadisTransferQueue({ fileSystem, now: () => clock += 200 }));
		const storage = store.add(new InMemoryStorageService());
		const retried: number[] = [];
		const view = store.add(new ParadisFileTransferQueueView(queue, (item: IParadisTransferItem) => retried.push(item.id), storage));
		mainWindow.document.body.appendChild(view.element);

		const local = URI.file('/work');
		await queue.enqueue({ sources: [{ resource: joinPath(local, 'a.bin'), name: 'a.bin', isDirectory: false }], targetDirectory: URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev', path: '/out' }), targetLabel: 'dev', direction: 'toRemote' }, async () => ({ action: 'cancel', applyToAll: false }));
		await nextFrame();
		const rowBefore = view.element.querySelector('.para-ft-qr');
		const buttonBefore = view.element.querySelector('.para-ft-qr button');
		const textBefore = view.element.querySelector('.para-ft-qdone')?.textContent;

		// 進み具合だけが変わる通知を何度か受けても、行とボタンは作り直さない
		for (let index = 0; index < 3; index++) {
			fileSystem.onBytes?.(0);
			await nextFrame();
		}
		const sameRow = view.element.querySelector('.para-ft-qr') === rowBefore;
		const sameButton = view.element.querySelector('.para-ft-qr button') === buttonBefore;

		// 取り消しのボタンを押せる
		(buttonBefore as HTMLButtonElement).click();
		await nextFrame();
		const stateAfterClick = queue.items[0].state;
		fileSystem.hold.complete();
		await queue.whenIdle();
		await nextFrame();
		(view.element.querySelector('.para-ft-qr button') as HTMLButtonElement).click();
		view.element.remove();

		assert.deepStrictEqual({ textBefore, sameRow, sameButton, stateAfterClick, retried }, {
			textBefore: '1000 B / 2.0 KB',
			sameRow: true,
			sameButton: true,
			stateAfterClick: 'cancelled',
			retried: [queue.items[0].id],
		});
	});

	test('shows skipped entries and direct overwrites next to the progress', () => {
		const base = { writesInPlace: false, id: 1, name: 'dist', isDirectory: true, source: URI.file('/a'), target: URI.file('/b'), targetLabel: 'dev', direction: 'toRemote' as const, totalBytes: 10, doneBytes: 10, totalFiles: 3, doneFiles: 3, bytesPerSecond: undefined, remainingSeconds: undefined, error: undefined };
		assert.deepStrictEqual([
			paradisQueueDoneText({ ...base, state: 'done', skipped: 2 }),
			paradisQueueDoneText({ ...base, state: 'done', skipped: 0 }),
			paradisQueueDoneText({ ...base, state: 'error', skipped: 0, writesInPlace: true, error: { kind: 'disconnected', message: '接続が切れました' } }),
		], ['3 ファイル · 2 件を飛ばしました', '3 ファイル', '接続が切れました · 送り先を直接書き換えます（途中で失敗すると元に戻りません）']);
	});
});
