/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタの下書きを、保存せずに終了・再読み込み・ウィンドウを閉じるときに確かめる。
//
// 下書きはメモリの設定の層にしか無く、ウィンドウが終わると消える。タブを閉じるときの確認
// （`ParadisThemeColorEditorInput.confirm`）はあるが、終了のときに未保存を確かめる upstream の仕組み
// （`workingCopyBackupTracker`）は working copy しか見ないので、ここで終了を止めて尋ねる。
// working copy に載せないのは、終了や再読み込みのときに upstream が確認の代わりにバックアップを取り
// （hot exit）、確認が出ないまま下書きが消えるため（下書きをバックアップから戻す仕組みは無い）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IParadisThemeColorDraftService } from './paradisThemeColorDraftService.js';

/**
 * 未保存の下書きがあれば尋ね、終了を止めるなら true を返す。
 *
 * 「保存」は保存できたときだけ進む（失敗や、保存の途中の確認で取り消されたら止める）。
 * 「保存しない」は下書きを捨てて進む。取り消し（Esc を含む）は止める。
 */
export async function paradisConfirmThemeColorDraftsBeforeShutdown(
	draftService: Pick<IParadisThemeColorDraftService, 'dirtyCount' | 'save'>,
	dialogService: Pick<IDialogService, 'prompt'>,
	/** 保存に失敗したことを伝える（タブの「保存」と同じ文面）。 */
	reportSaveError: (message: string) => void,
): Promise<boolean> {
	const count = draftService.dirtyCount;
	if (count === 0) {
		return false;
	}
	const { result } = await dialogService.prompt<'save' | 'discard' | 'cancel'>({
		type: 'warning',
		message: localize('paradis.themeColors.shutdownConfirm', "テーマの色の変更（{0} 件）を保存しますか？", count),
		detail: localize('paradis.themeColors.shutdownConfirmDetail', "保存しないと、変更は失われます。"),
		buttons: [
			{ label: localize('paradis.themeColors.shutdownSave', "保存"), run: () => 'save' },
			{ label: localize('paradis.themeColors.shutdownDontSave', "保存しない"), run: () => 'discard' },
		],
		cancelButton: { run: () => 'cancel' },
	});
	switch (result) {
		case 'save':
			try {
				return !(await draftService.save());
			} catch (error) {
				reportSaveError(localize('paradis.themeColors.shutdownSaveFailed', "テーマの色を保存できませんでした: {0}", error instanceof Error ? error.message : String(error)));
				return true;
			}
		case 'discard':
			return false;
		default:
			return true;
	}
}

class ParadisThemeColorShutdownGuard extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.themeColorShutdownGuard';

	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@IParadisThemeColorDraftService draftService: IParadisThemeColorDraftService,
		@IDialogService dialogService: IDialogService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		this._register(lifecycleService.onBeforeShutdown(event => {
			// 下書きが無ければ待たせない（同期で答える）。
			if (draftService.dirtyCount === 0) {
				return;
			}
			event.veto(paradisConfirmThemeColorDraftsBeforeShutdown(draftService, dialogService, message => notificationService.error(message)), 'veto.paradisThemeColorDrafts');
		}));
	}
}

registerWorkbenchContribution2(ParadisThemeColorShutdownGuard.ID, ParadisThemeColorShutdownGuard, WorkbenchPhase.AfterRestored);
