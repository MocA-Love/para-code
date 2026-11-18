/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 差分エディタ（paradisFileDiffEditor）に、Markdown 以外の「プレビュー差分」を足す口。HTML のプレビュー差分は
// 配信サーバ（デスクトップだけ）を使うので electron-browser に置き、その contribution がここへ登録する
// （browser の差分エディタから electron-browser を import しないため）。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisRenderedDiffHost, ParadisMarkdownRenderedDiffView } from './paradisMarkdownRenderedDiffView.js';

/** プレビュー差分の部品の作り方。 */
export interface IParadisRenderedDiffViewFactory {
	/** 変更後の側のリソースで、この部品を使うか。 */
	matches(resource: URI): boolean;
	create(instantiationService: IInstantiationService, host: IParadisRenderedDiffHost): ParadisMarkdownRenderedDiffView;
}

const factories: IParadisRenderedDiffViewFactory[] = [];

/** プレビュー差分の部品を登録する。 */
export function registerParadisRenderedDiffView(factory: IParadisRenderedDiffViewFactory): IDisposable {
	factories.push(factory);
	return toDisposable(() => {
		const index = factories.indexOf(factory);
		if (index >= 0) {
			factories.splice(index, 1);
		}
	});
}

/** このリソースの差分に使う部品の作り方（無ければ `undefined`）。 */
export function paradisRenderedDiffViewFactoryFor(resource: URI): IParadisRenderedDiffViewFactory | undefined {
	return factories.find(factory => factory.matches(resource));
}
