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
		/**
		 * ペインのスペースが画面に出ていないので、タブはそのスペースに置かずに開いた（open_browser_tab と同じ。
		 * エージェントはすぐ使え、ユーザーにはそのスペースへ戻ったときに見える）。
		 */
		readonly spaceNotVisible?: boolean;
	}
	| {
		readonly ok: false;
		readonly reason: ParadisOpenProfileFailure;
	};

/**
 * ユーザーのプロファイル（ユーザーのもの、別のペインが作ったもの）をエージェントが使うときの許可の設定。
 * 共有プロセスではなく、ペインのウィンドウ（承認を出す側）が読む。
 */
export const PARADIS_BROWSER_PROFILE_ACCESS_SETTING = 'paradis.agentBrowser.profileAccess';

/**
 * - ask: 毎回聞く（「今後は聞かない」は出さない）
 * - remembered: ユーザーが「今後は聞かない」で許可したプロファイルは聞かずに使う。ほかは聞く
 * - all: すべてのプロファイルを聞かずに使う
 */
export type ParadisProfileAccess = 'ask' | 'remembered' | 'all';

export const PARADIS_BROWSER_PROFILE_ACCESS_DEFAULT: ParadisProfileAccess = 'remembered';

/** 設定の値を読む。知らない値（手で書き換えた・古い版）は、いちばん慎重な ask に倒す。 */
export function paradisReadProfileAccess(value: unknown): ParadisProfileAccess {
	return value === 'remembered' || value === 'all' || value === 'ask' ? value : 'ask';
}

// ---------------------------------------------------------------------------------------------
// エージェントによるプロファイルの一覧・作成・切替・削除。同じチャネルに相乗りする。
//  - 一覧に名前を出すのは、そのペインのエージェントが作ったものと、聞かずに使ってよいもの
//    （設定が all ならすべて、remembered なら許可を残したもの）。ほかは数だけ知らせる
//  - それ以外（ユーザーのもの、別のペインが作ったもの。ログイン状態を含みうる）を開く・切り替える
//    ときは、ユーザーの承認を通す（聞かずに使ってよいものは、拡張機能を有効にしていても聞かない）
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

/** 1つのペインのエージェントが作れるプロファイルの数の上限（作りっぱなしで台帳が埋まるのを防ぐ）。 */
export const PARADIS_AGENT_CREATED_PROFILE_LIMIT = 10;

/**
 * エージェントが作ったプロファイルの、全ペイン合計の上限。上限はペインごとに数えるので、CLI を起動し直すたびに
 * 前のペインが作ったもの（もう誰も消せない）が残って増え続けないよう、合計にも天井を置く。
 */
export const PARADIS_AGENT_CREATED_PROFILE_TOTAL_LIMIT = 30;

/** エージェントへ見せるプロファイル1件分。ID やパーティション名は見せない。 */
export interface IParadisAgentProfileInfo {
	readonly name: string;
	/**
	 * このペインのエージェントが作ったもの（削除できるのはこれだけ）。false はユーザーのプロファイルで、
	 * 聞かずに使ってよいもの（設定と、ユーザーが残した許可による）。
	 */
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
	/** このペインのエージェントが作ったプロファイルが上限に達している。 */
	| 'tooManyProfiles'
	/** 全ペインのエージェントが作ったプロファイルの合計が上限に達している（ユーザーに消してもらう）。 */
	| 'tooManyAgentProfiles'
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
	/** このペインのエージェントが作ったプロファイルと、聞かずに使ってよいプロファイル。 */
	readonly profiles: readonly IParadisAgentProfileInfo[];
	/** 名前を伏せたプロファイル（使うにはユーザーの承認が要るもの）の数。 */
	readonly hiddenProfileCount: number;
	/** 許可の設定（{@link PARADIS_BROWSER_PROFILE_ACCESS_SETTING}）。 */
	readonly access: ParadisProfileAccess;
	/** ワークスペースを信頼していて、名前付きプロファイルを使えるか。 */
	readonly usable: boolean;
	/** ネットワークフィルタが無効で、プロファイルのページをエージェントへ共有できるか。 */
	readonly shareable: boolean;
};

export type IParadisManageProfileResult<T = {}> =
	| ({ readonly ok: true } & T)
	| { readonly ok: false; readonly reason: ParadisProfileManageFailure };

export type IParadisDeleteProfileResult = IParadisManageProfileResult<{
	readonly profileName: string;
	/** 削除と一緒に閉じた、そのペインのタブの ID（もう使えない）。 */
	readonly closedTabIds: readonly string[];
}>;

/** delete_browser_profile の返事。一緒に閉じた自分のタブを並べる（黙って閉じると、エージェントが消えた tabId を使い続ける）。 */
export function paradisDeletedProfileMessage(profileName: string, closedTabIds: readonly string[] | undefined): string {
	const deleted = `Deleted the "${profileName}" browser profile and its stored data.`;
	if (closedTabIds === undefined || closedTabIds.length === 0) {
		return deleted;
	}
	return `${deleted} Closed your ${closedTabIds.length === 1 ? 'tab' : 'tabs'} in that profile: ${closedTabIds.join(', ')}. ${closedTabIds.length === 1 ? 'That tabId no longer works' : 'Those tabIds no longer work'}; use list_browser_tabs to see the tabs you still have.`;
}

export type IParadisSwitchProfileResult = IParadisManageProfileResult<{
	readonly profileName: string;
	/** 新しく作り直したタブの ID（元の ID は使えなくなる）。 */
	readonly tabId: string;
	readonly bound: boolean;
	readonly restored: boolean;
}>;
