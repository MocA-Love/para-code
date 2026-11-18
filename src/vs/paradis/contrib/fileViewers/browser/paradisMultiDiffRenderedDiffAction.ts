/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 複数ファイルの差分（ブランチの変更点をまとめて開く・すべての変更を開く・グラフのコミット）の、ファイルごとの見出しに
// 置く「プレビュー差分」ボタン。押すと、そのファイルだけを単体の差分エディタ（paradisFileDiffEditor）のプレビュー差分で
// 別のタブに開く。複数ファイルの差分の中身は本家のテキスト差分のまま（中に描く口が無いため）。
//
// ボタンを .md の行にだけ出すため、本家の diffEditorItemTemplate.ts に 1 行の PARA-PATCH を当て、行ごとの
// コンテキストキー `paradisMultiDiffItemExtname`（拡張子、小文字・ドット付き）を立てている。

import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ActiveEditorContext } from '../../../../workbench/common/contextkeys.js';
import { MultiDiffEditor } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ParadisFileDiffInput } from './paradisFileDiffInput.js';
import { PARADIS_MARKDOWN_EXTENSIONS } from './paradisFileViewers.js';

/** 複数ファイルの差分の行ごとに立つ、その行のファイルの拡張子（本家への PARA-PATCH が立てる）。 */
const ITEM_EXTNAME_CONTEXT = 'paradisMultiDiffItemExtname';

/** 「プレビュー差分」ボタンを出す拡張子。HTML のプレビュー差分を足したら、ここに HTML の拡張子も足す。 */
const RENDERED_DIFF_EXTENSIONS: readonly string[] = PARADIS_MARKDOWN_EXTENSIONS;

class ParadisMultiDiffOpenRenderedDiffAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.multiDiff.openRenderedDiff',
			title: localize2('paradis.multiDiff.openRenderedDiff', "プレビュー差分"),
			icon: Codicon.openPreview,
			precondition: ActiveEditorContext.isEqualTo(MultiDiffEditor.ID),
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.and(
					ActiveEditorContext.isEqualTo(MultiDiffEditor.ID),
					ContextKeyExpr.or(...RENDERED_DIFF_EXTENSIONS.map(extension => ContextKeyExpr.equals(ITEM_EXTNAME_CONTEXT, extension))),
				),
				// 「ファイルを開く」（order 22）の左
				order: 21,
				group: 'navigation',
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const uri = args[0];
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const pane = editorService.activeEditorPane;
		if (!(uri instanceof URI) || !(pane instanceof MultiDiffEditor)) {
			return;
		}
		const item = pane.findDocumentDiffItem(uri);
		if (!item) {
			return;
		}
		if (!item.originalUri || !item.modifiedUri) {
			// 足された・消されたファイルは比べる相手が無いので、ある側をビューアで開く。
			await editorService.openEditor({ resource: item.modifiedUri ?? item.originalUri });
			return;
		}
		const input = instantiationService.createInstance(ParadisFileDiffInput, item.originalUri, item.modifiedUri, undefined);
		input.openInRenderedDiff = true;
		await editorService.openEditor(input, { pinned: true });
	}
}

registerAction2(ParadisMultiDiffOpenRenderedDiffAction);
