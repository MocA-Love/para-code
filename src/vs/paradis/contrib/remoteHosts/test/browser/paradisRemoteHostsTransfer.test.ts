/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { ConfirmResult, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotification, INotificationHandle } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IProgress, IProgressService, IProgressStep, Progress } from '../../../../../platform/progress/common/progress.js';
import {
	IParadisRemoteTransferServices,
	paradisCopyToDirectory,
	paradisPickLocalFiles,
	paradisSaveToMachine,
	paradisSendToHost,
} from '../../browser/paradisRemoteHostsTransfer.js';

/** 呼び出し側が結果を差し替えられる最小限の IFileDialogService。使わないメソッドは投げる。 */
class FakeFileDialogService implements IFileDialogService {
	declare readonly _serviceBrand: undefined;
	openDialogResult: readonly URI[] | undefined;
	saveResult: URI | undefined;
	async defaultFilePath(): Promise<URI> { throw new Error('not implemented'); }
	async defaultFolderPath(): Promise<URI> { throw new Error('not implemented'); }
	async defaultWorkspacePath(): Promise<URI> { throw new Error('not implemented'); }
	async pickFileFolderAndOpen(): Promise<void> { }
	async pickFileAndOpen(): Promise<void> { }
	async pickFolderAndOpen(): Promise<void> { }
	async pickWorkspaceAndOpen(): Promise<void> { }
	async pickFileToSave(): Promise<URI | undefined> { return this.saveResult; }
	async preferredHome(): Promise<URI> { throw new Error('not implemented'); }
	async showSaveDialog(): Promise<URI | undefined> { return this.saveResult; }
	async showSaveConfirm(): Promise<ConfirmResult> { throw new Error('not implemented'); }
	async showOpenDialog(): Promise<URI[] | undefined> { return this.openDialogResult ? [...this.openDialogResult] : undefined; }
}

/** task をそのまま実行するだけの IProgressService。UI 表示は無いのでテストには不要。 */
class FakeProgressService implements IProgressService {
	declare readonly _serviceBrand: undefined;
	withProgress<R>(_options: unknown, task: (progress: IProgress<IProgressStep>) => Promise<R>): Promise<R> {
		return task(Progress.None as IProgress<IProgressStep>);
	}
}

/** error/notify の呼び出しを記録する TestNotificationService。 */
class RecordingNotificationService extends TestNotificationService {
	readonly errors: (string | Error)[] = [];
	readonly notifications: INotification[] = [];
	override error(error: string | Error): INotificationHandle {
		this.errors.push(error);
		return super.error(error);
	}
	override notify(notification: INotification): INotificationHandle {
		this.notifications.push(notification);
		return super.notify(notification);
	}
}

