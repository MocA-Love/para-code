/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタエリアのターミナル右上（ブラウザ共有のドットのすぐ左）に出す、コンテキストの使用率の輪と %。
// 押すと内訳のポップオーバー（electron-browser の paradisContextUsage.contribution.ts）が開く。
//
// エディタのターミナルへ重ねる登録口（paradisRegisterEditorTerminalOverlay）から作られ、対象ペインはタブの
// 切り替えのたびに setInstance で差し替わる。値とポップオーバーは登録した contribution（ホスト）が持つ。

import { $, addDisposableListener, append, EventType, getActiveElement, isAncestor, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IParadisEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import './media/paradisAgentInsights.css';

/** これ以上で警告色（upstream のチャットのコンテキストの輪と同じ境目）。 */
const WARNING_PERCENT = 75;
/** これ以上で危険色。 */
const ERROR_PERCENT = 90;

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 14;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export type ParadisContextUsageSeverity = 'normal' | 'warning' | 'error';

/** 使用率の色の段階。 */
export function paradisContextUsageSeverity(percent: number): ParadisContextUsageSeverity {
	if (percent >= ERROR_PERCENT) {
		return 'error';
	}
	return percent >= WARNING_PERCENT ? 'warning' : 'normal';
}

/** ポップオーバーの外枠（上下左右の線 1px ずつ）と、中身の左右の余白（compact のホバーの 8px ずつ）。 */
const POPOVER_CHROME_WIDTH = 2 + 16;
/** ポップオーバーの外枠・中身の上下の余白（2px ずつ）・三角のポインタ（3px）。 */
const POPOVER_CHROME_HEIGHT = 2 + 4 + 3;
/** ターミナルの縁から空ける量。 */
const POPOVER_EDGE_MARGIN = 4;
const POPOVER_PREFERRED_WIDTH = 300;
const POPOVER_PREFERRED_MAX_HEIGHT = 520;
const POPOVER_MIN_HEIGHT = 60;

/** 画面上の矩形のうち、ポップオーバーの大きさを決めるのに使う辺。 */
export interface IParadisContextUsageRect {
	readonly left: number;
	readonly right: number;
	readonly bottom: number;
}

/** ポップオーバーの中身の幅と高さの上限（px）。 */
export interface IParadisContextUsagePopoverSize {
	readonly width: number;
	readonly maxHeight: number;
}

/**
 * 内訳のポップオーバーを、輪の右端にそろえて左向きに開いたとき、ターミナル（`frame`）の中に収まる中身の大きさ。
 * 幅は既定の 300px か、輪の右端からターミナルの左端までの残りの狭いほう。高さは輪の下からターミナルの下端まで。
 * 低すぎるターミナルでは中身が読めなくなるので、高さだけは最低限を残す。
 */
export function paradisContextUsagePopoverSize(anchor: IParadisContextUsageRect, frame: IParadisContextUsageRect): IParadisContextUsagePopoverSize {
	const width = Math.min(POPOVER_PREFERRED_WIDTH, anchor.right - frame.left - POPOVER_EDGE_MARGIN - POPOVER_CHROME_WIDTH);
	const maxHeight = Math.min(POPOVER_PREFERRED_MAX_HEIGHT, frame.bottom - anchor.bottom - POPOVER_EDGE_MARGIN - POPOVER_CHROME_HEIGHT);
	return { width: Math.max(0, Math.floor(width)), maxHeight: Math.max(POPOVER_MIN_HEIGHT, Math.floor(maxHeight)) };
}

/** 描き直しの前後で同じ要素とみなすための、フォーカスを受ける要素の印（`data-paradis-focus-key`）。 */
export const PARADIS_CONTEXT_USAGE_FOCUS_KEY = 'paradisFocusKey';

function focusKeyOf(element: Element): string | undefined {
	if (!isHTMLElement(element)) {
		return undefined;
	}
	if (element.dataset[PARADIS_CONTEXT_USAGE_FOCUS_KEY] !== undefined) {
		return element.dataset[PARADIS_CONTEXT_USAGE_FOCUS_KEY];
	}
	// 一覧の見出し（details > summary）は一覧の名前（data-group）で見分ける
	const parent = element.parentElement;
	return element.tagName === 'SUMMARY' && parent?.tagName === 'DETAILS' && parent.dataset.group !== undefined ? `group:${parent.dataset.group}` : undefined;
}

function findByFocusKey(parent: Element, focusKey: string): HTMLElement | undefined {
	for (const child of parent.children) {
		if (focusKeyOf(child) === focusKey && isHTMLElement(child)) {
			return child;
		}
		const found = findByFocusKey(child, focusKey);
		if (found) {
			return found;
		}
	}
	return undefined;
}

/**
 * 内訳のポップオーバーを中身ごと描き直す。作り直すとフォーカスしていた要素が消えて固定ホバーの外へ抜け、
 * スクロールも先頭へ戻りうるので、前後で `root` のスクロール位置と、フォーカスしていた要素（印の付いたもの）を戻す。
 */
export function paradisRedrawContextUsageDetails(root: HTMLElement, redraw: () => void): void {
	const scrollTop = root.scrollTop;
	const active = getActiveElement();
	const focusKey = active && active !== root && isAncestor(active, root) ? focusKeyOf(active) : undefined;
	redraw();
	if (focusKey !== undefined) {
		findByFocusKey(root, focusKey)?.focus();
	}
	root.scrollTop = scrollTop;
}

/** 1 ペイン分の使用率。 */
export interface IParadisContextUsageReading {
	/** 0〜100 の整数。 */
	readonly percent: number;
}

/** 値の供給元とポップオーバー。electron-browser の contribution が実装する。 */
export interface IParadisContextUsageBadgeHost {
	/** 表示の書き換えどき。 */
	readonly onDidChange: Event<void>;
	/** そのペインで出す使用率。出さない（Claude・Codex でない、まだリクエストが無い）ときは undefined。 */
	read(instanceId: number): IParadisContextUsageReading | undefined;
	/** マウスを乗せたときの 1 行（`24% 使用（238.7K / 1M）`）。 */
	tooltip(instanceId: number): string;
	/** 1 行のホバーを取り付ける（IHoverService の遅れて出るホバー）。 */
	setupHover(element: HTMLElement, content: () => string): IDisposable;
	/** 内訳のポップオーバーを固定で開く。 */
	openDetails(element: HTMLElement, instanceId: number): void;
}

/**
 * `container`（エディタのターミナルの overflow guard）へ輪と % を 1 つ置く。コンテナはタブを切り替えても使い回される。
 */
export function createParadisContextUsageBadge(container: HTMLElement, host: IParadisContextUsageBadgeHost): IParadisEditorTerminalOverlay {
	const store = new DisposableStore();
	const element = append(container, $('.paradis-context-usage-badge.paradis-focus-ring-inset.hidden'));
	element.setAttribute('role', 'button');
	element.tabIndex = 0;
	const ring = document.createElementNS(SVG_NS, 'svg');
	ring.setAttribute('viewBox', '0 0 36 36');
	ring.setAttribute('aria-hidden', 'true');
	ring.classList.add('paradis-context-usage-ring');
	const track = document.createElementNS(SVG_NS, 'circle');
	const arc = document.createElementNS(SVG_NS, 'circle');
	for (const [circle, className] of [[track, 'track'], [arc, 'arc']] as const) {
		circle.setAttribute('cx', '18');
		circle.setAttribute('cy', '18');
		circle.setAttribute('r', String(RING_RADIUS));
		circle.classList.add(className);
		ring.appendChild(circle);
	}
	arc.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
	element.appendChild(ring);
	const label = append(element, $('span.paradis-context-usage-percent'));
	let instanceId: number | undefined;

	const update = () => {
		const reading = instanceId !== undefined ? host.read(instanceId) : undefined;
		element.classList.toggle('hidden', !reading);
		const severity = reading ? paradisContextUsageSeverity(reading.percent) : 'normal';
		element.classList.toggle('warning', severity === 'warning');
		element.classList.toggle('error', severity === 'error');
		if (!reading) {
			label.textContent = '';
			element.removeAttribute('aria-label');
			return;
		}
		const percent = Math.max(0, Math.min(100, reading.percent));
		arc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - percent / 100)));
		label.textContent = localize('paradis.contextUsage.percent', "{0}%", percent);
		element.setAttribute('aria-label', localize('paradis.contextUsage.ariaLabel', "コンテキストの使用率 {0}%。押すと内訳を開きます", percent));
	};

	const open = () => {
		if (instanceId !== undefined && host.read(instanceId)) {
			host.openDetails(element, instanceId);
		}
	};
	store.add(host.onDidChange(update));
	store.add(host.setupHover(element, () => instanceId !== undefined ? host.tooltip(instanceId) : ''));
	store.add(addDisposableListener(element, EventType.CLICK, e => {
		// ターミナルへクリックを渡さない（フォーカスや選択が動かないように）
		e.stopPropagation();
		open();
	}));
	store.add(addDisposableListener(element, EventType.MOUSE_DOWN, e => e.stopPropagation()));
	store.add(addDisposableListener(element, EventType.KEY_DOWN, e => {
		const event = new StandardKeyboardEvent(e);
		if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
			e.preventDefault();
			e.stopPropagation();
			open();
		}
	}));
	update();

	return {
		setInstance(next) {
			instanceId = next;
			update();
		},
		dispose() {
			element.remove();
			store.dispose();
		},
	};
}
