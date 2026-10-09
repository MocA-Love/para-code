/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 画像ビューアの EditorResolver への登録内容（副作用なし）。contribution から呼ばれるほか、
// 優先度の判断（upstream の画像プレビューより先に選ばれること、差分でも使われること）を本家の resolver で
// 確かめるテストからも使う。

import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../../workbench/services/editor/common/editorResolverService.js';
import { paradisGlobForExtension } from '../paradisFileViewers.js';
import { isParadisImageResource, PARADIS_IMAGE_EDITOR_ID, PARADIS_IMAGE_EXTENSIONS } from './paradisImagePreview.js';

// allow-any-unicode-next-line
export const PARADIS_IMAGE_VIEWER_LABEL = localize('paradis.imageViewer', "画像プレビュー");

export interface ParadisImageEditorRegistrationOptions {
	/** `paradis.imageViewer.enabled`。開くたびに読む（設定の変更がすぐ効く）。 */
	readonly isEnabled: () => boolean;
	/** IFileService で読めるか（読めないスキームは upstream の画像プレビューに任せる）。 */
	readonly canRead: (resource: URI) => boolean;
	readonly createInput: (resource: URI) => EditorInput;
	/** 差分。upstream のカスタムエディタと同じく、左右に画像を 1 枚ずつ並べる。 */
	readonly createDiffInput: (label: string | undefined, description: string | undefined, original: EditorInput, modified: EditorInput) => EditorInput;
}

/**
 * upstream の画像プレビューと同じ拡張子を、画像ビューアとして登録する。
 *
 * 優先度は exclusive。upstream の `imagePreview.previewEditor` は builtin なので default でも勝てるが、
 * ユーザーの `workbench.editorAssociations` に `imagePreview.previewEditor` が残っていると default は負ける
 * （Markdown ビューアで実際に起きた）。exclusive でも、`override` に ID を指定して開く経路
 * （「ソース テキストとして開き直す」= `default`）は効く。設定でオフにすると canSupportResource が false に
 * なり、upstream の画像プレビューで開く。
 */
export function registerParadisImageEditors(editorResolverService: IEditorResolverService, options: ParadisImageEditorRegistrationOptions): IDisposable {
	const store = new DisposableStore();
	for (const ext of PARADIS_IMAGE_EXTENSIONS) {
		store.add(editorResolverService.registerEditor(
			paradisGlobForExtension(ext),
			{
				id: PARADIS_IMAGE_EDITOR_ID,
				label: PARADIS_IMAGE_VIEWER_LABEL,
				priority: RegisteredEditorPriority.exclusive
			},
			{
				canSupportResource: resource => isParadisImageResource(resource) && options.canRead(resource) && options.isEnabled(),
				singlePerResource: true
			},
			{
				createEditorInput: ({ resource, options: editorOptions }) => ({ editor: options.createInput(resource), options: editorOptions }),
				createDiffEditorInput: ({ original, modified, label, description, options: editorOptions }) => {
					if (!original.resource || !modified.resource) {
						throw new Error('Para Code image diff requires both original and modified resources');
					}
					return {
						editor: options.createDiffInput(label, description, options.createInput(original.resource), options.createInput(modified.resource)),
						options: editorOptions
					};
				}
			}
		));
	}
	return store;
}
