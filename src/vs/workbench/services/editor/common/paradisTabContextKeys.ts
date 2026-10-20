/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのタブの右クリックのメニューで使う、Para Code の文脈キー。upstream の editorTabsControl.ts の
// onTabContextMenu から（PARA-PATCH の 1 行で）右クリックしたタブごとに設定する。

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { isDiffEditorInput, isSideBySideEditorInput } from '../../../common/editor.js';

/** 右クリックしたタブが差分（または左右に並べたエディタ）か。 */
export const ParadisTabIsDiffContext = new RawContextKey<boolean>('paradisTabIsDiff', false, localize('paradisTabIsDiff', "Whether the editor tab that was right-clicked shows a diff"));

/**
 * 差分のタブか。upstream の差分・左右に並べたエディタに加え、Para Code のビューア（Markdown・Word・Excel など）の
 * 差分も含める（これらは旧版 `originalResource` と新版 `modifiedResource` の 2 つを持つ独自の入力）。
 */
export function paradisIsDiffTab(editor: object): boolean {
	if (isSideBySideEditorInput(editor) || isDiffEditorInput(editor)) {
		return true;
	}
	const candidate = editor as { originalResource?: unknown; modifiedResource?: unknown };
	return URI.isUri(candidate.originalResource) && URI.isUri(candidate.modifiedResource);
}

/** 右クリックしたタブの値を、タブのメニューの文脈へ入れる。 */
export function paradisUpdateTabContextKeys(contextKeyService: IContextKeyService, editor: object): void {
	ParadisTabIsDiffContext.bindTo(contextKeyService).set(paradisIsDiffTab(editor));
}
