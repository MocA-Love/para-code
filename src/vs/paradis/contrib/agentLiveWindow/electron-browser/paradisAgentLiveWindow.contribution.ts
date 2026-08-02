/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import '../browser/media/paradisAgentLiveWindow.css';
import '../browser/paradisAgentLiveWindowService.js';
import { $, append } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ToggleTitleBarConfigAction } from '../../../../workbench/browser/parts/titlebar/titlebarActions.js';
import { IParadisAgentLiveWindowService } from '../common/paradisAgentLiveWindow.js';

const OPEN_COMMAND_ID = 'paradis.agentLiveWindow.open';
const TITLE_BAR_SETTING_ID = 'paradis.agentLiveWindow.titleBar.enabled';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[TITLE_BAR_SETTING_ID]: {
			type: 'boolean',
			default: true,
			description: localize('paradis.agentLive.titleBarSetting', "タイトルバーに「エージェント一覧」ボタンを表示するかどうかを制御します。"),
		},
	},
});

/**
 * 稼働中エージェントのライブウィンドウを開く。
 *
 * タイトルバー中央の「エージェントで開く」(MenuId.TitleBarAdjacentCenter, order -1000) の
 * 右隣に並ぶよう order を -999 にしている。upstream 側のファイルには一切触れていない。
 */
class ParadisOpenAgentLiveWindowAction extends Action2 {

	constructor() {
		super({
			id: OPEN_COMMAND_ID,
			title: localize2('paradis.agentLive.open', "エージェント一覧"),
			category: localize2('paradis.agentLive.category', "Para Code"),
			f1: true,
			menu: [{
				id: MenuId.TitleBarAdjacentCenter,
				order: -999,
				when: ContextKeyExpr.and(
					IsSessionsWindowContext.toNegated(),
					ContextKeyExpr.notEquals(`config.${TITLE_BAR_SETTING_ID}`, false),
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IParadisAgentLiveWindowService).open();
	}
}

class ParadisToggleAgentLiveTitleBarAction extends ToggleTitleBarConfigAction {
	constructor() {
		super(
			TITLE_BAR_SETTING_ID,
			localize('paradis.agentLive.toggleTitleBar', "エージェント一覧"),
			localize('paradis.agentLive.toggleTitleBarDescription', "タイトルバーの「エージェント一覧」ボタンの表示を切り替えます"),
			7,
			IsSessionsWindowContext.toNegated(),
		);
	}
}

/**
 * タイトルバーのボタン本体。アイコン + ラベル + 稼働数バッジ。
 * 要対応 (許可待ち・質問中) が居る間はバッジの数と色をそちらへ切り替える。
 */
class ParadisAgentLiveTitleBarWidget extends BaseActionViewItem {

	private badge: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IHoverService private readonly hoverService: IHoverService,
		@IParadisAgentLiveWindowService private readonly liveWindowService: IParadisAgentLiveWindowService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('paradis-agent-live-titlebar-widget');
		container.setAttribute('role', 'button');

		append(container, $('span.paradis-agent-live-titlebar-icon')).setAttribute('aria-hidden', 'true');
		append(container, $('span.paradis-agent-live-titlebar-label')).textContent = this.action.label;
		this.badge = append(container, $('span.paradis-agent-live-titlebar-badge'));

		const hover = this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, ''));
		const update = () => {
			const summary = this.liveWindowService.summary;
			const badge = this.badge;
			if (badge) {
				const count = summary.attention > 0 ? summary.attention : summary.active;
				badge.textContent = count > 0 ? String(count) : '';
				badge.classList.toggle('hidden', count === 0);
				badge.classList.toggle('attention', summary.attention > 0);
			}
			container.setAttribute('aria-label', this.hoverText(summary.active, summary.attention));
			hover.update(this.hoverText(summary.active, summary.attention));
		};
		this._register(this.liveWindowService.onDidChangeSummary(update));
		update();
	}

	private hoverText(active: number, attention: number): string {
		if (attention > 0) {
			return localize('paradis.agentLive.hoverAttention', "エージェント一覧（要対応 {0} 件 / 稼働中 {1} 件）", attention, active);
		}
		if (active > 0) {
			return localize('paradis.agentLive.hoverActive', "エージェント一覧（稼働中 {0} 件）", active);
		}
		return localize('paradis.agentLive.hoverIdle', "エージェント一覧");
	}
}

class ParadisAgentLiveWindowContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentLiveWindow';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(actionViewItemService.register(
			MenuId.TitleBarAdjacentCenter,
			OPEN_COMMAND_ID,
			(action, options) => instantiationService.createInstance(ParadisAgentLiveTitleBarWidget, action, options),
			// イベントを渡すとタイトルバーのツールバーごと作り直されてしまう (隣の
			// 「エージェントで開く」まで再生成される)。バッジはウィジェット自身が
			// サマリを購読して書き換える。
			undefined,
		));
	}
}

registerAction2(ParadisOpenAgentLiveWindowAction);
registerAction2(ParadisToggleAgentLiveTitleBarAction);
registerWorkbenchContribution2(ParadisAgentLiveWindowContribution.ID, ParadisAgentLiveWindowContribution, WorkbenchPhase.AfterRestored);
