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
//  - `focusCancel: true`（エージェント・スマホ・リポジトリなど外から求められた承認）では、初めのフォーカスを「キャンセル」に
//    置き、Enter では通さない。実行のボタンの色は変えない。
//  - `destructive: true`（消す・破棄・上書きなど取り消せない操作）では、実行のボタンを危険の色にし、初めのフォーカスを
//    「キャンセル」に置く。Enter では実行しない（実行は Tab で移るかマウスで押す）。
//  - `primaryButton` は必須（本家の既定の「はい」を出さない）。
//  - 種類（`type`）の印は出さない（キットの S 段は問いの太字で示す）。
//  - Markdown の補足は平文にして出す（fork の確認は補足を文字列で渡している）。
// 呼び出し側がこのファイルを import すると下の registerSingleton も読まれるので、どのウィンドウの入口からでも解決できる。

import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { IConfirmation, IConfirmationResult } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { openParadisConfirmDialog } from './paradisConfirmDialog.js';

/** fork の確認。本家の {@link IConfirmation} に、取り消せない操作の印を足したもの。 */
export interface IParadisConfirmation extends IConfirmation {
	/**
	 * 実行のボタンの文言（「削除」「接続を承認」など、押すと何が起きるかが分かる動作の名前）。本家と違って必須にしている。
	 * 省くと本家の既定の「はい」になり、取り消せない確認でも何をするボタンか読めなくなるため。
	 */
	readonly primaryButton: string;
	/** 取り消せない操作（削除・破棄・強制・上書き・作り直し・解除）。既定のボタンを「キャンセル」にし、実行を危険の色にする。 */
	readonly destructive?: boolean;
	/**
	 * 利用者でなく、エージェント・スマホ・リポジトリなど外から求められた承認。既定のボタンを「キャンセル」にして Enter では
	 * 通さないが、実行のボタンは危険の色にしない。`destructive` はこれと危険の色の両方を持つ。
	 */
	readonly focusCancel?: boolean;
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
				label: confirmation.primaryButton,
				kind: confirmation.destructive ? 'danger' : 'primary',
				run: () => true,
			}],
			cancelLabel: confirmation.cancelButton,
			checkbox: confirmation.checkbox,
			focusCancel: confirmation.destructive || confirmation.focusCancel,
			token: confirmation.token,
		});
		return { confirmed: index === 0, checkboxChecked };
	}
}

/**
 * 窓が後ろにあっても、利用者が頼んでいない確認（スマホからのペアリング、エージェントが頼んだ削除など）に気づけるよう、
 * 確認を出す直前に呼ぶ。Dock の跳ね（macOS）・タスクバーの点滅で知らせるだけで、フォーカスは奪わない（FocusMode.Notify）。
 * サービスが無い・知らせられない環境でも確認はそのまま出す。
 */
export function paradisNotifyConfirmation(hostService: IHostService | undefined, targetWindow: Window): void {
	try {
		hostService?.focus(targetWindow, { mode: FocusMode.Notify })?.catch(() => { });
	} catch {
		// 知らせられなくても確認は出す
	}
}

registerSingleton(IParadisDialogService, ParadisDialogService, InstantiationType.Delayed);
