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
	| 'limitReached'
	/** http / https 以外の URL。 */
	| 'invalidUrl'
	/** ユーザーのプロファイルを使う承認を、ユーザーが断った。 */
	| 'denied'
	/** 承認の締め切りまでに確かな答えが得られなかった。 */
	| 'approvalTimedOut'
	/** このペインの別の求めがまだ答えを待っている。 */
	| 'alreadyPending'
	/** 少し前にユーザーがこのペインの求めを断った（しばらくは自動で断る）。 */
	| 'recentlyDenied';

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
// エージェントによるプロファイルの一覧・作成・切替・削除。同じチャネルに相乗りする。
//  - 一覧に名前を出すのは、そのペインのエージェントが作ったものだけ。ほかは数だけ知らせる
//  - それ以外（ユーザーのもの、別のペインが作ったもの。ログイン状態を含みうる）を開く・切り替える
//    ときは、ユーザーの承認を通す
//  - 削除できるのは、そのペインのエージェントが作り、ユーザーがまだ自分で使っていないものだけ。
//    それ以外の名前には「そんなプロファイルは無い」と同じ答えを返す（名前の有無を探らせない）
//  - 切替できるのは、そのペインのエージェントが自分で開いたタブだけ（ユーザーのタブのログイン状態は変えない）
//  - エージェント向けネットワークフィルタが有効な間は、プロファイルのページを共有できないので切替を断る
// ---------------------------------------------------------------------------------------------

export const PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD = 'listBrowserProfiles';
export const PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD = 'createBrowserProfile';
export const PARADIS_BROWSER_PROFILE_MCP_SWITCH_METHOD = 'switchBrowserProfile';
export const PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD = 'deleteBrowserProfile';
/**
 * そのプロファイルを、呼んだペインだけが使っているか（そのペインが作り、利用者がまだ使っておらず、
 * 開いているタブがすべてそのペインのタブ）。para-browser MCP のネットワークの上書きを掛けてよいかの判定。
 * 引数は [ペイントークン, プロファイル ID]、戻り値は boolean。
 */
export const PARADIS_BROWSER_PROFILE_MCP_PANE_OWNED_METHOD = 'isPaneOwnedProfile';

/** エージェントが作れるプロファイルの数の上限（作りっぱなしで台帳が埋まるのを防ぐ）。 */
export const PARADIS_AGENT_CREATED_PROFILE_LIMIT = 10;

/** エージェントへ見せるプロファイル1件分。ID やパーティション名は見せない。 */
export interface IParadisAgentProfileInfo {
	readonly name: string;
	/** このペインのエージェントが作ったもの（削除できるのはこれだけ）。 */
	readonly createdByYou: boolean;
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
	/**
	 * その名前では作れない（空、または既にある）。「既にある」を別の答えにすると、ユーザーの
	 * プロファイル名を探れてしまうので分けない。
	 */
	| 'invalidName'
	/** エージェントが作ったプロファイルが上限に達している。 */
	| 'tooManyProfiles'
	/** ユーザーのプロファイルを使う承認を、ユーザーが断った。 */
	| 'denied'
	/** 承認の締め切りまでに確かな答えが得られなかった。 */
	| 'approvalTimedOut'
	/** このペインの別の求めがまだ答えを待っている。 */
	| 'alreadyPending'
	/** 少し前にユーザーがこのペインの求めを断った。 */
	| 'recentlyDenied'
	/** そのプロファイルを使っているタブが、このペインのエージェントのもの以外にも開いている。 */
	| 'inUse'
	/** 切り替えるタブが無い（共有中のページが無い）、またはこのペインのエージェントが開いたタブではない。 */
	| 'notAgentTab'
	/** タブを作り直せなかった。 */
	| 'switchFailed';

export type IParadisListProfilesResult = {
	readonly ok: true;
	/** このペインのエージェントが作ったプロファイルだけ。 */
	readonly profiles: readonly IParadisAgentProfileInfo[];
	/** 名前を伏せたプロファイル（ユーザーのもの、別のペインが作ったもの）の数。 */
	readonly hiddenProfileCount: number;
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
