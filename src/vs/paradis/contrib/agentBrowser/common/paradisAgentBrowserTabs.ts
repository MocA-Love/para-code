/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのタブ操作（q.html Q70 案A）と、ページ共有の「要求 → 承認」（Q88 案A）の
// shared process ⇔ renderer 契約。形は `open_browser_profile`（paradisBrowserProfileMcp.ts）に揃えてある:
// renderer は内部情報を含み得る文字列を返さず構造化された結果だけを返し、LLM 向けの英文への
// 翻訳は shared process 側（paradisAgentBrowserService.ts）が持つ。
//
// 規則:
//  - エージェントが開けるタブは1ペインあたり {@link PARADIS_AGENT_TAB_LIMIT} 枚まで
//  - 閉じられるのは、そのペインのエージェントが自分で開いたタブだけ（ユーザーのタブは閉じない）
//  - エージェントが開いたタブは最初から共有済み（承認済み）。ユーザーのタブは要求 → 承認を経る
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

/** 1ペインのエージェントが同時に開いておけるタブの上限（q.html Q70 案A）。 */
export const PARADIS_AGENT_TAB_LIMIT = 5;

/** 要求の理由（エージェントが書く文）を承認ダイアログへ出すときの最大文字数。 */
export const PARADIS_AGENT_PAGE_REQUEST_REASON_MAX_LENGTH = 300;

/**
 * 承認待ちの上限時間。この間に答えが無ければ shared process は「まだ答えが無い」と返す
 * （ダイアログは開いたまま残り、後から承認されれば共有される）。MCP の呼び出し全体の上限
 * （PARADIS_MCP_OVERALL_TIMEOUT_MS = 310 秒）より十分短くしてある。
 */
export const PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS = 120_000;

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

/** 共有の要求（Q88）が失敗した理由。 */
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
	| { readonly ok: true; readonly approved: false }
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

/**
 * エージェントが書いた理由をダイアログへ出せる形にする。制御文字を空白へ寄せ、連続空白を畳み、
 * 長すぎるものは文字単位で切る（サロゲートペアの途中で割らない）。
 */
export function paradisSanitizeAgentPageRequestReason(reason: string | undefined): string | undefined {
	if (typeof reason !== 'string') {
		return undefined;
	}
	const flattened = reason.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
	if (!flattened) {
		return undefined;
	}
	const characters = Array.from(flattened);
	return characters.length > PARADIS_AGENT_PAGE_REQUEST_REASON_MAX_LENGTH
		? `${characters.slice(0, PARADIS_AGENT_PAGE_REQUEST_REASON_MAX_LENGTH).join('')}…`
		: flattened;
}

/**
 * エージェントが開いたタブと、ペインごとの「共有してよいユーザーのタブ」の台帳（純粋なデータ構造）。
 * renderer の ParadisAgentBrowserTabsService が持ち、ブラウザやエディタには触らない。
 *
 * 承認済みのユーザーのタブ: ユーザーが共有した、または要求を承認したタブ。エージェントが自分のタブへ
 * 共有を移した後でも、select_browser_tab でそこへ戻れる。こちらが移したのではない共有の解除
 * （ユーザーが共有を止めた・別のタブへ付け替えた）を見たら、その承認は取り消す。
 */
export class ParadisAgentTabLedger {

	/** viewId → そのタブを開いたペインのトークン。 */
	private readonly _agentTabs = new Map<string, string>();
	/** token → 承認済みのユーザーのタブ。 */
	private readonly _approved = new Map<string, Set<string>>();
	/** token → 前回見たときに共有されていたページ。 */
	private readonly _lastBound = new Map<string, string>();
	/** token → こちらから共有を移している先。 */
	private readonly _switchingTo = new Map<string, string>();
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

	/** そのペインの agent tabs を新しく開く枠を取る。上限なら false。取ったら必ず {@link releaseSlot} する。 */
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
		for (const pages of this._approved.values()) {
			pages.delete(viewId);
		}
	}

	approve(token: string, viewId: string): void {
		let pages = this._approved.get(token);
		if (!pages) {
			pages = new Set();
			this._approved.set(token, pages);
		}
		pages.add(viewId);
	}

	isApproved(token: string, viewId: string): boolean {
		return this._approved.get(token)?.has(viewId) === true;
	}

	approvedOf(token: string): string[] {
		return [...this._approved.get(token) ?? []];
	}

	beginSwitch(token: string, viewId: string): void {
		this._switchingTo.set(token, viewId);
	}

	/**
	 * 共有を移し終えた。成功した場合、移った先の共有を {@link observeBindings} が見るまで印を残す
	 * （共有の変化の通知は、移す処理が終わった後に届くこともある）。
	 */
	endSwitch(token: string, viewId: string, succeeded: boolean): void {
		if (!succeeded && this._switchingTo.get(token) === viewId) {
			this._switchingTo.delete(token);
		}
	}

	/** 今の共有（token → pageId）を見て、承認の追加と取り消しを行う。 */
	observeBindings(bindings: Iterable<{ readonly token: string; readonly pageId: string }>): void {
		const current = new Map<string, string>();
		for (const binding of bindings) {
			current.set(binding.token, binding.pageId);
		}
		for (const [token, pageId] of current) {
			if (!this._agentTabs.has(pageId)) {
				this.approve(token, pageId);
			}
		}
		for (const [token, previous] of this._lastBound) {
			const now = current.get(token);
			if (now === previous) {
				continue;
			}
			if (now !== undefined && this._switchingTo.get(token) === now) {
				this._switchingTo.delete(token);
			} else {
				this._approved.get(token)?.delete(previous);
			}
		}
		for (const [token, pageId] of current) {
			if (!this._lastBound.has(token) && this._switchingTo.get(token) === pageId) {
				this._switchingTo.delete(token);
			}
		}
		this._lastBound.clear();
		for (const [token, pageId] of current) {
			this._lastBound.set(token, pageId);
		}
	}
}
