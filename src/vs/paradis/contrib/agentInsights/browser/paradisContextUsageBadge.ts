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

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
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
	const element = append(container, $('.paradis-context-usage-badge.hidden'));
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
