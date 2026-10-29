/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）の renderer 側の窓口。共有の確認（D4）で、そのページに
// ページの中身を読み書きできる拡張機能が入っていれば知らせる文を作る。

import { raceTimeout } from '../../../../base/common/async.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IParadisBrowserProfilesService } from '../../browserProfiles/electron-browser/paradisBrowserProfilesService.js';
import {
	IParadisBrowserExtensionsMainService,
	IParadisShareExtensions,
	IParadisViewBrowserExtension,
	PARADIS_BROWSER_EXTENSIONS_CHANNEL,
	PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING,
	PARADIS_DEFAULT_EXTENSION_PROFILE,
	paradisNamedExtensionProfile,
} from '../common/paradisBrowserExtensions.js';

export const IParadisBrowserExtensionsService = createDecorator<IParadisBrowserExtensionsService>('paradisBrowserExtensionsService');

/** 共有するもの。開いているタブ（`viewId`）か、これから開く名前付きプロファイル（`profileId`）。 */
export type ParadisShareTarget = { readonly kind: 'view'; readonly viewId: string } | { readonly kind: 'profile'; readonly profileId: string };

export interface IParadisBrowserExtensionsService {
	readonly _serviceBrand: undefined;
	/**
	 * 共有の確認に出す知らせ（D4）。共有のどの経路もこれを通す。ページの中身を読み書きできる拡張機能が
	 * 入っていれば（入りうるなら）文を返し、無ければ undefined。確かめられなかった（時間切れ・失敗）ときは、
	 * 設定がオンなら「確かめられなかった」という知らせを返す（知らせ損ねない側に倒す）。
	 */
	getShareWarning(target: ParadisShareTarget): Promise<string | undefined>;
	/**
	 * 確認の画面を持たない共有の経路（コマンドなど）で使う。知らせが要るときは確かめの画面を出し、
	 * 共有してよければ true。
	 */
	confirmShare(target: ParadisShareTarget): Promise<boolean>;
}

/** 名前を並べる数（多いときは「ほか」でまとめる）。 */
const MAX_NAMES = 3;

/** main への問い合わせを待つ長さ。過ぎたら「確かめられなかった」として知らせる。 */
const QUERY_TIMEOUT_MS = 1_000;

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

/** 確かめられなかったときの知らせ。 */
export function paradisShareWarningUnknown(): string {
	return localize('paradis.browserExtensions.share.unknown', "このタブに拡張機能が入っているか確かめられませんでした。入っている場合、拡張機能が入力した値（パスワードなど）は、共有するとエージェントからも読めます。");
}

/**
 * まだ開いていないタブで、有効にしてある拡張機能を見るプロファイル。エージェントのタブ・使い捨てのタブには
 * 入らないので undefined。分からないときは「既定」として扱う（知らせ損ねない側）。
 */
export function paradisShareFallbackProfile(session: { readonly scope: string; readonly profileId?: string } | undefined): string | undefined {
	switch (session?.scope) {
		case BrowserViewStorageScope.Agent:
		case BrowserViewStorageScope.Ephemeral:
			return undefined;
		case BrowserViewStorageScope.Profile:
			return session.profileId !== undefined ? paradisNamedExtensionProfile(session.profileId) : PARADIS_DEFAULT_EXTENSION_PROFILE;
		default:
			return PARADIS_DEFAULT_EXTENSION_PROFILE;
	}
}

/**
 * 拡張機能を有効にした場所（`place`）のタブのうち、今エージェントと共有しているもののタイトル。共有した後に
 * 拡張機能を有効にしたときは共有の確認を通らないので、管理画面で知らせるのに使う。
 */
export function paradisSharedPageTitlesInPlace(
	shared: readonly { readonly pageId: string; readonly title: string }[],
	place: string,
	sessionOf: (pageId: string) => { readonly scope: string; readonly profileId?: string } | undefined,
): string[] {
	const titles = new Set<string>();
	for (const page of shared) {
		if (paradisShareFallbackProfile(sessionOf(page.pageId)) === place) {
			titles.add(page.title);
		}
	}
	return [...titles];
}

/** 共有中のタブで拡張機能を有効にしたときの知らせ。 */
export function paradisEnabledWhileSharedWarning(extensionName: string, titles: readonly string[]): string {
	const shown = titles.length > MAX_NAMES
		? localize('paradis.browserExtensions.enabledWhileShared.more', "{0} ほか {1} 個", titles.slice(0, MAX_NAMES).join('、'), titles.length - MAX_NAMES)
		: titles.join('、');
	return localize('paradis.browserExtensions.enabledWhileShared', "「{0}」を有効にした場所のタブ（{1}）は、エージェントと共有中です。拡張機能が入力した値（パスワードなど）は、エージェントからも読めます。気になる場合は共有を外してください。", extensionName, shown);
}

export class ParadisBrowserExtensionsService implements IParadisBrowserExtensionsService {
	declare readonly _serviceBrand: undefined;

	private readonly _mainService: IParadisBrowserExtensionsMainService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IParadisBrowserProfilesService private readonly _profilesService: IParadisBrowserProfilesService,
		@IDialogService private readonly _dialogService: IDialogService,
	) {
		this._mainService = ProxyChannel.toService<IParadisBrowserExtensionsMainService>(mainProcessService.getChannel(PARADIS_BROWSER_EXTENSIONS_CHANNEL));
	}

	async getShareWarning(target: ParadisShareTarget): Promise<string | undefined> {
		const query = target.kind === 'view'
			? this._mainService.getShareExtensions(target.viewId, paradisShareFallbackProfile(this._profilesService.getViewSession(target.viewId)))
			: this._mainService.getShareExtensions(undefined, paradisNamedExtensionProfile(target.profileId));
		let answer: IParadisShareExtensions | undefined;
		try {
			answer = await raceTimeout(query, QUERY_TIMEOUT_MS);
		} catch {
			answer = undefined;
		}
		if (answer === undefined) {
			// 確かめられなかった。設定がオンなら（再起動待ちを含む）、入っているかもしれないと知らせる
			return this._configurationService.getValue<boolean>(PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING) === true ? paradisShareWarningUnknown() : undefined;
		}
		return answer.active ? paradisShareWarningFor(answer.extensions) : undefined;
	}

	async confirmShare(target: ParadisShareTarget): Promise<boolean> {
		const warning = await this.getShareWarning(target);
		if (warning === undefined) {
			return true;
		}
		const { confirmed } = await this._dialogService.confirm({
			type: 'warning',
			message: localize('paradis.browserExtensions.share.confirmMessage', "拡張機能が入ったタブを共有しますか？"),
			detail: warning,
			primaryButton: localize('paradis.browserExtensions.share.confirmShare', "共有する"),
		});
		return confirmed;
	}
}
