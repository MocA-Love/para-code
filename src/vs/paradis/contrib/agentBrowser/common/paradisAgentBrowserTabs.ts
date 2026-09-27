/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのタブ操作と、ページ共有の「エージェントが要求 → ユーザーが承認」の
// shared process ⇔ renderer 契約。形は `open_browser_profile`（paradisBrowserProfileMcp.ts）に揃えてある:
// renderer は内部情報を含み得る文字列を返さず構造化された結果だけを返し、LLM 向けの英文への
// 翻訳は shared process 側（paradisAgentBrowserService.ts）が持つ。
//
// 規則:
//  - エージェントが開けるタブは1ペインあたり {@link PARADIS_AGENT_TAB_LIMIT} 枚まで
//  - 閉じられるのは、そのペインのエージェントが自分で開いたタブだけ（ユーザーのタブは閉じない）
//  - エージェントが開いたタブは最初から共有済み（承認済み）。ユーザーのタブは要求 → 承認を経る
//  - ユーザーのタブを使えるのは、そのタブが共有されている間だけ。エージェントが自分のタブへ共有を
//    移したら、ユーザーのタブへ戻るにはもう一度頼む（見えないまま使い続けられないようにする）
//  - どのタブもエージェント用の保存領域（Agent スコープ）で開き、ネットワークの制限が掛かる

/** shared process → renderer のチャネル名。 */
export const PARADIS_AGENT_BROWSER_TABS_CHANNEL = 'paradisAgentBrowserTabs';

/** チャネルのメソッド名。 */
export const ParadisAgentTabMethod = {
	Open: 'openTab',
	List: 'listTabs',
	Select: 'selectTab',
	Close: 'closeTab',
	RequestPage: 'requestPage',
} as const;

/** 1ペインのエージェントが同時に開いておけるタブの上限。 */
export const PARADIS_AGENT_TAB_LIMIT = 5;

/** 要求の理由（エージェントが書く文）を承認ダイアログへ出すときの最大文字数。 */
export const PARADIS_AGENT_PAGE_REQUEST_REASON_MAX_LENGTH = 300;

/**
 * 承認を待つ上限（renderer 側）。ダイアログの表示から共有の完了までを、この1本の締め切りで打ち切る。
 * 時間切れになったらダイアログを閉じ、その後に共有が成立しても外す。Codex の MCP ツールの既定の
 * 時間切れ（60 秒）より短くしてある。
 */
export const PARADIS_AGENT_APPROVAL_DEADLINE_MS = 50_000;

/** shared process 側で承認付きの呼び出しを待つ上限。renderer の締め切りより少し長い。 */
export const PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS = 55_000;

/** 承認ダイアログが出てからこの時間内の「承認」は、打ちかけの Enter とみなして聞き直す。 */
export const PARADIS_AGENT_APPROVAL_GUARD_MS = 1_000;

/** どのタブ操作でも起こりうる、ペインとスペースの解決に関わる失敗。 */
export type ParadisAgentTabTargetFailure =
	/** スペース切り替えの最中。 */
	| 'switching'
	/** 呼び出し元ペインがまだ台帳に無い（ターミナル復元中など）。 */
	| 'paneUnresolved'
	/** ペインが属するスペースが今画面に出ていない。 */
	| 'spaceNotVisible'
	/** ペインが属するスペースへ二度と到達できない。 */
	| 'unreachableSpace';

export type ParadisAgentTabFailure =
	| ParadisAgentTabTargetFailure
	/** このペインが開いたタブが上限に達している。 */
	| 'limitReached'
	/** http / https / about:blank 以外の URL。 */
	| 'invalidUrl'
	/** タブを開けなかった。 */
	| 'openFailed'
	/** その ID のタブが無い、またはこのペインが使ってよいタブではない。 */
	| 'unknownTab'
	/** そのタブのスペースが今画面に出ていない（退避中のタブは閉じない）。 */
	| 'tabNotVisible'
	/** このペインのエージェントが開いたタブではない（ユーザーのタブは閉じない）。 */
	| 'notOwned';

/** エージェントへ見せるタブ1枚分。 */
export interface IParadisAgentTabInfo {
	/** ページID（ブラウザビューのID）。get_shared_page の pageId と同じもの。 */
	readonly tabId: string;
	readonly url: string;
	readonly title: string;
	/** このペインのエージェントが開いたタブか（閉じられるのはこれだけ）。 */
	readonly openedByAgent: boolean;
	/** 今このペインに共有されているタブか（chrome-devtools 系ツールが操作するのはこれ）。 */
	readonly active: boolean;
}

export type IParadisAgentTabResult<T> =
	| ({ readonly ok: true } & T)
	| { readonly ok: false; readonly reason: ParadisAgentTabFailure };

export type IParadisOpenAgentTabResult = IParadisAgentTabResult<{
	readonly tab: IParadisAgentTabInfo;
	/** 開いたタブをこのペインへ共有できたか。 */
	readonly bound: boolean;
	/** このペインが開いているタブの数（上限と一緒に知らせる）。 */
	readonly openedCount: number;
}>;

export type IParadisListAgentTabsResult = IParadisAgentTabResult<{
	readonly tabs: readonly IParadisAgentTabInfo[];
	readonly openedCount: number;
}>;

export type IParadisSelectAgentTabResult = IParadisAgentTabResult<{
	readonly tab: IParadisAgentTabInfo;
	readonly bound: boolean;
}>;

