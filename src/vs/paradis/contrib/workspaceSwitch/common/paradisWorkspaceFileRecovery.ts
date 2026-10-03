/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { equals } from '../../../../base/common/objects.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { IExtUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStoredWorkspaceFolder, toWorkspaceFolders } from '../../../../platform/workspaces/common/workspaces.js';
import { ITextFileService, TextFileEditorModelState } from '../../../../workbench/services/textfile/common/textfiles.js';

/** `paradisRecoverWorkspaceFileAfterFailedSave` の結果。計測とテストのために返す。 */
export const enum ParadisWorkspaceFileRecoveryResult {
	/** 保存に失敗したモデルが無い（普通の切り替えの失敗）。何もしていない。 */
	NotNeeded = 'not-needed',
	/** ディスクの中身が正常だったので、モデルの未保存の変更を捨ててディスクから読み直した。 */
	Reverted = 'reverted',
	/** ディスクの中身が壊れていたので、モデルの中身で上書き保存した。 */
	Overwritten = 'overwritten',
	/**
	 * 直さなかった・直せなかった（容量がまだ無い、利用者の手の編集が混ざっている、競合でディスクも
	 * 壊れている等）。モデルはそのまま残している。
	 */
	Failed = 'failed',
}

interface IParsedWorkspaceFile {
	readonly folders: IStoredWorkspaceFolder[];
	/** `folders` 以外の中身。手の編集が混ざっていないかの比較に使う。 */
	readonly rest: Record<string, unknown>;
}

function parseWorkspaceFile(content: string | undefined): IParsedWorkspaceFile | undefined {
	if (content === undefined) {
		return undefined;
	}
	const errors: ParseError[] = [];
	const value = parse(content, errors, { allowTrailingComma: true, allowEmptyContent: false });
	if (errors.length > 0 || typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { folders, ...rest } = value as { folders?: unknown };
	return Array.isArray(folders) ? { folders: folders as IStoredWorkspaceFolder[], rest } : undefined;
}

/** 巻き戻しに要る、今のワークスペースの姿。 */
export interface IParadisWorkspaceFileRecoveryContext {
	readonly configPath: URI | undefined;
	/** 巻き戻した後の folders（`contextService.getWorkspace().folders` の URI）。 */
	readonly currentFolders: readonly URI[];
	/** URI の同一性サービスの比較器（`IUriIdentityService.extUri`）。 */
	readonly extUri: IExtUri;
}

/**
 * スペースの切り替えを巻き戻すときに、保存に失敗したワークスペースのファイル
 * （`para.code-workspace`）のモデルを正常な状態へ戻す。
 *
 * **なぜ要るか。** ディスク満杯（ENOSPC）などで保存が失敗すると、upstream の
 * `TextFileEditorModel` は中身を守るためにモデルを未保存（エラー、書き込み途中で変わった
 * 場合は競合）のまま残す。`JSONEditingService` は次の切り替えでも同じモデルへ編集を足して
 * 保存するので、未保存のままだと容量が空いた後も保存が失敗し続ける。
 *
 * **捨ててよいものしか捨てない。** 判定は次のとおり。
 *
 * | ディスクの中身 | モデルの状態 | すること |
 * |---|---|---|
 * | 正常、モデルとの差が `folders` だけ | エラー・競合 | 未保存の変更（失敗した切り替えの書き換え）を捨てて読み直す |
 * | 正常、`folders` 以外にも差がある | エラー・競合 | 何もしない（利用者の手の編集を捨てない） |
 * | 壊れている | エラーのみ | モデルの `folders` が今の folders と一致するときだけ、モデルの中身で上書きする |
 * | 壊れている | 競合 | 何もしない（ディスクを書いたのが自分とは限らない） |
 *
 * ディスクが壊れているとき（書き込みの途中で切り詰められた等）、正しい中身はモデルにしか
 * 残っていない。upstream が未保存のまま残すのもこのため（`textFileEditorModel.ts` の
 * `handleSaveError`）なので、読み直しはしない。
 *
 * 単に未保存なだけのモデル（利用者がファイルを開いて手で編集している途中）は触らない。
 * 投げない。直さなかったときも `Failed` を返すだけ（巻き戻しの本流を止めないため）。
 */
export async function paradisRecoverWorkspaceFileAfterFailedSave(
	context: IParadisWorkspaceFileRecoveryContext,
	textFileService: Pick<ITextFileService, 'files'>,
	fileService: Pick<IFileService, 'readFile'>,
	logService: ILogService,
): Promise<ParadisWorkspaceFileRecoveryResult> {
	const { configPath } = context;
	if (configPath === undefined) {
		return ParadisWorkspaceFileRecoveryResult.NotNeeded;
	}
	const model = textFileService.files.get(configPath);
	const inConflict = model?.hasState(TextFileEditorModelState.CONFLICT) === true;
	const inError = model?.hasState(TextFileEditorModelState.ERROR) === true;
	if (model === undefined || !(inError || inConflict)) {
		return ParadisWorkspaceFileRecoveryResult.NotNeeded;
	}
	try {
		let diskContent: string | undefined;
		try {
			diskContent = (await fileService.readFile(configPath, { atomic: true })).value.toString();
		} catch (error) {
			logService.warn('[ParadisWorkspaceSwitch] Could not read the workspace file while recovering a failed save', error);
		}
		const disk = parseWorkspaceFile(diskContent);
		const unsaved = parseWorkspaceFile(model.textEditorModel?.getValue());
		if (disk !== undefined) {
			if (unsaved === undefined || !equals(disk.rest, unsaved.rest)) {
				logService.warn('[ParadisWorkspaceSwitch] The unsaved workspace file differs from disk beyond its folders; leaving it for the user');
				return ParadisWorkspaceFileRecoveryResult.Failed;
			}
			await model.revert({ soft: false });
			logService.info('[ParadisWorkspaceSwitch] Reloaded the workspace file from disk after a failed save');
			return model.isDirty() ? ParadisWorkspaceFileRecoveryResult.Failed : ParadisWorkspaceFileRecoveryResult.Reverted;
		}
		if (inConflict) {
			logService.warn('[ParadisWorkspaceSwitch] The workspace file is damaged on disk and its save is in conflict; not overwriting it');
			return ParadisWorkspaceFileRecoveryResult.Failed;
		}
		if (unsaved === undefined || !foldersMatch(unsaved.folders, configPath, context)) {
			logService.error('[ParadisWorkspaceSwitch] The workspace file is damaged on disk and the unsaved model does not describe the current folders; leaving it as is');
			return ParadisWorkspaceFileRecoveryResult.Failed;
		}
		await model.save({ ignoreModifiedSince: true, skipSaveParticipants: true });
		if (model.isDirty()) {
			return ParadisWorkspaceFileRecoveryResult.Failed;
		}
		logService.info('[ParadisWorkspaceSwitch] Rewrote the damaged workspace file from the unsaved model');
		return ParadisWorkspaceFileRecoveryResult.Overwritten;
	} catch (error) {
		logService.error('[ParadisWorkspaceSwitch] Failed to recover the workspace file after a failed save', error);
		return ParadisWorkspaceFileRecoveryResult.Failed;
	}
}

/** モデルに書かれた folders が、巻き戻した後の folders と同じ並びで一致するか。 */
function foldersMatch(stored: IStoredWorkspaceFolder[], configPath: URI, context: IParadisWorkspaceFileRecoveryContext): boolean {
	const resolved = toWorkspaceFolders(stored, configPath, context.extUri);
	return resolved.length === context.currentFolders.length
		&& resolved.every((folder, index) => context.extUri.isEqual(folder.uri, context.currentFolders[index]));
}
