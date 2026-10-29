/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDP ゲートウェイで、ブラウザ拡張のものをエージェントから隠すための判定。
//
// 拡張は共有したページの中に 2 つの形で入り込む（Electron 43.7.7 で実測、2026-10-29）:
//  - 拡張のページを入れた iframe（パスワード管理のページ内メニューなど）。別プロセスの iframe なので、
//    共有したページのセッションに `Target.attachedToTarget`（type: iframe、url: chrome-extension://…）で現れる
//  - content script の isolated world。`Runtime.executionContextCreated` で、name に拡張の名前、
//    origin に `chrome-extension://<id>` が入る。名前はエージェントが `Page.createIsolatedWorld` で同じ名前を
//    指定すれば揃えられるが、そうして作った world の origin はページの origin になる
// どちらも origin（URL）で見分ける。拡張の中へ入られると、拡張の UI を押したり、拡張の背景へ
// `chrome.runtime.sendMessage` で話しかけたりできてしまう。
//
// CDP の `Page.navigate` は、ウェブに公開していない拡張のページ（オプションなど）へも移れる（同じく実測。
// 大文字の `CHROME-EXTENSION://` も通る。`blob:` / `filesystem:` で包んだ形は net::ERR_ABORTED で止まる）。

import { paradisIsBrowserExtensionUrl } from '../../../../platform/browserView/common/paradisExtensionPageHold.js';

export { paradisIsBrowserExtensionUrl };

/** 隠した拡張の frame の代わりに見せる URL。 */
export const PARADIS_HIDDEN_EXTENSION_FRAME_URL = 'about:blank#para-code-hidden-extension-frame';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 拡張の frame なら URL と origin を伏せた写しを返す。拡張の frame でなければそのまま返す。 */
function redactFrame(frame: Record<string, unknown>): Record<string, unknown> {
	if (!paradisIsBrowserExtensionUrl(frame.url) && !paradisIsBrowserExtensionUrl(frame.securityOrigin) && !paradisIsBrowserExtensionUrl(frame.unreachableUrl)) {
		return frame;
	}
	const { urlFragment: _urlFragment, unreachableUrl: _unreachableUrl, securityOriginDetails: _securityOriginDetails, ...rest } = frame;
	return { ...rest, url: PARADIS_HIDDEN_EXTENSION_FRAME_URL, securityOrigin: 'null', domainAndRegistry: '' };
}

/** `Page.getFrameTree` / `Page.getResourceTree` の frameTree を、拡張の frame を伏せて写す。 */
function redactFrameTree(tree: unknown, depth = 0): unknown {
	if (!isRecord(tree) || depth > 64) {
		return tree;
	}
	const frame = isRecord(tree.frame) ? redactFrame(tree.frame) : tree.frame;
	const hidden = frame !== tree.frame;
	const resources = Array.isArray(tree.resources)
		? (hidden ? [] : tree.resources.filter(resource => !(isRecord(resource) && paradisIsBrowserExtensionUrl(resource.url))))
		: tree.resources;
	const childFrames = Array.isArray(tree.childFrames) ? tree.childFrames.map(child => redactFrameTree(child, depth + 1)) : tree.childFrames;
	return {
		...tree,
		frame,
		...(resources !== undefined ? { resources } : {}),
		...(childFrames !== undefined ? { childFrames } : {}),
	};
}

/** スタックトレース（`Runtime.StackTrace`）のどこかに拡張のスクリプトがあるか。 */
function stackMentionsExtension(stack: unknown, depth = 0): boolean {
	if (!isRecord(stack) || depth > 64) {
		return false;
	}
	const frames = Array.isArray(stack.callFrames) ? stack.callFrames : [];
	return frames.some(frame => isRecord(frame) && paradisIsBrowserExtensionUrl(frame.url)) || stackMentionsExtension(stack.parent, depth + 1);
}

/**
 * ページのイベントから、拡張の frame の URL（拡張の ID が入る）と、拡張の content script の位置を伏せる。
 * 伏せるものが無ければ undefined（元のフレームをそのまま送る）。
 */