export type IParadisCloseAgentTabResult = IParadisAgentTabResult<{
	readonly openedCount: number;
}>;

/** 共有の要求が失敗した理由。 */
export type ParadisAgentPageRequestFailure =
	| ParadisAgentTabTargetFailure
	/** そのスペースに開いているブラウザのタブが無い（エージェントは open_browser_tab で開ける）。 */
	| 'noPages'
	/** このペインからの要求がまだ画面に出ている。 */
	| 'alreadyPending'
	/** ユーザーは承認したが、共有そのものに失敗した（upstream の共有確認で断られた場合を含む）。 */
	| 'shareFailed';

export type IParadisAgentPageRequestResult =
	| { readonly ok: true; readonly approved: true; readonly tab: IParadisAgentTabInfo }
	/** timedOut: 締め切りまでに答えが無かった（断られたのとは区別する）。 */
	| { readonly ok: true; readonly approved: false; readonly timedOut: boolean }
	| { readonly ok: false; readonly reason: ParadisAgentPageRequestFailure };

/**
 * エージェントが開いてよい URL か。http / https と about:blank だけを通す。
 * javascript: / file: / data: / 内部スキームは、エージェントに任せる理由が無く危ないので断る。
 */
export function paradisIsAllowedAgentTabUrl(url: string): boolean {
	if (url === 'about:blank') {
		return true;
	}
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/** URL の origin だけ（共有していないタブの URL をエージェントへ見せるとき）。読めなければ空文字。 */
export function paradisUrlOrigin(url: string | undefined): string {
	if (!url) {
		return '';
	}
	try {
		const origin = new URL(url).origin;
		return origin === 'null' ? '' : origin;
	} catch {
		return '';
	}
}

/**
 * 画面に出す文字列から、制御文字と見た目を偽れる不可視文字を取り除く。
 * C0 / C1 制御文字、ゼロ幅文字と LRM / RLM（U+200B〜U+200F）、埋め込みと上書きの双方向制御
 * （U+202A〜U+202E）、分離の双方向制御（U+2066〜U+2069）、BOM（U+FEFF）を空白へ寄せる。
 */
const PARADIS_UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * エージェントやページ由来の文字列を1行の表示用にする。危ない文字を空白へ寄せ、連続空白を畳み、
 * 長すぎるものは文字単位で切る（サロゲートペアの途中で割らない）。空になれば undefined。
 */
export function paradisSanitizeDisplayText(text: string | undefined, maxLength: number): string | undefined {
	if (typeof text !== 'string') {
		return undefined;
	}
	const flattened = text.replace(PARADIS_UNSAFE_DISPLAY_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
	if (!flattened) {
		return undefined;
	}
	const characters = Array.from(flattened);
	return characters.length > maxLength
		? `${characters.slice(0, maxLength).join('')}\u2026`
		: flattened;
}

/** エージェントが書いた要求の理由をダイアログへ出せる形にする。 */
export function paradisSanitizeAgentPageRequestReason(reason: string | undefined): string | undefined {
	return paradisSanitizeDisplayText(reason, PARADIS_AGENT_PAGE_REQUEST_REASON_MAX_LENGTH);
}

/**
 * エージェントが開いたタブの台帳（純粋なデータ構造）。renderer の ParadisAgentBrowserTabsService が持ち、
 * ブラウザやエディタには触らない。ユーザーのタブの承認はここに持たない: ユーザーのタブを使えるのは
 * 共有されている間だけで、共有の状態そのものはバインドの台帳が持っている。
 */
export class ParadisAgentTabLedger {

	/** viewId → そのタブを開いたペインのトークン。 */
	private readonly _agentTabs = new Map<string, string>();
	/** token → 開いている途中のタブの数。 */
	private readonly _reserved = new Map<string, number>();

	constructor(private readonly _limit: number = PARADIS_AGENT_TAB_LIMIT) { }

	openedCount(token: string): number {
		let count = 0;
		for (const owner of this._agentTabs.values()) {
			if (owner === token) {
				count++;
			}
		}
		return count;
	}

	/** そのペインのタブを新しく開く枠を取る。上限なら false。取ったら必ず {@link releaseSlot} する。 */
	tryReserveSlot(token: string): boolean {
		const reserved = this._reserved.get(token) ?? 0;
		if (this.openedCount(token) + reserved >= this._limit) {
			return false;
		}
		this._reserved.set(token, reserved + 1);
		return true;
	}

	releaseSlot(token: string): void {
		const remaining = (this._reserved.get(token) ?? 1) - 1;
		if (remaining > 0) {
			this._reserved.set(token, remaining);
		} else {
			this._reserved.delete(token);
		}
	}

	registerAgentTab(token: string, viewId: string): boolean {
		if (this._agentTabs.has(viewId)) {
			return false;
		}
		this._agentTabs.set(viewId, token);
		return true;
	}

	isOpenedBy(token: string, viewId: string): boolean {
		return this._agentTabs.get(viewId) === token;
	}

	isAgentTab(viewId: string): boolean {
		return this._agentTabs.has(viewId);
	}

	agentTabsOf(token: string): string[] {
		return [...this._agentTabs].filter(([, owner]) => owner === token).map(([viewId]) => viewId);
	}

	/** タブが閉じられた。 */
	forget(viewId: string): void {
		this._agentTabs.delete(viewId);
	}
}
