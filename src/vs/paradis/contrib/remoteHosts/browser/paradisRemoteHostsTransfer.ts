/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';

/** 転送処理に必要なサービスの束。ビューが注入したものをそのまま渡す。 */
export interface IParadisRemoteTransferServices {
	readonly fileDialogService: IFileDialogService;
	readonly fileService: IFileService;
	readonly notificationService: INotificationService;
	readonly progressService: IProgressService;
}

/** 転送対象。ツリー上で選ばれた1件 (ファイル / フォルダ / スペース)。 */
export interface IParadisRemoteTransferSource {
	readonly uri: URI;
	readonly name: string;
	readonly isDirectory: boolean;
}

/**
 * 接続先 (または手元) から「このマシン」へ保存する。
 *
 * ファイルは保存ダイアログ、フォルダーは保存先フォルダーの選択後に
 * <選択先>/<名前> へまるごとコピーする。コピー自体は IFileService.copy に任せる。
 * provider 越し (vscode-remote ↔ file) の場合はストリーミングで流れるので、
 * 大きなファイルでもバッファへ一括読み込みはしない。
 */
export async function paradisSaveToMachine(
	services: IParadisRemoteTransferServices,
	source: IParadisRemoteTransferSource,
	localUserHome: URI | undefined,
): Promise<void> {
	const defaultDir = localUserHome ?? uriForLocalRoot();
	let target: URI | undefined;
	if (source.isDirectory) {
		const folders = await services.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: defaultDir,
			availableFileSystems: [Schemas.file],
			title: localize('paradisRemoteHosts.saveFolderTitle', "保存先フォルダーを選択"),
		});
		target = folders?.length ? joinPath(folders[0], basename(source.uri)) : undefined;
	} else {
		target = await services.fileDialogService.pickFileToSave(
			joinPath(defaultDir, basename(source.uri)),
			[Schemas.file],
		);
	}
	if (!target) {
		return;
	}
	await runTransfer(services, source, target, /* overwrite */ true);
}

/**
 * 「このマシン」から接続先ホストへ送る。
 *
 * 転送先フォルダーを接続先側のピッカー (SimpleFileDialog) で選んでもらい、
 * <選択先>/<名前> へコピーする。availableFileSystems を vscode-remote に限定することで、
 * ネイティブピッカーではなく接続先を辿るリモートピッカーが開く。
 */
export async function paradisSendToHost(
	services: IParadisRemoteTransferServices,
	source: IParadisRemoteTransferSource,
	remoteDefaultDir: URI | undefined,
): Promise<void> {
	const folders = await services.fileDialogService.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		defaultUri: remoteDefaultDir,
		availableFileSystems: [Schemas.vscodeRemote],
		title: localize('paradisRemoteHosts.sendFolderTitle', "転送先フォルダーを選択"),
	});
	if (!folders?.length) {
		return;
	}
	const target = joinPath(folders[0], basename(source.uri));
	await runTransfer(services, source, target, /* overwrite */ true);
}

/**
 * ドラッグ&ドロップで複数項目をフォルダーへコピーする。
 * 上書きは許可する (ドロップは明示的な配置操作なので、同名ファイルを意図して置くケースが多い)。
 */
export async function paradisCopyToDirectory(
	services: IParadisRemoteTransferServices,
	sources: readonly IParadisRemoteTransferSource[],
	targetDir: URI,
): Promise<void> {
	if (!sources.length) {
		return;
	}
	try {
		await services.progressService.withProgress(
			{
				location: ProgressLocation.Window,
				title: sources.length === 1
					? localize('paradisRemoteHosts.transferring', "{0} を転送しています…", sources[0].name)
					: localize('paradisRemoteHosts.transferringMany', "{0} 件を転送しています…", sources.length),
			},
			async () => {
				for (const source of sources) {
					await services.fileService.copy(source.uri, joinPath(targetDir, basename(source.uri)), /* overwrite */ true);
				}
			},
		);
	} catch (error) {
		notifyTransferError(services, error, targetDir);
	}
}

/** 「ローカルからアップロード…」の手前半分。ローカルのファイルを選ばせて URI を返す。 */
export async function paradisPickLocalFiles(
	services: IParadisRemoteTransferServices,
	localUserHome: URI | undefined,
): Promise<readonly URI[]> {
	const files = await services.fileDialogService.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: true,
		defaultUri: localUserHome,
		availableFileSystems: [Schemas.file],
		title: localize('paradisRemoteHosts.pickUploadTitle', "アップロードするファイルを選択"),
	});
	return files ?? [];
}

async function runTransfer(
	services: IParadisRemoteTransferServices,
	source: IParadisRemoteTransferSource,
	target: URI,
	overwrite: boolean,
): Promise<void> {
	try {
		await services.progressService.withProgress(
			{
				location: ProgressLocation.Window,
				title: localize('paradisRemoteHosts.transferring', "{0} を転送しています…", source.name),
			},
			() => services.fileService.copy(source.uri, target, overwrite),
		);
	} catch (error) {
		notifyTransferError(services, error, target);
	}
}

function notifyTransferError(services: IParadisRemoteTransferServices, error: unknown, target: URI): void {
	if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_MOVE_CONFLICT) {
		services.notificationService.notify({
			severity: Severity.Warning,
			message: localize('paradisRemoteHosts.targetExists', "{0} は転送先に既に存在します", basename(target)),
		});
		return;
	}
	throw error;
}

/** web ウィンドウなどローカルホームが取れない環境のための最低限の代替 (スキームのみのURI)。 */
function uriForLocalRoot(): URI {
	return URI.from({ scheme: Schemas.file, path: '/' });
}
