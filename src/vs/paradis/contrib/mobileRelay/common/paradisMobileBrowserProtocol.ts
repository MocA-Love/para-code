/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルのブラウザ画面（案A）で PC とやり取りする形と、その読み方。
 *
 * **このファイルは import を持たない。** モバイルアプリ（`app/mobile`）が相対パスで直接 import する
 * （`paradisMobileBrowserKeys.ts` と同じ扱い）。PC が組み立てる形とアプリが読む形を 1 か所に置き、
 * 片方だけ直って食い違うのを防ぐ。読む側は相手を信用しない前提で、形と長さを確かめてから使う。
 *
 * | capability | 中身 |
 * |---|---|
 * | `browser.space.v1` | browser の `targets` に `windowId` と `ws`（スペースの `sourceId`）を足すと、そのスペースのページだけを返す（応答に `scoped: true`）。fs の `openUrl` に `ws` を足すと、そのスペースに開く |
 * | `browser.page.v1` | ミラー中のページの状態の通知 `t: 'page'`。入力 `stop`（読み込みの停止）と `open`（アドレス欄の生の文字。URL か検索かは PC が決める） |
 * | `browser.focus.v1` | ページの入力欄のフォーカスの通知 `t: 'focus'`。入力 `replace`（欄の中身を全部置き換える。`fieldId` の欄にフォーカスがあるときだけ）と、断った知らせ `t: 'inputRejected'`。PC はアプリがこの capability を広告しているときだけ `focus` を送る |
 * | `browser.bookmarks.v1` | fs の要求 `bookmarks`（ブックマークの一覧）と、変わったときの通知 `t: 'bookmarksChanged'`（fs、`id` なし） |
 */

/** ミラー中のページの状態（browser チャネル、PC → モバイル、`id` なし）。変わったときだけ送る。 */
export interface IParadisMobileBrowserPage {
	readonly t: 'page';
	readonly targetId: string;
	readonly url: string;
	readonly title: string;
	readonly loading: boolean;
	/** 読み込みの進み具合（0..1）。CDP は割合を持たないので、開始・DOMContentLoaded・load の 3 段階で進める。 */
	readonly progress: number;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
}

/** フォーカスした欄の種類。`text` は `<input>`（文字を入れる種類のもの）、`textarea`、`contenteditable`。 */
export type ParadisMobileBrowserFieldKind = 'text' | 'textarea' | 'contenteditable';

/** ページの入力欄のフォーカス（browser チャネル、PC → モバイル、`id` なし）。 */
export interface IParadisMobileBrowserFocus {
	readonly t: 'focus';
	readonly targetId: string;
	/** ミラーのセッションの中で増える番号。古い通知が後から届いたら捨てる。 */
	readonly seq: number;
	readonly focused: boolean;
	/**
	 * 欄の番号（ページの中で欄ごとに振る。ページを読み直すと振り直す）。`replace` に付けて送り、PC はその欄に
	 * フォーカスがあるときだけ置き換える（別の欄の中身を、直しかけの文字で上書きしないため）。
	 */
	readonly fieldId?: number;
	readonly field?: ParadisMobileBrowserFieldKind;
	/** `<input>` の `type`（`text` / `search` / `email` / `url` / `tel` / `number` / `password` など）。 */
	readonly inputType?: string;
	/** パスワードの欄。`value` は送らない。 */
	readonly secret?: boolean;
	/**
	 * 欄に入っている文字（パスワード以外）。長すぎるものは先頭だけで `truncated: true`。contenteditable は送らない
	 * （書式・リンク・画像を持つので、文字だけで置き換えると消える。文字を足す方式にする）。
	 */
	readonly value?: string;
	readonly truncated?: boolean;
	/** モバイルのタップで入ったフォーカスか（タップの直後 1 秒以内のフォーカスと、タップした欄が既にフォーカスを持っていた場合）。 */
	readonly fromTap?: boolean;
}

/** 入力を断った知らせ（browser チャネル、PC → モバイル、`id` なし）。 */
export interface IParadisMobileBrowserInputRejected {
	readonly t: 'inputRejected';
	readonly targetId: string;
	readonly kind: 'replace' | 'text' | 'open';
	/** `field-changed` 欄が替わった・無い / `too-long` 長すぎる。 */
	readonly reason: 'field-changed' | 'too-long';
}

