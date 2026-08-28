/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer ⇔ electron-main のプロファイル用チャネル契約。
//
// upstream の `IBrowserViewService` / `ipcBrowserViewChannelName` には**足さない**。
// あちらへ増やすと upstream のインターフェースを広げることになり、取り込みのたびに
// コンフリクトする面が増える。プロファイル固有の main 操作はこの fork 独自チャネルに閉じる。

/** main 側チャネル名。 */
export const PARADIS_BROWSER_PROFILE_CHANNEL = 'paradisBrowserProfiles';

/**
 * ビューに実際に紐付いている Electron セッションの素性。
 *
 * scope まで返すのは、ピルが「グローバル」「ワークスペース」「エフェメラル」も表示するため
 * （モック①の右2枚）。profileId だけだと、名前付きプロファイル以外がすべて同じ見た目になる。
 */
export interface IParadisViewSessionInfo {
	/** `BrowserViewStorageScope` の値。enum の import を避けて文字列で運ぶ。 */
	readonly scope: string;
	/** 名前付きプロファイルのときだけ入る。 */
	readonly profileId: string | undefined;
}

/** {@link IParadisBrowserProfilesMainService.getProfileStats} の戻り。 */
export interface IParadisBrowserProfileStats {
	/**
	 * そのパーティションに保存されている Cookie の件数。
	 * `undefined` は「取得できなかった」を意味し、UI は件数の代わりに「—」を出す
	 * （0件と取得失敗を同じ見た目にしない）。
	 */
	readonly cookieCount: number | undefined;
	/**
	 * そのプロファイルで今開いているビューの数（**全ウィンドウ分**）。
	 * renderer 側の台帳は自分のウィンドウしか知らないので、この数だけは main が権威。
	 */
	readonly openViewCount: number;
}

/**
 * main が公開する面（`ProxyChannel.fromService` でそのまま channel になる）。
 *
 * 「今このビューがどのプロファイルか」の権威は main 側にある: Electron セッションは
 * `WebContentsView` の構築時に固定され後から差し替えられないので、実際に紐付いている
 * セッションを見るのが唯一の確実な答えになる。
 */
export interface IParadisBrowserProfilesMainService {
	/** ビューIDに紐付く実際のセッションの素性（そのビューが無ければ undefined）。 */
	resolveViewSession(viewId: string): Promise<IParadisViewSessionInfo | undefined>;
	/** そのプロファイルの Cookie / ストレージを丸ごと消す（プロファイル削除時）。 */
	clearProfileData(profileId: string): Promise<void>;
	/** 管理モーダルに出す統計。取得できない項目は undefined。 */
	getProfileStats(profileId: string): Promise<IParadisBrowserProfileStats>;
}
