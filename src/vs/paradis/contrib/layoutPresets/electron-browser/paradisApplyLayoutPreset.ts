/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 適用前の確認。プリセットを適用する入り口（タブバーのポップオーバー、編集画面の「適用」、
// コマンドパレット）がすべてここを通るようにして、確認の出し方を1か所に閉じ込める。

import { getErrorMessage } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import {
	IParadisLayoutPresetDefinition,
	IParadisLayoutPresetService,
	ParadisLayoutApplyMode,
} from '../common/paradisLayoutPresets.js';

/**
 * 確認を挟んでプリセットを適用する。
 *
 * 何も開いていないスペースでは確認を出さない——「置き換える」も「追加する」も結果が同じで、
 * 選ばせる意味がないため。1つでも開いていれば、既存のタブを閉じるかどうかは取り返しがつかない
 * 差になるので必ず選ばせる。
 */
export async function paradisConfirmAndApplyLayoutPreset(accessor: ServicesAccessor, preset: IParadisLayoutPresetDefinition): Promise<void> {
	const presetService = accessor.get(IParadisLayoutPresetService);
	const dialogService = accessor.get(IDialogService);

	const openCount = presetService.openEditorCount;
	if (openCount === 0) {
		await presetService.applyPreset(preset, { mode: ParadisLayoutApplyMode.Replace });
		return;
	}

	const { result } = await dialogService.prompt<ParadisLayoutApplyMode | undefined>({
		// allow-any-unicode-next-line
		message: localize('paradis.layoutPresets.applyConfirm', "「{0}」レイアウトを適用しますか？", preset.name),
		detail: localize(
			'paradis.layoutPresets.applyConfirmDetail',
			// allow-any-unicode-next-line
			"このスペースには今 {0} 個のエディタが開いています。「置き換え」はそれらをすべて閉じてからレイアウトを作り直します（開いているターミナルは実行中のコマンドごと終了します）。「追加」は開いたまま枠を組み直します。",
			openCount,
		),
		buttons: [
			{
				// allow-any-unicode-next-line
				label: localize('paradis.layoutPresets.applyReplace', "今の構成を置き換えて適用"),
				run: () => ParadisLayoutApplyMode.Replace,
			},
			{
				// allow-any-unicode-next-line
				label: localize('paradis.layoutPresets.applyAdd', "開いたまま追加して適用"),
				run: () => ParadisLayoutApplyMode.Add,
			},
		],
		cancelButton: { run: () => undefined },
	});

	if (result) {
		await presetService.applyPreset(preset, { mode: result });
	}
}

/**
 * UI の入口（ボタン・メニュー項目）から呼ぶ用。失敗を通知へ落とす。
 *
 * 設定が別の場所で書き換えられていると保存・削除・適用は素で例外を投げる。イベントリスナーから
 * 投げっぱなしにすると unhandled rejection になって**ユーザーには何も起きていないように見える**ので、
 * 入口側で必ず受ける。
 */
export async function paradisReportLayoutPresetFailure(notificationService: INotificationService, operation: () => Promise<unknown>): Promise<void> {
	try {
		await operation();
	} catch (error) {
		notificationService.error(localize(
			'paradis.layoutPresets.operationFailed',
			// allow-any-unicode-next-line
			"レイアウトプリセットの操作に失敗しました: {0}",
			getErrorMessage(error),
		));
	}
}
