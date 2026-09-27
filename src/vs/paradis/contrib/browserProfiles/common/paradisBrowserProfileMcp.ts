/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MCP ツール `open_browser_profile` の shared process ⇔ renderer 契約。
// `PARADIS_AGENT_PREVIEW_CHANNEL`（preview_file）と同じ形にしてある: renderer は内部情報を
// 含み得る文字列を返さず、構造化された結果だけを返す。LLM 向けの英文への翻訳は shared
// process 側（paradisAgentBrowserService.ts）が持つ。

/** shared process → renderer のチャネル名。 */
export const PARADIS_BROWSER_PROFILE_MCP_CHANNEL = 'paradisBrowserProfileMcp';

/** チャネルのメソッド名。 */
export const PARADIS_BROWSER_PROFILE_MCP_METHOD = 'openBrowserProfile';

/** 開けなかった理由。増やしたら shared process 側の switch が型で落ちる。 */
export type ParadisOpenProfileFailure =
	/** スペース切り替えの最中。どちらのスペースへ属させても不定になるので開かない。 */
	| 'switching'
	/** 呼び出し元ペインがまだ台帳に無い（ターミナル復元中など）。 */
	| 'paneUnresolved'
	/** その名前のプロファイルがユーザーの台帳に無い。 */
	| 'unknownProfile'
	/**
	 * ワークスペースを信頼していないため、ログイン状態を保存するプロファイルが使えない
	 * （upstream が常にエフェメラルへ倒す領域なので、こちらも上書きしない）。
	 */
	| 'untrustedWorkspace'
	/**
	 * エージェント向けネットワークフィルタ（`chat.agent.networkFilter`）が有効なため、名前付き
	 * プロファイルのページをエージェントへ共有できない（upstream はフィルタを強制しない保存スコープを
	 * 共有不可と判定し、共有しようとすると Cookie の無い別セッションのタブを開き直す）。開いてから
	 * 共有すると「ログイン済みのはずが空のセッション」をエージェントへ渡すことになるので、開かずに断る。
	 */
	| 'profileNotShareable'
	/**
	 * ペインが属するスペースが今画面に出ていない。`preview_file` と違って予約はしない:
	 * 開いたページを即座にこのペインへ共有するのがこのツールの目的で、後から開いても
	 * エージェントはもう操作できないため。
	 */
	| 'spaceNotVisible'
	/** ペインが属するスペースへ二度と到達できない（リポジトリ / worktree が消えた）。 */
	| 'unreachableSpace'
	/**
	 * プロファイルは見つかったが、エディタを開けなかった。`unknownProfile` に丸めると
	 * 「そんな名前は無い」とエージェントへ誤って伝わり、ユーザーへ嘘の指示（作り直せ）が飛ぶ。
	 */
	| 'openFailed'
	/** このペインのエージェントが開いたタブが上限（open_browser_tab と共通）に達している。 */
	| 'limitReached';

/** `open_browser_profile` の結果。 */
export type IParadisOpenProfileResult =
	| {
		readonly ok: true;
		/** 実際に開いたプロファイルの表示名（大小文字は台帳側の綴りに揃う）。 */
		readonly profileName: string;
		/** 既存のログイン状態（Cookie）が残っていたか。false なら未ログインの状態で開いた。 */
		readonly restored: boolean;
		/** 開いたページを呼び出し元ペインへ共有（bind）できたか。 */
		readonly bound: boolean;
		/** 開いたタブの ID（close_browser_tab / select_browser_tab に使う）。 */
		readonly tabId?: string;
	}
	| {
		readonly ok: false;
		readonly reason: ParadisOpenProfileFailure;
	};

// ---------------------------------------------------------------------------------------------
// エージェントによるプロファイルの一覧・作成・切替・削除（計画書 B9）。同じチャネルに相乗りする。
//  - 一覧・作成・切替はどのプロファイルでもよい。削除はエージェントが作ったものだけ
//  - 切替できるのは、そのペインのエージェントが自分で開いたタブだけ（ユーザーのタブのログイン状態は変えない）
//  - エージェント向けネットワークフィルタが有効な間は、プロファイルのページを共有できないので切替を断る
// ---------------------------------------------------------------------------------------------

export const PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD = 'listBrowserProfiles';
export const PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD = 'createBrowserProfile';
export const PARADIS_BROWSER_PROFILE_MCP_SWITCH_METHOD = 'switchBrowserProfile';
export const PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD = 'deleteBrowserProfile';

/** エージェントが作れるプロファイルの数の上限（作りっぱなしで台帳が埋まるのを防ぐ）。 */
export const PARADIS_AGENT_CREATED_PROFILE_LIMIT = 10;

/** エージェントへ見せるプロファイル1件分。ID やパーティション名は見せない。 */
export interface IParadisAgentProfileInfo {
	readonly name: string;
	readonly createdByAgent: boolean;
	/** 保存されたログイン状態（Cookie）があるか。取得できなければ undefined。 */
	readonly hasStoredLogin: boolean | undefined;
	/** 最後に使った時刻（ISO 8601）。 */
	readonly lastUsed: string;
}

export type ParadisProfileManageFailure =
	| 'switching'
	| 'paneUnresolved'
	| 'untrustedWorkspace'
	| 'unknownProfile'
	| 'profileNotShareable'
	/** 名前が空。 */
	| 'invalidName'
	/** 同じ名前（大小文字・全角半角の違いは同じとみなす）が既にある。 */
	| 'duplicateName'
	/** エージェントが作ったプロファイルが上限に達している。 */
	| 'tooManyProfiles'
	/** ユーザーが作ったプロファイルは消させない。 */
	| 'notCreatedByAgent'
	/** そのプロファイルを使っているタブが、このペインのエージェントのもの以外にも開いている。 */
	| 'inUse'
	/** 切り替えるタブが無い（共有中のページが無い）、またはこのペインのエージェントが開いたタブではない。 */
	| 'notAgentTab'
	/** タブを作り直せなかった。 */
	| 'switchFailed';

export type IParadisListProfilesResult = {
	readonly ok: true;
	readonly profiles: readonly IParadisAgentProfileInfo[];
	/** ワークスペースを信頼していて、名前付きプロファイルを使えるか。 */
	readonly usable: boolean;
	/** ネットワークフィルタが無効で、プロファイルのページをエージェントへ共有できるか。 */
	readonly shareable: boolean;
};

export type IParadisManageProfileResult<T = {}> =
	| ({ readonly ok: true } & T)
	| { readonly ok: false; readonly reason: ParadisProfileManageFailure };

export type IParadisSwitchProfileResult = IParadisManageProfileResult<{
	readonly profileName: string;
	/** 新しく作り直したタブの ID（元の ID は使えなくなる）。 */
	readonly tabId: string;
	readonly bound: boolean;
	readonly restored: boolean;
}>;