suite('paradisRemoteHostsTransfer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createFileService(disposables: DisposableStore): Promise<FileService> {
		const fileService = disposables.add(new FileService(new NullLogService()));
		const provider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(Schemas.file, provider));
		return fileService;
	}

	function uri(path: string): URI {
		return URI.from({ scheme: Schemas.file, path });
	}

	async function setup(disposables: DisposableStore): Promise<{
		services: IParadisRemoteTransferServices;
		fileService: FileService;
		dialogService: TestDialogService;
		fileDialogService: FakeFileDialogService;
		notificationService: RecordingNotificationService;
	}> {
		const fileService = await createFileService(disposables);
		const dialogService = new TestDialogService();
		const fileDialogService = new FakeFileDialogService();
		const notificationService = new RecordingNotificationService();
		const services: IParadisRemoteTransferServices = {
			dialogService,
			fileDialogService,
			fileService,
			notificationService,
			progressService: new FakeProgressService(),
		};
		return { services, fileService, dialogService, fileDialogService, notificationService };
	}

	suite('paradisSaveToMachine', () => {
		test('copies a file straight through when the target does not exist', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService, fileDialogService } = await setup(disposables);
			await fileService.writeFile(uri('/remote/report.txt'), VSBuffer.fromString('hello'));
			fileDialogService.saveResult = uri('/home/user/report.txt');

			await paradisSaveToMachine(services, { uri: uri('/remote/report.txt'), name: 'report.txt', isDirectory: false }, uri('/home/user'));

			const copied = await fileService.readFile(uri('/home/user/report.txt'));
			strictEqual(copied.value.toString(), 'hello');
		});

		test('copies a directory to <picked folder>/<name>', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService, fileDialogService } = await setup(disposables);
			await fileService.createFolder(uri('/remote/space'));
			await fileService.writeFile(uri('/remote/space/a.txt'), VSBuffer.fromString('a'));
			fileDialogService.openDialogResult = [uri('/home/user')];

			await paradisSaveToMachine(services, { uri: uri('/remote/space'), name: 'space', isDirectory: true }, uri('/home/user'));

			const copied = await fileService.readFile(joinPath(uri('/home/user'), 'space', 'a.txt'));
			strictEqual(copied.value.toString(), 'a');
		});

		test('does nothing when the picker is dismissed', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService, fileDialogService } = await setup(disposables);
			await fileService.writeFile(uri('/remote/report.txt'), VSBuffer.fromString('hello'));
			fileDialogService.saveResult = undefined;

			await paradisSaveToMachine(services, { uri: uri('/remote/report.txt'), name: 'report.txt', isDirectory: false }, uri('/home/user'));

			strictEqual(await fileService.exists(uri('/home/user/report.txt')), false);
		});

		test('asks before replacing an existing file, and skips the copy when declined', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService, fileDialogService, dialogService } = await setup(disposables);
			await fileService.writeFile(uri('/remote/report.txt'), VSBuffer.fromString('new'));
			await fileService.writeFile(uri('/home/user/report.txt'), VSBuffer.fromString('old'));
			fileDialogService.saveResult = uri('/home/user/report.txt');
			dialogService.setConfirmResult({ confirmed: false });

			await paradisSaveToMachine(services, { uri: uri('/remote/report.txt'), name: 'report.txt', isDirectory: false }, uri('/home/user'));

			const untouched = await fileService.readFile(uri('/home/user/report.txt'));
			strictEqual(untouched.value.toString(), 'old');
		});

		test('replaces an existing file once the user confirms', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService, fileDialogService, dialogService } = await setup(disposables);
			await fileService.writeFile(uri('/remote/report.txt'), VSBuffer.fromString('new'));
			await fileService.writeFile(uri('/home/user/report.txt'), VSBuffer.fromString('old'));
			fileDialogService.saveResult = uri('/home/user/report.txt');
			dialogService.setConfirmResult({ confirmed: true });

			await paradisSaveToMachine(services, { uri: uri('/remote/report.txt'), name: 'report.txt', isDirectory: false }, uri('/home/user'));

			const replaced = await fileService.readFile(uri('/home/user/report.txt'));
			strictEqual(replaced.value.toString(), 'new');
		});
	});

	suite('paradisSendToHost', () => {
		test('copies to <picked remote folder>/<name>', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService, fileDialogService } = await setup(disposables);
			await fileService.writeFile(uri('/home/user/local.txt'), VSBuffer.fromString('local'));
			fileDialogService.openDialogResult = [uri('/remote/target')];

			await paradisSendToHost(services, { uri: uri('/home/user/local.txt'), name: 'local.txt', isDirectory: false }, uri('/remote/home'));

			const copied = await fileService.readFile(uri('/remote/target/local.txt'));
			strictEqual(copied.value.toString(), 'local');
		});

		test('does nothing when no folder is picked', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService, fileDialogService } = await setup(disposables);
			await fileService.writeFile(uri('/home/user/local.txt'), VSBuffer.fromString('local'));
			fileDialogService.openDialogResult = undefined;

			await paradisSendToHost(services, { uri: uri('/home/user/local.txt'), name: 'local.txt', isDirectory: false }, uri('/remote/home'));

			strictEqual(await fileService.exists(uri('/remote/target/local.txt')), false);
		});
	});

	suite('paradisCopyToDirectory', () => {
		test('copies every source with no confirmation when nothing conflicts', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService } = await setup(disposables);
			await fileService.writeFile(uri('/src/a.txt'), VSBuffer.fromString('a'));
			await fileService.writeFile(uri('/src/b.txt'), VSBuffer.fromString('b'));
			await fileService.createFolder(uri('/dst'));

			await paradisCopyToDirectory(services, [
				{ uri: uri('/src/a.txt'), name: 'a.txt', isDirectory: false },
				{ uri: uri('/src/b.txt'), name: 'b.txt', isDirectory: false },
			], uri('/dst'));

			strictEqual((await fileService.readFile(uri('/dst/a.txt'))).value.toString(), 'a');
			strictEqual((await fileService.readFile(uri('/dst/b.txt'))).value.toString(), 'b');
		});

		test('confirms once for every conflicting name and aborts the whole batch when declined', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService, dialogService } = await setup(disposables);
			await fileService.writeFile(uri('/src/a.txt'), VSBuffer.fromString('new-a'));
			await fileService.writeFile(uri('/src/b.txt'), VSBuffer.fromString('new-b'));
			await fileService.writeFile(uri('/dst/a.txt'), VSBuffer.fromString('old-a'));
			dialogService.setConfirmResult({ confirmed: false });

			await paradisCopyToDirectory(services, [
				{ uri: uri('/src/a.txt'), name: 'a.txt', isDirectory: false },
				{ uri: uri('/src/b.txt'), name: 'b.txt', isDirectory: false },
			], uri('/dst'));

			strictEqual((await fileService.readFile(uri('/dst/a.txt'))).value.toString(), 'old-a', 'declining must not touch the conflicting file');
			strictEqual(await fileService.exists(uri('/dst/b.txt')), false, 'declining must abort the whole batch, not just the conflicting entry');
		});

		test('keeps copying the rest when one source is missing, and warns with the failed name', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileService, notificationService } = await setup(disposables);
			await fileService.writeFile(uri('/src/ok.txt'), VSBuffer.fromString('ok'));
			// /src/missing.txt を書かないことで、その1件だけ copy が失敗する状況を作る

			await paradisCopyToDirectory(services, [
				{ uri: uri('/src/missing.txt'), name: 'missing.txt', isDirectory: false },
				{ uri: uri('/src/ok.txt'), name: 'ok.txt', isDirectory: false },
			], uri('/dst'));

			strictEqual((await fileService.readFile(uri('/dst/ok.txt'))).value.toString(), 'ok', 'a failing entry must not stop the remaining ones');
			strictEqual(notificationService.notifications.length, 1);
			ok(String(notificationService.notifications[0].message).includes('missing.txt'), 'the warning should name the failed entry');
			strictEqual(notificationService.errors.length, 0, 'partial failure must warn, not use the all-failed error path');
		});

		test('surfaces the underlying error when every source fails', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, notificationService } = await setup(disposables);
			// どちらの src も書いていないので両方とも exists()=false から copy が ENOENT で失敗する

			await paradisCopyToDirectory(services, [
				{ uri: uri('/src/gone-1.txt'), name: 'gone-1.txt', isDirectory: false },
				{ uri: uri('/src/gone-2.txt'), name: 'gone-2.txt', isDirectory: false },
			], uri('/dst'));

			// TestNotificationService.error() 自体が内部で notify() を呼ぶ実装なので、区別すべきは
			// 「error() 経路(=生のエラーをそのまま出す)を通ったか」であって notify() の呼び出し回数ではない。
			strictEqual(notificationService.errors.length, 1, 'total failure must report the raw error once, not a generic count message');
		});

		test('does nothing for an empty source list', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, notificationService } = await setup(disposables);

			await paradisCopyToDirectory(services, [], uri('/dst'));

			strictEqual(notificationService.errors.length, 0);
			strictEqual(notificationService.notifications.length, 0);
		});
	});

	suite('paradisPickLocalFiles', () => {
		test('returns the picked files', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileDialogService } = await setup(disposables);
			fileDialogService.openDialogResult = [uri('/home/user/a.txt'), uri('/home/user/b.txt')];

			const result = await paradisPickLocalFiles(services, uri('/home/user'));

			deepStrictEqual(result.map(u => u.path), ['/home/user/a.txt', '/home/user/b.txt']);
		});

		test('returns an empty array when the picker is dismissed', async () => {
			const disposables = store.add(new DisposableStore());
			const { services, fileDialogService } = await setup(disposables);
			fileDialogService.openDialogResult = undefined;

			const result = await paradisPickLocalFiles(services, uri('/home/user'));

			deepStrictEqual(result, []);
		});
	});
});
