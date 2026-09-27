/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーのベル（未読数ならぬ「要対応のペイン数」のバッジ付き）と、受信箱を開くコマンド。
// ベルは「エージェント一覧」「ブラウザ一覧」の右に並ぶ。

import { $, append, getActiveWindow, getWindow } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ToggleTitleBarConfigAction } from '../../../../workbench/browser/parts/titlebar/titlebarActions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ParadisNotificationInboxPopover } from '../browser/paradisNotificationInboxPopover.js';
import { IParadisNotificationInboxService, PARADIS_NOTIFICATION_INBOX_TITLE_BAR_SETTING } from '../common/paradisNotificationInbox.js';

const OPEN_COMMAND_ID = 'paradis.notificationInbox.open';

class ParadisOpenNotificationInboxAction extends Action2 {

	constructor() {
		super({
			id: OPEN_COMMAND_ID,
			title: localize2('paradis.inbox.open', "通知の受信箱"),
			category: localize2('paradis.inbox.category', "Para Code"),
			f1: true,
			menu: [{
				id: MenuId.TitleBarAdjacentCenter,
				// 「エージェント一覧」(-999)・「ブラウザ一覧」(-998) の右
				order: -997,
				when: ContextKeyExpr.and(
					IsSessionsWindowContext.toNegated(),
					ContextKeyExpr.notEquals(`config.${PARADIS_NOTIFICATION_INBOX_TITLE_BAR_SETTING}`, false),
				),
			}],
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IParadisNotificationInboxService).requestOpenInbox();
	}
}

class ParadisToggleNotificationInboxTitleBarAction extends ToggleTitleBarConfigAction {
	constructor() {
		super(
			PARADIS_NOTIFICATION_INBOX_TITLE_BAR_SETTING,
			localize('paradis.inbox.toggleTitleBar', "通知の受信箱"),
			localize('paradis.inbox.toggleTitleBarDescription', "タイトルバーの通知の受信箱（ベル）の表示を切り替えます"),
			9,
			IsSessionsWindowContext.toNegated(),
		);
	}
}

/**
 * ポップオーバーを1つだけ持つ係。ベルのクリックでもコマンド（コマンドパレット・メニューバーの
 * アイコン）でも同じものを開閉する。
 */
class ParadisNotificationInboxPopoverController extends Disposable {

	private readonly popover = this._register(new MutableDisposable<ParadisNotificationInboxPopover>());
	/** 描かれているベル。補助ウィンドウのタイトルバーにも同じボタンが出るので複数ある。 */
	private readonly anchors = new Set<HTMLElement>();
	private openAnchor: HTMLElement | undefined;

	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
	}

	get isOpen(): boolean {
		return this.popover.value !== undefined;
	}

	addAnchor(anchor: HTMLElement): void {
		this.anchors.add(anchor);
	}

	removeAnchor(anchor: HTMLElement): void {
		this.anchors.delete(anchor);
	}

	/** ベルを押した。押されたベルを基準に開閉する（別のウィンドウのベルと取り違えない）。 */
	toggle(anchor: HTMLElement): void {
		// 開いているのと同じベルなら閉じるだけ（ポップオーバーは自分のベルの mousedown では閉じない）。
		// 別のウィンドウのベルなら、そちらに開き直す。
		if (this.isOpen && this.openAnchor === anchor) {
			this.close();
			return;
		}
		this.close();
		this.open(anchor);
	}

	/** 今アクティブなウィンドウで見えているベル（狭い幅で隠れていると大きさが 0 になる）。 */
	private findVisibleAnchor(): HTMLElement | undefined {
		const activeWindow = getActiveWindow();
		for (const anchor of this.anchors) {
			const rect = anchor.getBoundingClientRect();
			if (anchor.isConnected && getWindow(anchor) === activeWindow && rect.width > 0 && rect.height > 0) {
				return anchor;
			}
		}
		return undefined;
	}

	/** コマンド・メニューバーから開く。今のウィンドウで見えているベルがあればそこに、無ければ右上に出す。 */
	open(anchor?: HTMLElement): void {
		if (this.isOpen) {
			return;
		}
		anchor ??= this.findVisibleAnchor();
		this.openAnchor = anchor;
		anchor?.classList.add('open');
		anchor?.setAttribute('aria-expanded', 'true');
		this.popover.value = this.instantiationService.createInstance(ParadisNotificationInboxPopover, {
			anchor,
			onClose: () => this.close(),
		});
	}