export function paradisRedactExtensionFrameEvent(method: string, params: unknown): Record<string, unknown> | undefined {
	if (!isRecord(params)) {
		return undefined;
	}
	switch (method) {
		case 'Page.frameNavigated': {
			if (!isRecord(params.frame)) {
				return undefined;
			}
			const frame = redactFrame(params.frame);
			return frame === params.frame ? undefined : { ...params, frame };
		}
		case 'Page.frameAttached': {
			if (!stackMentionsExtension(params.stack)) {
				return undefined;
			}
			const { stack: _stack, ...rest } = params;
			return rest;
		}
		case 'Page.frameRequestedNavigation':
		case 'Page.frameScheduledNavigation':
		case 'Page.frameStartedNavigating':
		case 'Page.navigatedWithinDocument':
			return paradisIsBrowserExtensionUrl(params.url) ? { ...params, url: PARADIS_HIDDEN_EXTENSION_FRAME_URL } : undefined;
		default:
			return undefined;
	}
}

/** `Page.getFrameTree` / `Page.getResourceTree` の応答から拡張の frame の URL を伏せる。対象外なら undefined。 */
export function paradisRedactExtensionFrameResponse(method: string, result: unknown): Record<string, unknown> | undefined {
	if ((method !== 'Page.getFrameTree' && method !== 'Page.getResourceTree') || !isRecord(result) || !isRecord(result.frameTree)) {
		return undefined;
	}
	return { ...result, frameTree: redactFrameTree(result.frameTree) };
}

/**
 * 共有したページが拡張のページにいる間も通す命令。ページから離れる命令と、CDP のクライアント（puppeteer）が
 * ページにつながるときに送る購読・準備の命令だけ。これを断ると、クライアントがページを使えないまま
 * 離れる命令（navigate_page）にもたどり着けない。購読で届くイベントは、拡張のページにいる間は
 * {@link paradisIsEventAllowedOnExtensionPage} で絞る。ページの中身を読む・操作する命令は通さない。
 */
const ALLOWED_ON_EXTENSION_PAGE = new Set([
	'Page.navigate',
	'Page.stopLoading',
	'Page.getFrameTree',
	'Page.setLifecycleEventsEnabled',
	'Page.createIsolatedWorld',
	'Page.setBypassCSP',
	'Runtime.runIfWaitingForDebugger',
	'Target.setAutoAttach',
	'Network.setExtraHTTPHeaders',
	'Network.setCacheDisabled',
	'Network.setUserAgentOverride',
	'Emulation.setFocusEmulationEnabled',
	'Emulation.setUserAgentOverride',
	'Emulation.setDeviceMetricsOverride',
	'Emulation.clearDeviceMetricsOverride',
	'Emulation.setTouchEmulationEnabled',
	'Emulation.setEmulatedMedia',
]);

/** ドメインの購読の開始・終了（`Runtime.enable` など）。 */
const DOMAIN_SUBSCRIPTION_METHOD = /^[A-Za-z]+\.(?:enable|disable)$/;

/**
 * 拡張のページにいる間も届けるイベント（ページの移動と、隠したうえで届く Runtime のコンテキスト）。
 * 拡張のページのダイアログ（Page.javascriptDialog*）は届けない（文面に拡張の中身が入る。応じるのは利用者）。
 */
const EVENTS_ALLOWED_ON_EXTENSION_PAGE = /^(?:Page\.(?:frame[A-Za-z]+|lifecycleEvent|loadEventFired|domContentEventFired|navigatedWithinDocument)|Target\.[A-Za-z]+|Runtime\.executionContext[A-Za-z]+|Inspector\.[A-Za-z]+)$/;

/** 拡張のページにいるセッションから、このイベントを届けてよいか。 */
export function paradisIsEventAllowedOnExtensionPage(method: string): boolean {
	return EVENTS_ALLOWED_ON_EXTENSION_PAGE.test(method);
}

/**
 * 拡張のページにいても通す命令か（ページから離れる命令と、つなぐときの購読・準備の命令）。これ以外の命令（ページの中身を
 * 読む・操作する命令）の前には、ページの URL を確かめる。
 */
