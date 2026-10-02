/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルのブラウザのミラーが CDP から読んだものを、モバイルへ送る形（`paradisMobileBrowserProtocol.ts`）に
// 直す純関数と、ページへ入れる注入スクリプト（browser.page.v1 / browser.focus.v1）。

import {
	IParadisMobileBrowserFocus,
	IParadisMobileBrowserPage,
	PARADIS_MOBILE_BROWSER_FOCUS_VALUE_MAX,
	PARADIS_MOBILE_BROWSER_TITLE_MAX,
	PARADIS_MOBILE_BROWSER_URL_MAX,
	ParadisMobileBrowserFieldKind,
} from './paradisMobileBrowserProtocol.js';

/** 注入スクリプトを動かす分離ワールドの名前。ページ本体の JavaScript からは見えない。 */
export const PARADIS_MOBILE_FOCUS_WORLD = '__paraMobileFocusWorld';
/** 分離ワールドだけに出すバインディングの名前（`Runtime.addBinding` の `executionContextName` で絞る）。 */
export const PARADIS_MOBILE_FOCUS_BINDING = '__paraMobileFocus';
/** フォーカスとみなすのはタップを送ってからこの時間の内（ms）。 */
export const PARADIS_MOBILE_FOCUS_TAP_WINDOW_MS = 1000;
/** 注入スクリプトからの 1 回の報告の上限（文字数）。 */
const MAX_REPORT_LENGTH = PARADIS_MOBILE_BROWSER_FOCUS_VALUE_MAX * 2 + 1024;

/**
 * 分離ワールドへ入れるスクリプト。focusin / focusout（capture）と input（300ms 間引き）で
 * フォーカス中の欄を調べ、バインディングで JSON を送る。
 *
 * - 欄には `WeakMap` で番号（`fieldId`）を振る。`replace` はこの番号の欄にフォーカスがあるときだけ選ぶ
 *   （`__paraMobileFocusSelect(fieldId)`）。番号の起点は入れるたびに乱数にする（文書が替わってスクリプトが
 *   入れ直されても、前の文書の欄の番号が新しい文書の欄と一致しないように）
 * - `__paraMobileFocusReport('tap')` で今のフォーカスを送らせる
 * - 同じ分離ワールドを複数のミラー（複数のスマホ）が使うので、入れた回数を数える。`__paraMobileFocusDispose()`
 *   は 1 つ減らし、最後の 1 つのときだけリスナーを外す
 * - バインディングは呼ぶたびに引く（前のミラーの CDP の接続が切れて作り直されても、新しい方へ届く）
 * - contenteditable の中身は送らない（書式を持つので文字だけで置き換えない）
 */