	close(): void {
		this.openAnchor?.classList.remove('open');
		this.openAnchor?.setAttribute('aria-expanded', 'false');
		this.openAnchor = undefined;
		this.popover.clear();
	}
}

/** タイトルバーのベル本体。アイコン + 要対応のペイン数のバッジ。 */
class ParadisNotificationInboxTitleBarWidget extends BaseActionViewItem {

	private badge: HTMLElement | undefined;
	private icon: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		private readonly controller: ParadisNotificationInboxPopoverController,
		@IHoverService private readonly hoverService: IHoverService,
		@IParadisNotificationInboxService private readonly inboxService: IParadisNotificationInboxService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('paradis-notification-inbox-titlebar-widget');
		container.setAttribute('role', 'button');
		container.setAttribute('aria-haspopup', 'dialog');
		container.setAttribute('aria-expanded', 'false');
		this.icon = append(container, $('span'));
		this.icon.setAttribute('aria-hidden', 'true');
		this.badge = append(container, $('span.paradis-notification-inbox-badge'));
		this.controller.addAnchor(container);
		this._register({ dispose: () => this.controller.removeAnchor(container) });

		const hover = this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, ''));
		const update = () => {
			const { attentionPaneCount, unreadCount } = this.inboxService.snapshot;
			if (this.icon) {
				this.icon.className = ThemeIcon.asClassName(attentionPaneCount > 0 ? Codicon.bellDot : Codicon.bell);
			}
			if (this.badge) {
				// 2桁以上は「9+」で頭打ちにして、ベルの幅を変えない（正確な数はホバーに出る）
				this.badge.textContent = attentionPaneCount > 9 ? '9+' : attentionPaneCount > 0 ? String(attentionPaneCount) : '';
				this.badge.classList.toggle('hidden', attentionPaneCount === 0);
			}
			const text = this.hoverText(attentionPaneCount, unreadCount);
			container.setAttribute('aria-label', text);
			hover.update(text);
		};
		this._register(this.inboxService.onDidChange(update));
		update();
	}

	override onClick(): void {
		if (this.element) {
			this.controller.toggle(this.element);
		}
	}

	private hoverText(attentionPanes: number, unread: number): string {
		// 隣の「エージェント一覧」の黄色いバッジ（いま許可待ち・質問中の数）や、右下の VS Code の
		// 通知センター（同じベルの形）と意味が違うことを書く。
		if (attentionPanes > 0) {
			return localize('paradis.inbox.hoverAttention', "エージェントの通知の受信箱: 確認していないペイン {0} 件（未読の通知 {1} 件）", attentionPanes, unread);
		}
		if (unread > 0) {
			return localize('paradis.inbox.hoverUnread', "エージェントの通知の受信箱（未読の通知 {0} 件。ペインはすべて閉じています）", unread);
		}
		return localize('paradis.inbox.hoverIdle', "エージェントの通知の受信箱（完了・許可待ち・質問）");
	}
}

class ParadisNotificationInboxBellContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisNotificationInboxBell';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IParadisNotificationInboxService inboxService: IParadisNotificationInboxService,
	) {
		super();

		const controller = this._register(instantiationService.createInstance(ParadisNotificationInboxPopoverController));
		this._register(inboxService.onDidRequestOpenInbox(() => controller.open()));
		this._register(actionViewItemService.register(
			MenuId.TitleBarAdjacentCenter,
			OPEN_COMMAND_ID,
			(action, options) => instantiationService.createInstance(ParadisNotificationInboxTitleBarWidget, action, options, controller),
			// イベントを渡すとタイトルバーのツールバーごと作り直される（隣のボタンまで再生成される）。
			// バッジはウィジェット自身が台帳を購読して書き換える。
			undefined,
		));
	}
}

registerAction2(ParadisOpenNotificationInboxAction);
registerAction2(ParadisToggleNotificationInboxTitleBarAction);
registerWorkbenchContribution2(ParadisNotificationInboxBellContribution.ID, ParadisNotificationInboxBellContribution, WorkbenchPhase.AfterRestored);
