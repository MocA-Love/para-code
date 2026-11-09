/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エクスプローラーの「ダウンロード...」（upstream の `explorer.download`）を、SSH の窓で複数を選んだときだけ
// まとめてダウンロードにする。upstream の FileDownload は 1 件ごとに保存先を聞くので、選んだ件数の分だけダイアログが出る。
//
// upstream のファイルは変えずに、同じ ID のコマンドを後から登録し直して差し替える（CommandsRegistry は後から登録した
// ものを使う）。upstream の登録が必ず先に済むよう、fileActions.js から ID を import している。
// 1 件だけのとき・接続先以外のファイルが混じるときは、upstream の処理（FileDownload）をそのまま呼ぶ。
//
// 複数のときは、手元のフォルダーを 1 回だけ選んでもらい、ファイル転送の待ち行列へ積む。同じ名前の確認
// （上書き・名前を変える・飛ばす・すべて取り消し）、フォルダーの中身ごとの転送、取り消しは待ち行列が持つ。
// 選んだフォルダーの外を読まないよう、フォルダーの中のリンクは辿らない。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { DOWNLOAD_COMMAND_ID } from '../../../../workbench/contrib/files/browser/fileActions.js';
import { FileDownload } from '../../../../workbench/contrib/files/browser/fileImportExport.js';
import { IExplorerService } from '../../../../workbench/contrib/files/browser/files.js';
import { IParadisExplorerDownloadItem, paradisPlanBatchDownload, paradisSummarizeBatchDownload, paradisUsesBatchDownload } from '../common/paradisExplorerDownload.js';
import { PARADIS_FILE_TRANSFER_OPEN_COMMAND_ID } from '../common/paradisFileTransfer.js';
import { IParadisFileTransferService } from './paradisFileTransferService.js';

/** まとめてダウンロードで前回選んだ保存先のフォルダー（upstream の 1 件ずつの記憶とは別に持つ）。 */
const PARADIS_BATCH_DOWNLOAD_PATH_KEY = 'paradis.explorer.batchDownloadPath';

export class ParadisBatchDownload {

	constructor(
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IStorageService private readonly storageService: IStorageService,
		@IParadisFileTransferService private readonly fileTransferService: IParadisFileTransferService,
		@IProgressService private readonly progressService: IProgressService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
	) { }

	async download(items: readonly IParadisExplorerDownloadItem[]): Promise<void> {
		const sources = paradisPlanBatchDownload(items);
		const remembered = this.storageService.get(PARADIS_BATCH_DOWNLOAD_PATH_KEY, StorageScope.APPLICATION);
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('paradis.explorerDownload.title', "{0} 件のダウンロード先のフォルダーを選択", sources.length),
			openLabel: localize('paradis.explorerDownload.openLabel', "ここにダウンロード"),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			// 手元のフォルダーを OS のダイアログで選ぶ（接続先の簡易ダイアログにしない）
			availableFileSystems: [Schemas.file],
			defaultUri: remembered ? URI.file(remembered) : await this.fileDialogService.defaultFolderPath(Schemas.file),
		});
		const folder = picked?.[0];
		if (!folder) {
			return;
		}
		this.storageService.store(PARADIS_BATCH_DOWNLOAD_PATH_KEY, folder.fsPath, StorageScope.APPLICATION, StorageTarget.MACHINE);

		// 同じ名前があれば、ここで 1 件ずつ（または「以後すべてに適用」で）聞かれる。「すべて取り消し」なら何も積まない
		const ids = await this.fileTransferService.transferWithIds(sources, folder, 'local', { skipLinksInFolders: true });
		if (!ids.length) {
			return;
		}
		const result = await this.track(ids);
		// 利用者が取り消したときは何も出さない（失敗があればそれだけは知らせる）
		if (result.failed || (result.skipped && !result.cancelled)) {
			const message = result.failed
				? localize('paradis.explorerDownload.failed', "{0} 件中 {1} 件をダウンロードできませんでした。理由とやり直しはファイル転送の画面で確かめられます。", result.total, result.failed)
				: localize('paradis.explorerDownload.skipped', "ダウンロードしました。フォルダーの中のリンクや読めないファイルなど {0} 件は写していません。", result.skipped);
			this.notificationService.prompt(result.failed ? Severity.Warning : Severity.Info, message, [{
				label: localize('paradis.explorerDownload.openTransfer', "ファイル転送を開く"),
				run: () => this.commandService.executeCommand(PARADIS_FILE_TRANSFER_OPEN_COMMAND_ID, folder),
			}]);
		}
	}

	/** 積んだ項目が全部終わるまで、1 つの通知で進み具合を見せる。取り消すと、積んだ項目だけを取り消す。 */
	private track(ids: readonly number[]) {
		const queue = this.fileTransferService.queue;
		const summarize = () => paradisSummarizeBatchDownload(ids, queue.items);
		return this.progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('paradis.explorerDownload.progressTitle', "ダウンロード中"),
			cancellable: true,
		}, progress => new Promise<ReturnType<typeof summarize>>(resolve => {
			const disposables = new DisposableStore();
			let reported = 0;
			const update = () => {
				const summary = summarize();
				const increment = summary.percent - reported;
				reported = Math.max(reported, summary.percent);
				progress.report({
					message: localize('paradis.explorerDownload.progressMessage', "{0} / {1} 件", summary.finished, summary.total),
					increment: increment > 0 ? increment : undefined,
				});
				if (summary.finished >= summary.total) {
					disposables.dispose();
					resolve(summary);
				}
			};
			disposables.add(queue.onDidChange(update));
			update();
		}), () => {
			for (const id of ids) {
				queue.cancel(id);
			}
		});
	}
}

/** `explorer.download` の差し替え。upstream の downloadFileHandler と同じ選び方をし、複数のときだけまとめる。 */
export async function paradisExplorerDownloadHandler(accessor: ServicesAccessor): Promise<void> {
	const explorerService = accessor.get(IExplorerService);
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);

	const context = explorerService.getContext(true);
	const explorerItems = context.length ? context : explorerService.roots;

	try {
		if (paradisUsesBatchDownload(explorerItems)) {
			await instantiationService.createInstance(ParadisBatchDownload).download(explorerItems);
		} else {
			await instantiationService.createInstance(FileDownload).download(explorerItems);
		}
	} catch (error) {
		notificationService.error(error);

		throw error;
	}
}

CommandsRegistry.registerCommand({
	id: DOWNLOAD_COMMAND_ID,
	handler: paradisExplorerDownloadHandler,
});