export const PARADIS_MOBILE_FOCUS_SCRIPT = `(() => {
	const g = globalThis;
	g.__paraMobileFocusRefs = (g.__paraMobileFocusRefs || 0) + 1;
	if (g.__paraMobileFocusInstalled) { return; }
	g.__paraMobileFocusInstalled = true;
	const bindingName = ${JSON.stringify(PARADIS_MOBILE_FOCUS_BINDING)};
	const textTypes = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password']);
	const max = ${PARADIS_MOBILE_BROWSER_FOCUS_VALUE_MAX};
	const ids = new WeakMap();
	let nextId = Math.floor(Math.random() * 2 ** 40) + 1;
	const idOf = el => { let id = ids.get(el); if (id === undefined) { id = nextId++; ids.set(el, id); } return id; };
	const active = () => {
		let el = document.activeElement;
		while (el && el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; }
		return el;
	};
	const editable = el => {
		if (!el) { return undefined; }
		if (el.tagName === 'TEXTAREA') { return el.readOnly || el.disabled ? undefined : 'textarea'; }
		if (el.tagName === 'INPUT') {
			const type = String(el.getAttribute('type') || '').toLowerCase();
			return !textTypes.has(type) || el.readOnly || el.disabled ? undefined : 'text';
		}
		return el.isContentEditable ? 'contenteditable' : undefined;
	};
	const describe = () => {
		const el = active();
		const field = editable(el);
		if (field === undefined) { return { focused: false }; }
		const fieldId = idOf(el);
		if (field === 'textarea') { return { focused: true, fieldId, field, value: String(el.value) }; }
		if (field === 'contenteditable') { return { focused: true, fieldId, field }; }
		const type = String(el.getAttribute('type') || '').toLowerCase();
		return type === 'password'
			? { focused: true, fieldId, field, inputType: 'password', secret: true }
			: { focused: true, fieldId, field, inputType: type || 'text', value: String(el.value) };
	};
	const report = reason => {
		try {
			const send = g[bindingName];
			if (typeof send !== 'function') { return; }
			const d = describe();
			d.reason = reason;
			if (typeof d.value === 'string' && d.value.length > max) { d.value = d.value.slice(0, max); d.truncated = true; }
			send(JSON.stringify(d));
		} catch { }
	};
	let timer;
	const onFocusIn = () => report('focus');
	const onFocusOut = () => setTimeout(() => report('focus'), 0);
	const onInput = () => { clearTimeout(timer); timer = setTimeout(() => report('input'), 300); };
	document.addEventListener('focusin', onFocusIn, true);
	document.addEventListener('focusout', onFocusOut, true);
	document.addEventListener('input', onInput, true);
	g.__paraMobileFocusReport = report;
	g.__paraMobileFocusSelect = fieldId => {
		const el = active();
		const field = editable(el);
		if (field !== 'text' && field !== 'textarea') { return false; }
		if (ids.get(el) !== fieldId) { return false; }
		try { el.focus(); el.select(); return true; } catch { return false; }
	};
	g.__paraMobileFocusDispose = () => {
		g.__paraMobileFocusRefs = Math.max(0, (g.__paraMobileFocusRefs || 0) - 1);
		if (g.__paraMobileFocusRefs > 0) { return; }
		clearTimeout(timer);
		document.removeEventListener('focusin', onFocusIn, true);
		document.removeEventListener('focusout', onFocusOut, true);
		document.removeEventListener('input', onInput, true);
		delete g.__paraMobileFocusReport;
		delete g.__paraMobileFocusSelect;
		delete g.__paraMobileFocusDispose;
		g.__paraMobileFocusInstalled = false;
	};
})();`;

/** 今のフォーカスをタップの結果として報告させる式（分離ワールドで評価する）。 */
export const PARADIS_MOBILE_FOCUS_REPORT_TAP_EXPRESSION = `typeof globalThis.__paraMobileFocusReport === 'function' && (globalThis.__paraMobileFocusReport('tap'), true)`;

/** 今のフォーカスを知らせ直させる式（`replace` を断った後。タップ扱いにはしない）。 */
export const PARADIS_MOBILE_FOCUS_REPORT_CURRENT_EXPRESSION = `typeof globalThis.__paraMobileFocusReport === 'function' && (globalThis.__paraMobileFocusReport('input'), true)`;

/** 注入スクリプトのリスナーを外す式（ミラーを止めるとき）。 */
export const PARADIS_MOBILE_FOCUS_DISPOSE_EXPRESSION = `typeof globalThis.__paraMobileFocusDispose === 'function' && (globalThis.__paraMobileFocusDispose(), true)`;

/**
 * `fieldId` の欄にフォーカスがあるときだけ、その中身を全部選ぶ式（`replace` の前に評価する）。選べたら true。
 * 欄が替わっていた・contenteditable・番号が分からないときは false（置き換えない）。
 */
export function paradisMobileFocusSelectExpression(fieldId: number): string {
	const id = Number.isSafeInteger(fieldId) && fieldId > 0 ? fieldId : 0;
	return `typeof globalThis.__paraMobileFocusSelect === 'function' && globalThis.__paraMobileFocusSelect(${id}) === true`;
}

const FIELD_KINDS: readonly ParadisMobileBrowserFieldKind[] = ['text', 'textarea', 'contenteditable'];

/**
 * 注入スクリプトの報告をモバイルへ送る形に直す。ページから偽装されうる前提で、型・長さを確かめる
 * （分離ワールドのバインディングはページ本体から呼べないが、念のため）。
 * `fromTap` はタップの直後の報告（`reason: 'tap'`）か、タップから {@link PARADIS_MOBILE_FOCUS_TAP_WINDOW_MS} 以内のフォーカスの変化。
 */
