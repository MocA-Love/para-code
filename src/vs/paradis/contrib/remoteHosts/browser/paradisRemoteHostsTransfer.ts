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
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';

/** 転送処理に必要なサービスの束。ビューが注入したものをそのまま渡す。 */
export interface IParadisRemoteTransferServices {
	readonly dialogService: IDialogService;
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
 * 上書き確認。fileImportExport.ts の getFileOverwriteConfirm と同じ趣旨。
 * fileService.copy は overwrite 指定時に既存ターゲットを再帰的に削除してから
 * 書き込むため、フォルダーの転送で無確認にすると中身が丸ごと失われる。必ず通すこと。
 */
async function confirmOverwrite(services: IParadisRemoteTransferServices, names: readonly string[]): Promise<boolean> {
	const message = names.length === 1
		// allow-any-unicode-next-line
		? localize('paraRemoteHosts.confirmOverwrite', "{0} は転送先に既に存在します。置き換えますか?", names[0])
		// allow-any-unicode-next-line
		: localize('paraRemoteHosts.confirmOverwriteMany', "{0} 件の項目が転送先に既に存在します。置き換えますか?", names.length);
	const { confirmed } = await services.dialogService.confirm({
		type: 'warning',
		message,
		// 「何が置き換えられるのか」が分からないと確認として機能しないため、名前も出す
		detail: names.join('\n') + '\n'
			+ localize('paraRemoteHosts.overwriteIrreversible', "この操作は元に戻せません。既存の内容は失われます。"),
		primaryButton: localize('paraRemoteHosts.replaceButton', "置き換える"),
	});
	return confirmed;
}

async function copyWithProgress(
	services: IParadisRemoteTransferServices,
	source: IParadisRemoteTransferSource,
	target: URI,
	overwrite: boolean,
): Promise<void> {
	await services.progressService.withProgress(
		{
			location: ProgressLocation.Window,
			title: localize('paraRemoteHosts.transferring', "{0} を転送しています…", source.name),
		},
		() => services.fileService.copy(source.uri, target, overwrite),
	);
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
	localUserHome: URI,
): Promise<void> {
	let target: URI | undefined;
	if (source.isDirectory) {
		const folders = await services.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: localUserHome,
			availableFileSystems: [Schemas.file],
			title: localize('paraRemoteHosts.saveFolderTitle', "保存先フォルダーを選択"),
		});
		target = folders?.length ? joinPath(folders[0], basename(source.uri)) : undefined;
	} else {
		target = await services.fileDialogService.pickFileToSave(
			joinPath(localUserHome, basename(source.uri)),
			[Schemas.file],
		);
	}
	if (!target) {
		return;
	}
	await paradisCopyEntry(services, source, target);
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
		title: localize('paraRemoteHosts.sendFolderTitle', "転送先フォルダーを選択"),
	});
	if (!folders?.length) {
		return;
	}
	await paradisCopyEntry(services, source, joinPath(folders[0], basename(source.uri)));
}

/** 単一項目のコピー。上書きが必要なときだけ確認ダイアログを出す。エラーは投げて戻す (ビューが通知する)。 */
async function paradisCopyEntry(
	services: IParadisRemoteTransferServices,
	source: IParadisRemoteTransferSource,
	target: URI,
): Promise<void> {
	let overwrite = false;
	if (await services.fileService.exists(target)) {
		const confirmed = await confirmOverwrite(services, [basename(target)]);
		if (!confirmed) {
			return;
		}
		overwrite = true;
	}
	await copyWithProgress(services, source, target, overwrite);
}

/**
 * ドラッグ&ドロップ・まとめアップロード用。複数項目をフォルダーへコピーする。
 *
 * 上書きが必要なときは最初に一括確認する (項目ごとに出すと連続ダイアログになるため)。
 * 1件が失敗しても残りを続け、最後に失敗した件数を警告する。
 */
export async function paradisCopyToDirectory(
	services: IParadisRemoteTransferServices,
	sources: readonly IParadisRemoteTransferSource[],
	targetDir: URI,
): Promise<void> {
	if (!sources.length) {
		return;
	}
	const targets = sources.map(source => joinPath(targetDir, basename(source.uri)));

	// 既存チェック → 一括上書き確認。未確認なら overwrite=false なので競合時は安全側で失敗する
	const existingNames: string[] = [];
	for (const target of targets) {
		if (await services.fileService.exists(target)) {
			existingNames.push(basename(target));
		}
	}
	let overwrite = false;
	if (existingNames.length) {
		overwrite = await confirmOverwrite(services, existingNames);
		if (!overwrite) {
			return;
		}
	}

	const failedNames: string[] = [];
	let firstError: Error | string | undefined;
	try {
		await services.progressService.withProgress(
			{
				location: ProgressLocation.Window,
				title: sources.length === 1
					? localize('paraRemoteHosts.transferring', "{0} を転送しています…", sources[0].name)
					: localize('paraRemoteHosts.transferringMany', "{0} 件を転送しています…", sources.length),
			},
			async () => {
				for (let index = 0; index < sources.length; index++) {
					try {
						await services.fileService.copy(sources[index].uri, targets[index], overwrite);
					} catch (error) {
						failedNames.push(sources[index].name);
						firstError ??= error instanceof Error ? error : String(error);
					}
				}
			},
		);
	} finally {
		if (failedNames.length === sources.length && firstError !== undefined) {
			// 全件失敗。原因 (SSH 切断・権限など) を握りつぶさないよう生のエラーをそのまま出す
			services.notificationService.error(firstError);
		} else if (failedNames.length) {
			services.notificationService.notify({
				severity: Severity.Warning,
				message: localize('paraRemoteHosts.someTransfersFailed', "{0} 件の転送に失敗しました ({1})", failedNames.length, failedNames.join(', ')),
			});
		}
	}
}

/** 「ローカルからアップロード…」の手前半分。ローカルのファイルを選ばせて URI を返す。 */
export async function paradisPickLocalFiles(
	services: IParadisRemoteTransferServices,
	localUserHome: URI,
): Promise<readonly URI[]> {
	const files = await services.fileDialogService.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: true,
		defaultUri: localUserHome,
		availableFileSystems: [Schemas.file],
		title: localize('paraRemoteHosts.pickUploadTitle', "アップロードするファイルを選択"),
	});
	return files ?? [];
}
