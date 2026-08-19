/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisBrowserLiveWindow.css';
import './paradisBrowserLiveWindowService.js';
import { $, append } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ToggleTitleBarConfigAction } from '../../../../workbench/browser/parts/titlebar/titlebarActions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisBrowserLiveWindowService } from '../common/paradisBrowserLiveWindow.js';

const OPEN_COMMAND_ID = 'paradis.browserLiveWindow.open';
const TITLE_BAR_SETTING_ID = 'paradis.browserLiveWindow.titleBar.enabled';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[TITLE_BAR_SETTING_ID]: {
			type: 'boolean',
			default: true,
			description: localize('paradis.browserLive.titleBarSetting', "タイトルバーに「ブラウザ一覧」ボタンを表示するかどうかを制御します。"),
		},
	},
});

/**
 * 内蔵ブラウザのライブ一覧ウィンドウを開く。
 *
 * タイトルバー中央では「エージェントで開く」(order -1000)、「エージェント一覧」(order -999)
 * の右隣に並ぶ。upstream 側のファイルには一切触れていない。
 */
class ParadisOpenBrowserLiveWindowAction extends Action2 {

	constructor() {
		super({
			id: OPEN_COMMAND_ID,
			title: localize2('paradis.browserLive.open', "ブラウザ一覧"),
			category: localize2('paradis.browserLive.category', "Para Code"),
			f1: true,
			menu: [{
				id: MenuId.TitleBarAdjacentCenter,
				order: -998,
				when: ContextKeyExpr.and(
					IsSessionsWindowContext.toNegated(),
					ContextKeyExpr.notEquals(`config.${TITLE_BAR_SETTING_ID}`, false),
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IParadisBrowserLiveWindowService).open();
	}
}

class ParadisToggleBrowserLiveTitleBarAction extends ToggleTitleBarConfigAction {
	constructor() {
		super(
			TITLE_BAR_SETTING_ID,
			localize('paradis.browserLive.toggleTitleBar', "ブラウザ一覧"),
			localize('paradis.browserLive.toggleTitleBarDescription', "タイトルバーの「ブラウザ一覧」ボタンの表示を切り替えます"),
			8,
			IsSessionsWindowContext.toNegated(),
		);
	}
}

/**
 * タイトルバーのボタン本体。アイコン + ラベル + 件数バッジ。
 * エージェントへ共有中のページがある間は、その件数と色をそちらへ切り替える。
 */
class ParadisBrowserLiveTitleBarWidget extends BaseActionViewItem {

	private badge: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IHoverService private readonly hoverService: IHoverService,
		@IParadisBrowserLiveWindowService private readonly liveWindowService: IParadisBrowserLiveWindowService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('paradis-browser-live-titlebar-widget');
		container.setAttribute('role', 'button');

		append(container, $('span.paradis-browser-live-titlebar-icon')).setAttribute('aria-hidden', 'true');
		append(container, $('span.paradis-browser-live-titlebar-label')).textContent = this.action.label;
		this.badge = append(container, $('span.paradis-browser-live-titlebar-badge'));

		const hover = this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, ''));
		const update = () => {
			const summary = this.liveWindowService.summary;
			const badge = this.badge;
			if (badge) {
				const count = summary.shared > 0 ? summary.shared : summary.total;
				badge.textContent = count > 0 ? String(count) : '';
				badge.classList.toggle('hidden', count === 0);
				badge.classList.toggle('shared', summary.shared > 0);
			}
			const text = this.hoverText(summary.total, summary.shared);
			container.setAttribute('aria-label', text);
			hover.update(text);
		};
		this._register(this.liveWindowService.onDidChangeSummary(update));
		update();
	}

	private hoverText(total: number, shared: number): string {
		if (shared > 0) {
			return localize('paradis.browserLive.hoverShared', "ブラウザ一覧（{0} タブ / {1} 件を共有中）", total, shared);
		}
		if (total > 0) {
			return localize('paradis.browserLive.hoverOpen', "ブラウザ一覧（{0} タブ）", total);
		}
		return localize('paradis.browserLive.hoverIdle', "ブラウザ一覧");
	}
}

class ParadisBrowserLiveWindowContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisBrowserLiveWindow';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(actionViewItemService.register(
			MenuId.TitleBarAdjacentCenter,
			OPEN_COMMAND_ID,
			(action, options) => instantiationService.createInstance(ParadisBrowserLiveTitleBarWidget, action, options),
			// イベントを渡すとタイトルバーのツールバーごと作り直され、隣のボタンまで再生成される。
			// バッジはウィジェット自身がサマリを購読して書き換える。
			undefined,
		));
	}
}

registerAction2(ParadisOpenBrowserLiveWindowAction);
registerAction2(ParadisToggleBrowserLiveTitleBarAction);
registerWorkbenchContribution2(ParadisBrowserLiveWindowContribution.ID, ParadisBrowserLiveWindowContribution, WorkbenchPhase.AfterRestored);
