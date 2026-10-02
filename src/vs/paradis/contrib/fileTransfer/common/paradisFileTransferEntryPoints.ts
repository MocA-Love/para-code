/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の入口（メニュー）の出し分けの条件。when 句として登録に使い、テストでは同じ式を
// 評価して、`paradisShowsTitleBarEntry` / `paradisSideForResource` と食い違わないことを確かめる。
// REH のサーバーにも載る common/paradisFileTransfer.ts とは分け、こちらは窓の側からだけ読む。

import { Schemas } from '../../../../base/common/network.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

/** `workbench.activityBar.location` の文脈キー（設定の既定値が入るので、未設定でも `default`）。 */
const ACTIVITY_BAR_LOCATION_KEY = 'config.workbench.activityBar.location';
/** エクスプローラーで右クリックした項目がフォルダーか（upstream の ExplorerFolderContext と同じキー）。 */
const EXPLORER_FOLDER_KEY = 'explorerResourceIsFolder';
/** 右クリックした項目のスキーム（upstream の ResourceContextKey.Scheme と同じキー）。 */
const RESOURCE_SCHEME_KEY = 'resourceScheme';

/** タイトルバーのボタン: アクティビティバーが左右（既定）に無いときだけ。 */
export const PARADIS_FILE_TRANSFER_TITLE_BAR_WHEN = ContextKeyExpr.notEquals(ACTIVITY_BAR_LOCATION_KEY, 'default');

/** エクスプローラーの右クリック: 手元か、このウィンドウの接続先のフォルダーだけ。 */
export const PARADIS_FILE_TRANSFER_EXPLORER_WHEN = ContextKeyExpr.and(
	ContextKeyExpr.equals(EXPLORER_FOLDER_KEY, true),
	ContextKeyExpr.or(
		ContextKeyExpr.equals(RESOURCE_SCHEME_KEY, Schemas.file),
		ContextKeyExpr.equals(RESOURCE_SCHEME_KEY, Schemas.vscodeRemote),
	),
);