export function paradisIsAllowedOnExtensionPage(method: string, params: unknown): boolean {
	if (method === 'Page.addScriptToEvaluateOnNewDocument') {
		// 次の文書から効くものだけ（今の拡張のページでは走らせない）
		return !(isRecord(params) && params.runImmediately === true);
	}
	return ALLOWED_ON_EXTENSION_PAGE.has(method) || DOMAIN_SUBSCRIPTION_METHOD.test(method);
}

/** 共有したページ（や許した子）が拡張のページにいるときに断る理由。 */
export const PARADIS_EXTENSION_PAGE_DENIED_MESSAGE = 'This page is showing a browser extension page (chrome-extension://). Para Code does not let agents read or operate browser extension pages. Navigate it to a website with Page.navigate (navigate_page), or ask the user to leave the extension page.';

/** 拡張の URL への移動を断る理由。 */
export const PARADIS_EXTENSION_NAVIGATION_DENIED_MESSAGE = 'Navigating to a browser extension page (chrome-extension://) is not permitted on the Para Code CDP gateway.';

/**
 * セッションのページが拡張のページにいるときに、その命令を断るか。断るなら理由、通すなら undefined。
 * 拡張の URL への `Page.navigate` は、ページがどこにいても断る。
 */
export function paradisExtensionPageDeniedMessage(method: string, params: unknown, pageIsExtension: boolean): string | undefined {
	if (method === 'Page.navigate' && isRecord(params) && paradisIsBrowserExtensionUrl(params.url)) {
		return PARADIS_EXTENSION_NAVIGATION_DENIED_MESSAGE;
	}
	// `javascript:` の移動は、今の文書（拡張のページ）の中でスクリプトを走らせる
	if (pageIsExtension && method === 'Page.navigate' && isRecord(params) && typeof params.url === 'string' && /^[\x00-\x20]*javascript:/i.test(params.url.replace(/[\t\n\r]/g, ''))) {
		return PARADIS_EXTENSION_PAGE_DENIED_MESSAGE;
	}
	return pageIsExtension && !paradisIsAllowedOnExtensionPage(method, params) ? PARADIS_EXTENSION_PAGE_DENIED_MESSAGE : undefined;
}

/**
 * 文書の始めのスクリプトを、拡張のページの文書（origin が chrome-extension:）では走らせない判定。
 * about:blank・srcdoc の iframe は作った文書の origin を受け継ぐので、`location.protocol` だけでなく `origin` も見る。
 * 文書の始めに走るので、ページのスクリプトが `origin` を書き換える前に判定できる。
 */
const NEW_DOCUMENT_EXTENSION_CHECK = '(function () { try { return /^chrome-extension:/i.test(String(globalThis.origin)) || /^chrome-extension:/i.test(location.protocol); } catch (e) { return true; } })()';

/**
 * `Page.addScriptToEvaluateOnNewDocument` の source を、拡張のページの文書では走らないように包んだ params を返す。
 * 普通のページで登録したスクリプトが、後で拡張のページへ移ったときに拡張の main world（worldName 付きなら
 * 拡張の origin の world）で走って中身を持ち出すのを防ぐ。`var` と関数の宣言が今までどおり大域に出るよう、
 * 関数ではなく if のブロックで包む。対象外なら undefined。
 */
export function paradisGuardNewDocumentScriptParams(method: string, params: unknown): Record<string, unknown> | undefined {
	if (method !== 'Page.addScriptToEvaluateOnNewDocument' || !isRecord(params) || typeof params.source !== 'string') {
		return undefined;
	}
	return { ...params, source: `if (!${NEW_DOCUMENT_EXTENSION_CHECK}) {\n${params.source}\n}` };
}

/**
 * ページの URL を確かめ直さずに信じてよい時間（ミリ秒）。中身を読む・操作する命令の前に、これより古ければ
 * `Target.getTargetInfo` で引き直す（購読しない素の接続でも、移った後のページを見落とさないため）。
 */
export const PARADIS_PAGE_URL_FRESH_MS = 500;

/** 読み込み中の新しいタブがまだ行き先を持っていない URL（空と about:blank）。 */
export function paradisIsUndecidedPageUrl(url: unknown): boolean {
	return url === undefined || url === '' || url === 'about:blank';
}
