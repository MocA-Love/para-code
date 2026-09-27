/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタエリアのターミナル右上（ブラウザ共有のドットの左）に出す、プロンプトキャッシュの残り時間。
//
// 置き場所の `SessionTerminalEditor`（vs/sessions/contrib/terminalGrid）は DI を持たない差し替え
// クラスなので、ペインインジケータ（agentBrowser/browser/paradisPaneIndicator.ts）と同じく、
// 値の供給元はモジュールのレジストリに登録してもらう。デスクトップ以外ではホストが未登録のまま
// 何も出ない。

import { $, append } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { paradisFormatPromptCacheRemaining } from '../common/paradisAgentInsights.js';
import { paradisPromptCacheTooltip } from './paradisAgentInsightsPresentation.js';
import { IParadisPromptCacheReading } from './paradisPromptCacheClock.js';
import './media/paradisAgentInsights.css';

/** 残り時間の供給元。browser 層の contribution が登録する。 */
export interface IParadisPromptCacheBadgeHost {
	/** 表示の書き換えどき（1秒ごと、および出る・消えるとき）。 */
	readonly onDidChange: Event<void>;
	read(instanceId: number): IParadisPromptCacheReading | undefined;
	/** ツールチップを取り付ける（IHoverService 経由）。内容は表示の直前に組み立てる。 */
	setupHover(element: HTMLElement, content: () => string): IDisposable;
}

let currentHost: IParadisPromptCacheBadgeHost | undefined;
const onDidChangeHost = new Emitter<void>();

export function setParadisPromptCacheBadgeHost(host: IParadisPromptCacheBadgeHost | undefined): void {
	currentHost = host;
	onDidChangeHost.fire();
}

/** 対象ペインを差し替えられるバッジのハンドル。 */
export interface IParadisPromptCacheBadgeController extends IDisposable {
	setInstance(instanceId: number | undefined): void;
}

/**
 * `container`（エディタのターミナルの overflow guard）へバッジを1つ置く。コンテナはタブを
 * 切り替えても使い回されるので、対象ペインは {@link IParadisPromptCacheBadgeController.setInstance} で差し替える。
 */
export function createParadisPromptCacheBadge(container: HTMLElement): IParadisPromptCacheBadgeController {
	const store = new DisposableStore();
	const element = append(container, $('.paradis-prompt-cache-badge'));
	element.setAttribute('role', 'status');
	append(element, $(ThemeIcon.asCSSSelector(Codicon.flame)));
	const label = append(element, $('span.paradis-prompt-cache-badge-time'));
	let instanceId: number | undefined;

	const update = () => {
		const reading = instanceId !== undefined ? currentHost?.read(instanceId) : undefined;
		element.classList.toggle('hidden', !reading);
		element.classList.toggle('warning', !!reading?.warning);
		label.textContent = reading ? paradisFormatPromptCacheRemaining(reading.remainingMs) : '';
	};

	const hostListeners = store.add(new MutableDisposable<DisposableStore>());
	const bindHost = () => {
		const listeners = new DisposableStore();
		if (currentHost) {
			listeners.add(currentHost.onDidChange(update));
			listeners.add(currentHost.setupHover(element, () => {
				const reading = instanceId !== undefined ? currentHost?.read(instanceId) : undefined;
				return reading ? paradisPromptCacheTooltip(reading.remainingMs, reading.ttlMs) : '';
			}));
		}
		hostListeners.value = listeners;
		update();
	};
	store.add(onDidChangeHost.event(bindHost));
	bindHost();

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
