/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのタブの右クリックの「ダウンロード...」（SSH の窓で、接続先のファイルを手元へ落とす）の
// 出す条件と、落とすファイルの決め方。upstream の `explorer.download` はエクスプローラーの選択を落とす
// （渡したファイルを見ない）ので、タブからは使えない。タブのファイルを upstream の FileDownload へ直接渡す。

import { basename } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ActiveEditorDirtyContext, ResourceContextKey } from '../../../../workbench/common/contextkeys.js';
import { ParadisTabIsDiffContext } from '../../../../workbench/services/editor/common/paradisTabContextKeys.js';

export const PARADIS_EDITOR_DOWNLOAD_COMMAND_ID = 'paradis.editor.download';

/**
 * タブの右クリックで出す条件: 接続先（`vscode-remote`）のファイルで、差分でも未保存の変更があるタブでもないもの。
 * タブの右クリックでは、これらの文脈キーは右クリックしたタブの値になる。
 */
export const PARADIS_EDITOR_DOWNLOAD_WHEN = ContextKeyExpr.and(
	ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeRemote),
	ActiveEditorDirtyContext.negate(),
	ParadisTabIsDiffContext.negate(),
);

/** 右クリックしたタブの様子（落としてよいかの判断に使う分だけ）。 */
export interface IParadisEditorDownloadTab {
	/** 差分・左右に並べたエディタのタブか。 */
	readonly sideBySide: boolean;
	readonly dirty: boolean;
}

/** FileDownload へ渡す 1 件。 */
export interface IParadisEditorDownloadSource {
	readonly resource: URI;
	readonly name: string;
	readonly isDirectory: boolean;
}

/**
 * 落とすファイル。接続先のファイルのタブで、差分でも未保存の変更があるタブでもないときだけ返す
 * （メニューの条件でも外しているが、コマンドとして直接呼ばれたときのために押されたときにも確かめる）。
 */
export function paradisEditorDownloadSource(resource: URI | undefined, tab: IParadisEditorDownloadTab | undefined): IParadisEditorDownloadSource | undefined {
	if (!resource || resource.scheme !== Schemas.vscodeRemote || !tab || tab.sideBySide || tab.dirty) {
		return undefined;
	}
	return { resource, name: basename(resource), isDirectory: false };
}
