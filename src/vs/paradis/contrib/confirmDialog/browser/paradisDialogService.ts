/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork の確認のサービス（Q617）。本家の `IDialogService.confirm` と同じ形（IConfirmation → IConfirmationResult）で受け、
// UI キットの確認（paradisConfirmDialog.ts）を出す。本家の confirm は macOS で window.dialogStyle が既定の native だと
// OS のシートで出るので、fork の確認はここを通して Para Code のほかの画面と同じ見た目にそろえる。
// src/vs/paradis の中で本家の `dialogService.confirm` を呼ぶと eslint が止める（.eslint-plugin-local/code-paradis-no-upstream-confirm.ts）。
//
// 本家との違い:
//  - `destructive: true`（消す・破棄・上書きなど取り消せない操作）では、実行のボタンを危険の色にし、初めのフォーカスを
//    「キャンセル」に置く。Enter では実行しない（実行は Tab で移るかマウスで押す）。
//  - 種類（`type`）の印は出さない（キットの S 段は問いの太字で示す）。
//  - Markdown の補足は平文にして出す（fork の確認は補足を文字列で渡している）。
// 呼び出し側がこのファイルを import すると下の registerSingleton も読まれるので、どのウィンドウの入口からでも解決できる。

import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { IConfirmation, IConfirmationResult } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { localize } from '../../../../nls.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { openParadisConfirmDialog } from './paradisConfirmDialog.js';

/** fork の確認。本家の {@link IConfirmation} に、取り消せない操作の印を足したもの。 */
export interface IParadisConfirmation extends IConfirmation {
	/** 取り消せない操作（削除・破棄・強制・上書き・作り直し・解除）。既定のボタンを「キャンセル」にし、実行を危険の色にする。 */
	readonly destructive?: boolean;
}

export const IParadisDialogService = createDecorator<IParadisDialogService>('paradisDialogService');

/** fork の確認のサービス。本家の `IDialogService.confirm` の代わりに使う。 */
export interface IParadisDialogService {
	readonly _serviceBrand: undefined;

	/** 確認を出す。実行のボタンを押したら `confirmed: true`。チェックを出したときは、取消でも `checkboxChecked` を返す。 */
	confirm(confirmation: IParadisConfirmation): Promise<IConfirmationResult>;
}

export class ParadisDialogService implements IParadisDialogService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IHostService private readonly hostService: IHostService,
	) { }

	async confirm(confirmation: IParadisConfirmation): Promise<IConfirmationResult> {
		const detail = confirmation.detail === undefined ? undefined : typeof confirmation.detail === 'string' ? confirmation.detail : renderAsPlaintext(confirmation.detail);
		const { index, checkboxChecked } = await openParadisConfirmDialog({ layoutService: this.layoutService, keybindingService: this.keybindingService, hostService: this.hostService }, {
			message: confirmation.message,
			detail: detail || undefined,
			buttons: [{
				// 本家の既定（dialogs.ts の getConfirmationButtons の「はい」）に合わせる
				// allow-any-unicode-next-line
				label: confirmation.primaryButton ?? localize('paradis.dialogService.yes', "はい"),
				kind: confirmation.destructive ? 'danger' : 'primary',
				run: () => true,
			}],
			cancelLabel: confirmation.cancelButton,
			checkbox: confirmation.checkbox,
			focusCancel: confirmation.destructive,
			token: confirmation.token,
		});
		return { confirmed: index === 0, checkboxChecked };
	}
}

registerSingleton(IParadisDialogService, ParadisDialogService, InstantiationType.Delayed);