export function paradisNormalizeMobileBrowserFocusReport(raw: unknown, context: { readonly targetId: string; readonly seq: number; readonly now: number; readonly lastTapAt: number }): IParadisMobileBrowserFocus | undefined {
	if (typeof raw !== 'string' || raw.length > MAX_REPORT_LENGTH) {
		return undefined;
	}
	let report: { focused?: unknown; fieldId?: unknown; field?: unknown; inputType?: unknown; secret?: unknown; value?: unknown; truncated?: unknown; reason?: unknown };
	try {
		report = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (report === null || typeof report !== 'object' || typeof report.focused !== 'boolean') {
		return undefined;
	}
	const fromTap = report.reason === 'tap' || (report.reason === 'focus' && context.now - context.lastTapAt <= PARADIS_MOBILE_FOCUS_TAP_WINDOW_MS);
	if (!report.focused) {
		return { t: 'focus', targetId: context.targetId, seq: context.seq, focused: false };
	}
	const field = FIELD_KINDS.find(kind => kind === report.field);
	if (field === undefined) {
		return undefined;
	}
	const inputType = typeof report.inputType === 'string' && /^[a-z-]{1,40}$/.test(report.inputType) ? report.inputType : undefined;
	const secret = report.secret === true || inputType === 'password';
	const fieldId = typeof report.fieldId === 'number' && Number.isSafeInteger(report.fieldId) && report.fieldId > 0 ? report.fieldId : undefined;
	let value: string | undefined;
	let truncated = report.truncated === true;
	if (!secret && field !== 'contenteditable' && typeof report.value === 'string') {
		value = report.value;
		if (value.length > PARADIS_MOBILE_BROWSER_FOCUS_VALUE_MAX) {
			value = value.slice(0, PARADIS_MOBILE_BROWSER_FOCUS_VALUE_MAX);
			truncated = true;
		}
	}
	return {
		t: 'focus', targetId: context.targetId, seq: context.seq, focused: true,
		...(fieldId !== undefined ? { fieldId } : {}),
		field,
		...(inputType !== undefined ? { inputType } : {}),
		...(secret ? { secret: true } : {}),
		...(value !== undefined ? { value } : {}),
		...(value !== undefined && truncated ? { truncated: true } : {}),
		...(fromTap ? { fromTap: true } : {}),
	};
}

/** ミラーが持つページの状態（`targetId` を除いた `IParadisMobileBrowserPage`）。 */
export interface IParadisMobileBrowserPageState {
	url: string;
	title: string;
	loading: boolean;
	progress: number;
	canGoBack: boolean;
	canGoForward: boolean;
}

function clip(value: unknown, max: number): string {
	return typeof value === 'string' ? value.slice(0, max) : '';
}

/** `Page.getNavigationHistory` の結果から URL・題名・戻る/進むの可否を読む。形が違えば `undefined`。 */
export function paradisMobileBrowserHistoryState(result: unknown): Pick<IParadisMobileBrowserPageState, 'url' | 'title' | 'canGoBack' | 'canGoForward'> | undefined {
	const history = result as { currentIndex?: unknown; entries?: unknown } | undefined;
	if (history === null || typeof history !== 'object' || typeof history.currentIndex !== 'number' || !Array.isArray(history.entries)) {
		return undefined;
	}
	const index = history.currentIndex;
	const entry = history.entries[index] as { url?: unknown; title?: unknown } | undefined;
	if (!Number.isInteger(index) || index < 0 || entry === null || typeof entry !== 'object') {
		return undefined;
	}
	return {
		url: clip(entry.url, PARADIS_MOBILE_BROWSER_URL_MAX),
		title: clip(entry.title, PARADIS_MOBILE_BROWSER_TITLE_MAX),
		canGoBack: index > 0,
		canGoForward: index < history.entries.length - 1,
	};
}

/** `Page.lifecycleEvent` の名前から進み具合を進める（戻さない）。知らない名前はそのまま。 */
export function paradisMobileBrowserLifecycleProgress(current: number, name: unknown): number {
	switch (name) {
		case 'init':
			return Math.max(current, 0.1);
		case 'DOMContentLoaded':
			return Math.max(current, 0.6);
		case 'load':
			return 1;
		default:
			return current;
	}
}

/** モバイルへ送る形にする。 */
export function paradisMobileBrowserPageMessage(targetId: string, state: IParadisMobileBrowserPageState): IParadisMobileBrowserPage {
	return {
		t: 'page', targetId,
		url: clip(state.url, PARADIS_MOBILE_BROWSER_URL_MAX),
		title: clip(state.title, PARADIS_MOBILE_BROWSER_TITLE_MAX),
		loading: state.loading,
		progress: Math.round(Math.min(1, Math.max(0, state.progress)) * 100) / 100,
		canGoBack: state.canGoBack,
		canGoForward: state.canGoForward,
	};
}
