/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 復元したターミナルタブの右上に出すバナー。DOM だけを持ち、判断と操作は
// ホスト（electron-browser の contribution）に任せる。共有ドット（agentBrowser の
// paradisPaneIndicator）と同じ場所・同じ切り替えで出るよう、その重ね合わせの口に乗る。
// 見えるのは選んでいるタブの分だけで、裏のタブのバナーはそのタブを選んだときに出る。

import './media/paradisTerminalResumeBanner.css';
import * as dom from '../../../../base/browser/dom.js';
import { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { fromNow } from '../../../../base/common/date.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IParadisEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { IParadisResumeHibernation, IParadisResumeLedgerEntry, ParadisResumeBannerChoice, paradisResumeBannerChoiceCommand, paradisResumeBannerLayout, paradisResumeBypassFlag } from '../common/paradisTerminalResumeBanner.js';

/** バナーのホスト。対象ペイン（instanceId）ごとに、出すかどうかと操作を受け持つ。 */
export interface IParadisResumeBannerHost {
	/** 出す内容が変わったペイン。 */
	readonly onDidChange: Event<number>;
	getOffer(instanceId: number): IParadisResumeLedgerEntry | undefined;
	/** `dangerouslyBypassPermissions` なら権限の確認を省くフラグを付けて再開する。 */
	resume(instanceId: number, dangerouslyBypassPermissions?: boolean): void;
	/** `dangerouslyBypassPermissions` なら権限の確認を省くフラグを付けて分岐する。 */
	fork(instanceId: number, dangerouslyBypassPermissions?: boolean): void;
	copySessionId(instanceId: number): void;
	dismiss(instanceId: number): void;
}

const $ = dom.$;

/** 帯の 2 行目の「〜分前」を描き直す間隔。帯が出ている間だけ回す。 */
const DETAIL_REFRESH_INTERVAL = 60 * 1000;

/** `text()` で 2 行目を書き、帯が出ている間は 1 分ごとに書き直す（相対時刻がずれないように）。 */
function renderRelativeDetail(store: DisposableStore, targetWindow: Window & typeof globalThis, detail: HTMLElement, text: () => string): void {
	detail.textContent = text();
	const timer = store.add(new IntervalTimer());
	timer.cancelAndSet(() => { detail.textContent = text(); }, DETAIL_REFRESH_INTERVAL, targetWindow);
}

/**
 * エディタタブのターミナル1つ分のバナー。タブを切り替えるたびに対象が差し替わる。
 * 帯に「再開」と「確認なしで再開」を並べ、複製して再開（分岐）と ID のコピーは「…」のメニューから選ぶ（選んだものは覚えない）。
 */
export function createParadisTerminalResumeBanner(container: HTMLElement, host: IParadisResumeBannerHost, contextMenuProvider: IContextMenuProvider): IParadisEditorTerminalOverlay {
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
		if (offer.hibernated !== undefined) {
			// 休止（G-03）で止めた会話。帯は「再開」だけにする（タブを開けば自動で再開するので、ここに来るのは送れなかったとき）
			renderHibernated(store, element, header, offer, offer.hibernated, target);
			return;
		}
		dom.append(header, $('span.paradis-terminal-resume-banner-heading')).textContent = offer.agent === 'claude'
			? localize('paradis.resumeBanner.headingClaude', "前回の Claude Code のセッションがあります")
			: offer.agent === 'codex' ? localize('paradis.resumeBanner.headingCodex', "前回の Codex のセッションがあります")
				: localize('paradis.resumeBanner.headingOpenCode', "前回の OpenCode のセッションがあります");
		const close = dom.append(header, $(`button.paradis-terminal-resume-banner-close.paradis-focus-ring-inset${ThemeIcon.asCSSSelector(Codicon.close)}`)) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('paradis.resumeBanner.dismiss', "閉じる（このタブでは再び表示しません）"));
		close.title = close.getAttribute('aria-label') ?? '';
		store.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => host.dismiss(target)));

		const detail = dom.append(element, $('.paradis-terminal-resume-banner-detail'));
		renderRelativeDetail(store, dom.getWindow(container), detail, () => {
			const when = fromNow(offer.at, true);
			return offer.title !== undefined
				? localize('paradis.resumeBanner.detail', "{0} ・ {1}", offer.title, when)
				: when;
		});
		detail.title = offer.title ?? '';

		const actions = dom.append(element, $('.paradis-terminal-resume-banner-actions'));
		const layout = paradisResumeBannerLayout(offer.agent);
		const bypassFlag = paradisResumeBypassFlag(offer.agent) ?? '';
		const resumeLabel = localize('paradis.resumeBanner.resume', "再開");
		const resumeBypassLabel = localize('paradis.resumeBanner.resumeBypass', "確認なしで再開");
		const run = (choice: ParadisResumeBannerChoice): void => {
			const command = paradisResumeBannerChoiceCommand(choice);
			if (command === undefined) {
				host.copySessionId(target);
			} else if (command.mode === 'fork') {
				host.fork(target, command.dangerouslyBypassPermissions);
			} else {
				host.resume(target, command.dangerouslyBypassPermissions);
			}
		};
		// 帯のボタン。確認を省く方は本家の secondary のボタンで、文言とツールチップに「確認なし」とフラグを出す
		for (const choice of layout.buttons) {
			const bypass = choice === 'resumeBypass';
			const button = store.add(new Button(actions, {
				...defaultButtonStyles,
				secondary: bypass,
				title: bypass
					? localize('paradis.resumeBanner.resumeBypassTitle', "権限の確認を省いて、このタブで前回の会話を続けます（{0}）", bypassFlag)
					: localize('paradis.resumeBanner.resumeTitle', "このタブで前回の会話を続けます"),
			}));
			button.label = bypass ? resumeBypassLabel : resumeLabel;
			store.add(button.onDidClick(() => run(choice)));
		}
		// 「…」のメニュー。確認を省く項目は、HTML のメニュー（window.menuStyle: custom）では赤字にする。ネイティブのメニューでは色が付かないので、文言だけで分かるようにする
		const dangerClass = 'paradis-menu-icon paradis-terminal-resume-banner-menu-danger';
		const forkTooltip = offer.agent === 'claude'
			? localize('paradis.resumeBanner.forkTooltipClaude', "Claude Code の --fork-session で前回の会話を複製し、新しいタブで別の会話として続けます。元の会話はそのまま残ります")
			: offer.agent === 'codex'
				? localize('paradis.resumeBanner.forkTooltipCodex', "codex fork で前回の会話を複製し、新しいタブで別の会話として続けます。元の会話はそのまま残ります")
				: localize('paradis.resumeBanner.forkTooltipOpenCode', "OpenCode の --fork で前回の会話を複製し、新しいタブで別の会話として続けます。元の会話はそのまま残ります");
		const choiceLabel = (choice: ParadisResumeBannerChoice): string => {
			switch (choice) {
				case 'resume': return resumeLabel;
				case 'resumeBypass': return resumeBypassLabel;
				case 'fork': return localize('paradis.resumeBanner.fork', "複製して新しい会話で再開（元の会話は残す）");
				case 'forkBypass': return localize('paradis.resumeBanner.forkBypass', "複製して新しい会話で再開・確認なし（{0}）", bypassFlag);
				case 'copyId': return localize('paradis.resumeBanner.copyId', "ID をコピー");
			}
		};
		const menuActions: IAction[] = layout.menu.map(item => item === 'separator' ? new Separator() : toAction({
			id: `paradis.resumeBanner.${item}`,
			label: choiceLabel(item),
			tooltip: item === 'copyId' ? offer.sessionId : forkTooltip,
			class: paradisResumeBannerChoiceCommand(item)?.dangerouslyBypassPermissions ? dangerClass : undefined,
			run: () => run(item),
		}));
		const moreLabel = localize('paradis.resumeBanner.more', "複製して再開・ID のコピー");
		const more = store.add(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: moreLabel, ariaLabel: moreLabel }));
		more.label = '$(ellipsis)';
		more.element.classList.add('paradis-terminal-resume-banner-more');
		more.element.setAttribute('aria-haspopup', 'true');
		store.add(more.onDidClick(() => contextMenuProvider.showContextMenu({
			getAnchor: () => more.element,
			getActions: () => menuActions,
		})));

		// ターミナルへ届くとキー入力やフォーカスの移動として扱われるので、バナーの中で止める。
		store.add(dom.addDisposableListener(element, dom.EventType.MOUSE_DOWN, event => event.stopPropagation()));
		container.appendChild(element);
		store.add({ dispose: () => element.remove() });
		view.value = store;
	};

	const renderHibernated = (store: DisposableStore, element: HTMLElement, header: HTMLElement, offer: IParadisResumeLedgerEntry, hibernation: IParadisResumeHibernation, target: number): void => {
		dom.append(header, $('span.paradis-terminal-resume-banner-heading')).textContent = localize('paradis.resumeBanner.hibernatedHeading', "休止中: 押すと再開します");
		const close = dom.append(header, $(`button.paradis-terminal-resume-banner-close.paradis-focus-ring-inset${ThemeIcon.asCSSSelector(Codicon.close)}`)) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('paradis.resumeBanner.hibernatedDismiss', "閉じる（このタブでは再開しません）"));
		close.title = close.getAttribute('aria-label') ?? '';
		store.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => host.dismiss(target)));

		const agentName = offer.agent === 'claude' ? 'Claude Code' : offer.agent === 'codex' ? 'Codex' : 'OpenCode';
		const detail = dom.append(element, $('.paradis-terminal-resume-banner-detail'));
		renderRelativeDetail(store, dom.getWindow(container), detail, () => {
			const finished = localize('paradis.resumeBanner.hibernatedFinished', "{0}に完了", fromNow(hibernation.completedAt, true));
			return offer.title !== undefined
				? localize('paradis.resumeBanner.hibernatedDetailWithTitle', "{0} ・ {1} ・ {2}", agentName, offer.title, finished)
				: localize('paradis.resumeBanner.hibernatedDetail', "{0} ・ {1}", agentName, finished);
		});
		detail.title = offer.title ?? '';

		const actions = dom.append(element, $('.paradis-terminal-resume-banner-actions'));
		const button = store.add(new Button(actions, {
			...defaultButtonStyles,
			title: localize('paradis.resumeBanner.hibernatedResumeTitle', "休止する前の会話を、このタブで続けます"),
		}));
		button.label = localize('paradis.resumeBanner.resume', "再開");
		store.add(button.onDidClick(() => host.resume(target, hibernation.bypass === true)));

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
