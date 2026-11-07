/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';

/** エディタの読み取り専用の設定（`readOnly` と、そのときに出す説明）。 */
export interface IParadisReadonlyEditorOptions {
	readonly readOnly: boolean;
	readonly readOnlyMessage: IMarkdownString | undefined;
}

/**
 * モデルの読み取り専用（`files.readonlyInclude` や読み取り専用のファイルシステム）をエディタへ写し、変わったら写し直す。
 * 写さないと、読み取り専用のファイルもソース表示で編集でき、その変更は dirty にならず保存もされずに黙って消える。
 */
export function paradisFollowModelReadonly(model: IResolvedTextEditorModel, apply: (options: IParadisReadonlyEditorOptions) => void): IDisposable {
	const update = () => {
		const readonly = model.isReadonly();
		apply({ readOnly: readonly !== false, readOnlyMessage: typeof readonly === 'object' ? readonly : undefined });
	};
	update();
	// ファイルのモデル（ITextFileEditorModel）は読み取り専用が変わると知らせる。知らせないモデルは開いたときの値のまま
	const onDidChangeReadonly = (model as Partial<{ readonly onDidChangeReadonly: Event<void> }>).onDidChangeReadonly;
	return onDidChangeReadonly !== undefined ? onDidChangeReadonly(update) : { dispose: () => { } };
}