/** ブックマーク 1 件（fs の `bookmarks` の応答）。`favicon` は `favicons` の鍵。 */
export interface IParadisMobileBookmark {
	readonly type: 'bookmark';
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly favicon?: string;
}

/** ブックマークのフォルダ。`icon` は PC の 9 種のアイコンの名前（`ParadisFolderIconKey`）。 */
export interface IParadisMobileBookmarkFolder {
	readonly type: 'folder';
	readonly id: string;
	readonly title: string;
	readonly icon?: string;
	readonly color?: string;
	readonly children: readonly ParadisMobileBookmarkNode[];
}

export type ParadisMobileBookmarkNode = IParadisMobileBookmark | IParadisMobileBookmarkFolder;

/** fs の `bookmarks` の応答（`id` は応答の宛先として別に付く）。 */
export interface IParadisMobileBookmarks {
	readonly t: 'bookmarks';
	readonly nodes: readonly ParadisMobileBookmarkNode[];
	/** favicon の鍵 → `data:image/...` の URI。 */
	readonly favicons: { readonly [hash: string]: string };
}

/** 入力欄の文字として送る上限（文字数）。超えたら先頭だけを送り `truncated: true`。 */
export const PARADIS_MOBILE_BROWSER_FOCUS_VALUE_MAX = 4000;
/** URL と題名の上限（文字数）。 */
export const PARADIS_MOBILE_BROWSER_URL_MAX = 8192;
export const PARADIS_MOBILE_BROWSER_TITLE_MAX = 1000;
/** ブックマークの上限。数・深さ・favicon 1 枚の大きさ・favicon の合計。 */
export const PARADIS_MOBILE_BOOKMARKS_MAX_NODES = 2000;
export const PARADIS_MOBILE_BOOKMARKS_MAX_DEPTH = 8;
export const PARADIS_MOBILE_BOOKMARK_FAVICON_MAX = 24 * 1024;
export const PARADIS_MOBILE_BOOKMARK_FAVICONS_TOTAL_MAX = 768 * 1024;
/** `open` / `replace` の文字の上限。 */
export const PARADIS_MOBILE_BROWSER_INPUT_TEXT_MAX = 8192;

function record(value: unknown): { readonly [key: string]: unknown } | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as { readonly [key: string]: unknown } : undefined;
}

function shortString(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length <= max ? value : undefined;
}

/** ページの状態の通知を読む。形が違えば `undefined`。 */
export function paradisParseMobileBrowserPage(value: unknown): IParadisMobileBrowserPage | undefined {
	const message = record(value);
	if (message === undefined || message.t !== 'page') {
		return undefined;
	}
	const targetId = shortString(message.targetId, 500);
	const url = shortString(message.url, PARADIS_MOBILE_BROWSER_URL_MAX);
	const title = shortString(message.title, PARADIS_MOBILE_BROWSER_TITLE_MAX);
	if (targetId === undefined || targetId.length === 0 || url === undefined || title === undefined
		|| typeof message.loading !== 'boolean' || typeof message.canGoBack !== 'boolean' || typeof message.canGoForward !== 'boolean') {
		return undefined;
	}
	const progress = typeof message.progress === 'number' && Number.isFinite(message.progress) ? Math.min(1, Math.max(0, message.progress)) : (message.loading ? 0 : 1);
	return { t: 'page', targetId, url, title, loading: message.loading, progress, canGoBack: message.canGoBack, canGoForward: message.canGoForward };
}

const FIELD_KINDS: readonly ParadisMobileBrowserFieldKind[] = ['text', 'textarea', 'contenteditable'];

/** フォーカスの通知を読む。形が違えば `undefined`。パスワードの欄に `value` が付いていても捨てる。 */
export function paradisParseMobileBrowserFocus(value: unknown): IParadisMobileBrowserFocus | undefined {
	const message = record(value);
	if (message === undefined || message.t !== 'focus') {
		return undefined;
	}
	const targetId = shortString(message.targetId, 500);
	if (targetId === undefined || targetId.length === 0 || typeof message.seq !== 'number' || !Number.isSafeInteger(message.seq) || typeof message.focused !== 'boolean') {
		return undefined;
	}
	if (!message.focused) {
		return { t: 'focus', targetId, seq: message.seq, focused: false };
	}
	const field = FIELD_KINDS.find(kind => kind === message.field);
	if (field === undefined) {
		return undefined;
	}
	const inputType = shortString(message.inputType, 40);
	const secret = message.secret === true || inputType?.toLowerCase() === 'password';
	const text = secret || field === 'contenteditable' ? undefined : shortString(message.value, PARADIS_MOBILE_BROWSER_FOCUS_VALUE_MAX);
	const fieldId = typeof message.fieldId === 'number' && Number.isSafeInteger(message.fieldId) && message.fieldId > 0 ? message.fieldId : undefined;
	return {
		t: 'focus', targetId, seq: message.seq, focused: true,
		...(fieldId !== undefined ? { fieldId } : {}),
		field,
		...(inputType !== undefined ? { inputType } : {}),
		...(secret ? { secret: true } : {}),
		...(text !== undefined ? { value: text } : {}),
		...(text !== undefined && message.truncated === true ? { truncated: true } : {}),
		...(message.fromTap === true ? { fromTap: true } : {}),
	};
}

