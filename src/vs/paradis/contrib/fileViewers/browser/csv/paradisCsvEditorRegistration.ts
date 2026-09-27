/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CSV ビューアの EditorResolver への登録内容（副作用なし）。contribution から呼ばれるほか、
// 優先度の判断（関連付け・EXCLUSIVE_ONLY でテキストになること）を本家の resolver で検証するテストからも使う。

import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../../workbench/services/editor/common/editorResolverService.js';
import { paradisGlobForExtension } from '../paradisFileViewers.js';
import { isParadisCsvResource, PARADIS_CSV_EDITOR_ID, PARADIS_CSV_EXTENSIONS } from './paradisCsvFileInput.js';

export const PARADIS_CSV_VIEWER_LABEL = localize('paradis.csvViewer', "CSV の表");

const SUPPORTED_SCHEMES = new Set<string>([Schemas.file, Schemas.vscodeRemote]);

export interface ParadisCsvEditorRegistrationOptions {
	/** `paradis.csvViewer.enabled`。開くたびに読む（設定の変更がすぐ効く）。 */
	readonly isEnabled: () => boolean;
	readonly createInput: (resource: URI) => EditorInput;
}

/**
 * `.csv` / `.tsv` を表ビューアとして登録する。
 *
 * 優先度は default（Markdown / Excel ビューアの exclusive とは意図的に変えている）。CSV はテキストエディタや
 * 拡張機能（Rainbow CSV 等）で扱う利用者が多いため、次の 2 つを本家どおりに残す:
 * - ユーザーの `workbench.editorAssociations`（例 `"*.csv": "default"`）が表より優先される
 * - 拡張機能の `showTextDocument`（EXCLUSIVE_ONLY で開く）はテキストエディタで開く
 * 組み込みのテキストエディタ（builtin）よりは優先されるので、何も設定していなければ表で開く。
 * 差分とマージは登録しない（resolver がこのビューアを飛ばしてテキストの差分・マージで開く）。
 */
export function registerParadisCsvEditors(editorResolverService: IEditorResolverService, options: ParadisCsvEditorRegistrationOptions): IDisposable {
	const store = new DisposableStore();
	for (const ext of PARADIS_CSV_EXTENSIONS) {
		store.add(editorResolverService.registerEditor(
			paradisGlobForExtension(ext),
			{
				id: PARADIS_CSV_EDITOR_ID,
				label: PARADIS_CSV_VIEWER_LABEL,
				priority: RegisteredEditorPriority.default
			},
			{
				canSupportResource: resource => SUPPORTED_SCHEMES.has(resource.scheme) && isParadisCsvResource(resource) && options.isEnabled(),
				singlePerResource: true
			},
			{
				createEditorInput: ({ resource, options: editorOptions }) => ({ editor: options.createInput(resource), options: editorOptions })
			}
		));
	}
	return store;
}
