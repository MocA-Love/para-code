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
	| 'openFailed';

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
	}
	| {
		readonly ok: false;
		readonly reason: ParadisOpenProfileFailure;
	};
