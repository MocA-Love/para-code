/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 名前付きブラウザプロファイルの「識別子だけ」を扱う純粋関数。
//
// このファイルは platform 層（browserSession.ts）から逆方向 import される唯一の入り口なので、
// **依存を一切持たせない**こと。BrowserSession はもちろん、vs/base すら import しない
// （import すると platform → paradis → platform の循環を作りやすく、main の起動順序に
// 影響が出る）。判定に必要なものは全て引数で受け取る。
//
// プロファイルの同一性は表示名ではなく不透明な生成ID（uuid の先頭12hex）で持つ。
// 名前をパーティションに使うと、リネームした瞬間に Chromium から見て別セッションになり
// 保存済みのログイン状態が丸ごと消える。サニタイズすると別名同士が衝突もする。
// 表示名と色は台帳（renderer 側）だけが持ち、セッションには一切触れない。

/** Chromium の `persist:` パーティション名の接頭辞。 */
export const PARADIS_BROWSER_PROFILE_PARTITION_PREFIX = 'persist:paracode-browser-profile-';

/** `BrowserSession.id` の接頭辞。既存の `global` / `workspace:` / `ephemeral:` と並ぶ第4の形。 */
export const PARADIS_BROWSER_PROFILE_SESSION_PREFIX = 'profile:';

/** `BrowserViewStorageScope.Profile` の文字列値。enum を import せずに突き合わせるための定数。 */
export const PARADIS_BROWSER_PROFILE_SCOPE = 'profile';

/** プロファイルIDの形（uuid の先頭12hex）。 */
const PROFILE_ID_PATTERN = /^[0-9a-f]{12}$/;

/** {@link paradisBrowserProfilePartition} が返す、セッションの作り方一式。 */
export interface IParadisBrowserProfilePartition {
	/** `session.fromPartition()` に渡すパーティション名。 */
	readonly partition: string;
	/** `BrowserSession.id`（CDP の browserContextId も兼ねる）。 */
	readonly sessionId: string;
	/** 元のプロファイルID。 */
	readonly profileId: string;
}

/** 生成されたプロファイルIDとして妥当か。台帳の壊れた値をセッション名へ持ち込ませない。 */
export function paradisIsValidProfileId(profileId: string | undefined): profileId is string {
	return typeof profileId === 'string' && PROFILE_ID_PATTERN.test(profileId);
}

/** uuid（`generateUuid()` の出力）からプロファイルIDを作る。 */
export function paradisProfileIdFromUuid(uuid: string): string {
	return uuid.replace(/-/g, '').slice(0, 12).toLowerCase();
}

/** プロファイルIDから `BrowserSession.id` を作る。 */
export function paradisBrowserProfileSessionId(profileId: string): string {
	return `${PARADIS_BROWSER_PROFILE_SESSION_PREFIX}${profileId}`;
}

/**
 * `BrowserSession.id` からプロファイルIDを取り出す。名前付きプロファイル以外
 * （`global` / `workspace:...` / `ephemeral:...`）や壊れたIDでは undefined。
 */
export function paradisProfileIdFromSessionId(sessionId: string | undefined): string | undefined {
	if (typeof sessionId !== 'string' || !sessionId.startsWith(PARADIS_BROWSER_PROFILE_SESSION_PREFIX)) {
		return undefined;
	}
	const profileId = sessionId.slice(PARADIS_BROWSER_PROFILE_SESSION_PREFIX.length);
	return paradisIsValidProfileId(profileId) ? profileId : undefined;
}

/**
 * セッションオプションが名前付きプロファイルを指していれば、その作り方を返す。
 * それ以外（既存の3スコープ、プロファイルIDが無い/壊れている）は undefined を返し、
 * 呼び出し側（browserSession.ts）はそのまま upstream の switch へ落ちる。
 *
 * 引数はあえて構造的な型で受ける（`IBrowserSessionOptions` を import しないため）。
 */
export function paradisBrowserProfilePartition(sessionOptions: {
	readonly scope: string;
	readonly profileId?: string;
}): IParadisBrowserProfilePartition | undefined {
	if (sessionOptions.scope !== PARADIS_BROWSER_PROFILE_SCOPE) {
		return undefined;
	}
	const profileId = sessionOptions.profileId;
	if (!paradisIsValidProfileId(profileId)) {
		return undefined;
	}
	return {
		partition: `${PARADIS_BROWSER_PROFILE_PARTITION_PREFIX}${profileId}`,
		sessionId: paradisBrowserProfileSessionId(profileId),
		profileId,
	};
}
