/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 復元したターミナルタブの右上に出すバナー（Q53 案B）。DOM だけを持ち、判断と操作は
// ホスト（electron-browser の contribution）に任せる。共有ドット（agentBrowser の
// paradisPaneIndicator）と同じ場所・同じ切り替えで出るよう、その重ね合わせの口に乗る。
// 見えるのは選んでいるタブの分だけで、裏のタブのバナーはそのタブを選んだときに出る。

import './media/paradisTerminalResumeBanner.css';
import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IParadisEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { IParadisResumeLedgerEntry } from '../common/paradisTerminalResumeBanner.js';

/** バナーのホスト。対象ペイン（instanceId）ごとに、出すかどうかと操作を受け持つ。 */
export interface IParadisResumeBannerHost {
	/** 出す内容が変わったペイン。 */
	readonly onDidChange: Event<number>;
	getOffer(instanceId: number): IParadisResumeLedgerEntry | undefined;
	resume(instanceId: number): void;
	fork(instanceId: number): void;
	copySessionId(instanceId: number): void;
	dismiss(instanceId: number): void;
}

const $ = dom.$;

/** エディタタブのターミナル1つ分のバナー。タブを切り替えるたびに対象が差し替わる。 */
export function createParadisTerminalResumeBanner(container: HTMLElement, host: IParadisResumeBannerHost): IParadisEditorTerminalOverlay {
	const view = new MutableDisposable<DisposableStore>();
	const listener = new DisposableStore();
	let instanceId: number | undefined;

	const render = (): void => {
		const offer = instanceId === undefined ? undefined : host.getOffer(instanceId);
		if (instanceId === undefined || offer === undefined) {
			view.clear();
			return;
		}
		const target = instanceId;
		const store = new DisposableStore();
		const element = $('.paradis-terminal-resume-banner');
		element.setAttribute('role', 'status');
		const header = dom.append(element, $('.paradis-terminal-resume-banner-header'));
		dom.append(header, $('span.paradis-terminal-resume-banner-heading')).textContent = offer.agent === 'claude'
			? localize('paradis.resumeBanner.headingClaude', "前回の Claude Code のセッションがあります")
			: localize('paradis.resumeBanner.headingCodex', "前回の Codex のセッションがあります");
		const close = dom.append(header, $(`button.paradis-terminal-resume-banner-close${ThemeIcon.asCSSSelector(Codicon.close)}`)) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('paradis.resumeBanner.dismiss', "閉じる（このタブでは再び表示しません）"));
		close.title = close.getAttribute('aria-label') ?? '';
		store.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => host.dismiss(target)));

		const detail = dom.append(element, $('.paradis-terminal-resume-banner-detail'));
		const when = fromNow(offer.at, true);
		detail.textContent = offer.title !== undefined
			? localize('paradis.resumeBanner.detail', "{0} ・ {1}", offer.title, when)
			: when;
		detail.title = offer.title ?? '';

		const actions = dom.append(element, $('.paradis-terminal-resume-banner-actions'));
		const resume = store.add(new Button(actions, { ...defaultButtonStyles, title: localize('paradis.resumeBanner.resumeTitle', "このタブで前回の会話を続けます") }));
		resume.label = localize('paradis.resumeBanner.resume', "このタブで再開");
		store.add(resume.onDidClick(() => host.resume(target)));
		const fork = store.add(new Button(actions, { ...defaultButtonStyles, secondary: true, title: localize('paradis.resumeBanner.forkTitle', "前回の会話を複製して、新しいタブで別の会話として続けます") }));
		fork.label = localize('paradis.resumeBanner.fork', "分岐");
		store.add(fork.onDidClick(() => host.fork(target)));
		const copy = store.add(new Button(actions, { ...defaultButtonStyles, secondary: true, title: offer.sessionId }));
		copy.label = localize('paradis.resumeBanner.copyId', "ID をコピー");
		store.add(copy.onDidClick(() => host.copySessionId(target)));

		// ターミナルへ届くとキー入力やフォーカスの移動として扱われるので、バナーの中で止める。
		store.add(dom.addDisposableListener(element, dom.EventType.MOUSE_DOWN, event => event.stopPropagation()));
		container.appendChild(element);
		store.add({ dispose: () => element.remove() });
		view.value = store;
	};

	listener.add(host.onDidChange(changed => {
		if (changed === instanceId) {
			render();
		}
	}));

	return {
		setInstance(next) {
			instanceId = next;
			render();
		},
		dispose() {
			listener.dispose();
			view.dispose();
		},
	};
}