const REJECTED_KINDS: readonly IParadisMobileBrowserInputRejected['kind'][] = ['replace', 'text', 'open'];
const REJECTED_REASONS: readonly IParadisMobileBrowserInputRejected['reason'][] = ['field-changed', 'too-long'];

/** 入力を断った知らせを読む。形が違えば `undefined`。 */
export function paradisParseMobileBrowserInputRejected(value: unknown): IParadisMobileBrowserInputRejected | undefined {
	const message = record(value);
	const targetId = shortString(message?.targetId, 500);
	const kind = REJECTED_KINDS.find(candidate => candidate === message?.kind);
	const reason = REJECTED_REASONS.find(candidate => candidate === message?.reason);
	return message?.t === 'inputRejected' && targetId !== undefined && targetId.length > 0 && kind !== undefined && reason !== undefined
		? { t: 'inputRejected', targetId, kind, reason }
		: undefined;
}

function parseBookmarkNodes(value: unknown, depth: number, budget: { nodes: number }): ParadisMobileBookmarkNode[] {
	if (!Array.isArray(value) || depth > PARADIS_MOBILE_BOOKMARKS_MAX_DEPTH) {
		return [];
	}
	const nodes: ParadisMobileBookmarkNode[] = [];
	for (const entry of value) {
		if (budget.nodes >= PARADIS_MOBILE_BOOKMARKS_MAX_NODES) {
			break;
		}
		const node = record(entry);
		const id = shortString(node?.id, 200);
		const title = shortString(node?.title, PARADIS_MOBILE_BROWSER_TITLE_MAX) ?? '';
		if (node === undefined || id === undefined || id.length === 0) {
			continue;
		}
		if (node.type === 'bookmark') {
			const url = shortString(node.url, PARADIS_MOBILE_BROWSER_URL_MAX);
			if (url === undefined || url.length === 0) {
				continue;
			}
			const favicon = shortString(node.favicon, 200);
			budget.nodes++;
			nodes.push({ type: 'bookmark', id, title, url, ...(favicon !== undefined && favicon.length > 0 ? { favicon } : {}) });
		} else if (node.type === 'folder') {
			const icon = shortString(node.icon, 40);
			const color = typeof node.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(node.color) ? node.color : undefined;
			budget.nodes++;
			const children = parseBookmarkNodes(node.children, depth + 1, budget);
			nodes.push({ type: 'folder', id, title, ...(icon !== undefined ? { icon } : {}), ...(color !== undefined ? { color } : {}), children });
		}
	}
	return nodes;
}

/** fs の `bookmarks` の応答を読む。数・深さの上限を超えた分と、壊れた項目は落とす。 */
export function paradisParseMobileBookmarks(value: unknown): IParadisMobileBookmarks | undefined {
	const message = record(value);
	if (message === undefined || !Array.isArray(message.nodes)) {
		return undefined;
	}
	const nodes = parseBookmarkNodes(message.nodes, 1, { nodes: 0 });
	const favicons: { [hash: string]: string } = {};
	const rawFavicons = record(message.favicons);
	let total = 0;
	for (const [hash, uri] of Object.entries(rawFavicons ?? {})) {
		if (hash.length > 200 || typeof uri !== 'string' || uri.length > PARADIS_MOBILE_BOOKMARK_FAVICON_MAX || !/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(uri)) {
			continue;
		}
		if (total + uri.length > PARADIS_MOBILE_BOOKMARK_FAVICONS_TOTAL_MAX) {
			break;
		}
		total += uri.length;
		favicons[hash] = uri;
	}
	return { t: 'bookmarks', nodes, favicons };
}
