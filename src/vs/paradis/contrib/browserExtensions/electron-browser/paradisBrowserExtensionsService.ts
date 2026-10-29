/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）の renderer 側の窓口。共有の確認（D4）で、そのページに
// ページの中身を読み書きできる拡張機能が入っていれば知らせる文を作る。

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IParadisBrowserExtensionsMainService, IParadisViewBrowserExtension, PARADIS_BROWSER_EXTENSIONS_CHANNEL } from '../common/paradisBrowserExtensions.js';

export const IParadisBrowserExtensionsService = createDecorator<IParadisBrowserExtensionsService>('paradisBrowserExtensionsService');

export interface IParadisBrowserExtensionsService {
	readonly _serviceBrand: undefined;
	/**
	 * 共有の確認に出す知らせ。そのページ（ビュー）のセッションに、ページの中身を読み書きできる拡張機能が
	 * 今入っていれば文を返し、無ければ（設定がオフ・エージェントのタブ・SSH 先のページを含む）undefined。
	 */
	getShareWarning(viewId: string): Promise<string | undefined>;
}

/** 名前を並べる数（多いときは「ほか」でまとめる）。 */
const MAX_NAMES = 3;

/** 拡張機能の一覧から、共有の確認に出す文を作る。 */
export function paradisShareWarningFor(extensions: readonly IParadisViewBrowserExtension[]): string | undefined {
	const names = extensions.filter(extension => extension.touchesPages).map(extension => extension.name);
	if (names.length === 0) {
		return undefined;
	}
	const shown = names.length > MAX_NAMES
		? localize('paradis.browserExtensions.share.namesMore', "{0} ほか {1} 個", names.slice(0, MAX_NAMES).join('、'), names.length - MAX_NAMES)
		: names.join('、');
	return localize('paradis.browserExtensions.share.warning', "このタブでは拡張機能（{0}）が動いています。拡張機能が入力した値（パスワードなど）はページの中に入るので、共有するとエージェントからも読めます。エージェントは拡張機能の画面を操作できません。", shown);
}

export class ParadisBrowserExtensionsService implements IParadisBrowserExtensionsService {
	declare readonly _serviceBrand: undefined;

	private readonly _mainService: IParadisBrowserExtensionsMainService;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this._mainService = ProxyChannel.toService<IParadisBrowserExtensionsMainService>(mainProcessService.getChannel(PARADIS_BROWSER_EXTENSIONS_CHANNEL));
	}

	async getShareWarning(viewId: string): Promise<string | undefined> {
		try {
			return paradisShareWarningFor(await this._mainService.getExtensionsInView(viewId));
		} catch {
			// 知らせを出せないだけで、共有そのものは止めない
			return undefined;
		}
	}
}
