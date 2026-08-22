/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry } from '../../../../workbench/common/views.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { PARADIS_REMOTE_EXPLORER_CONTAINER_ID, PARADIS_REMOTE_HOSTS_VIEW_ID } from '../common/paradisRemoteHosts.js';
import { ParadisRemoteHostsView } from './paradisRemoteHostsView.js';

const paradisRemoteHostsViewIcon = registerIcon(
	'paradis-remote-hosts-view-icon',
	Codicon.remoteExplorer,
	localize('paradisRemoteHosts.viewIcon', "View icon of the Para hosts view."),
);

/**
 * ビューの登録はモジュール評価時ではなく workbench contribution として行う。
 * 登録先のリモートエクスプローラーコンテナ (workbench.view.remote) は remote contrib の
 * モジュール評価中に登録されるため、こちらのモジュール評価時に Registry.get すると
 * 評価順序によっては未登録のままになる。contribution まで遅延すれば確実に存在する。
 */
class ParadisRemoteHostsContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ILogService logService: ILogService,
	) {
		super();

		const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry)
			.get(PARADIS_REMOTE_EXPLORER_CONTAINER_ID);
		// remote contrib の評価前にこのモジュールへ到達することはない想定。万一無ければ
		// サイレントに諦めず、壊れたことが分かるようにしておく
		if (!container) {
			logService.warn('[ParadisRemoteHosts] リモートエクスプローラーコンテナが見つからず、ビューを登録できませんでした');
			return;
		}

		Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
			id: PARADIS_REMOTE_HOSTS_VIEW_ID,
			// allow-any-unicode-next-line
			name: localize2('paraRemoteHosts.viewName', "Para ホスト"),
			containerIcon: paradisRemoteHostsViewIcon,
			canMoveView: true,
			canToggleVisibility: true,
			ctorDescriptor: new SyncDescriptor(ParadisRemoteHostsView),
			openCommandActionDescriptor: {
				id: 'paradis.remoteHosts.showView',
				order: 0,
			},
			// remoteAuthority プロパティを付けないことで「Switch Remote」ドロップダウンには載らず、
			// 常時表示になる (接続の有無に依存せず手元側のブラウズもできるため)。
			// 'details@N' は viewOrderDelegate で -500+N に換算され、targets 群より後ろ・help 群より前
			group: 'details@10',
			order: 10,
		}], container);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.remoteHosts.refresh',
			// allow-any-unicode-next-line
			title: localize2('paraRemoteHosts.refresh', "更新"),
			icon: Codicon.refresh,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', PARADIS_REMOTE_HOSTS_VIEW_ID),
				group: 'navigation',
				order: 1,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getActiveViewWithId<ParadisRemoteHostsView>(PARADIS_REMOTE_HOSTS_VIEW_ID);
		await view?.refresh();
	}
});

registerWorkbenchContribution2('paradis.remoteHosts.contribution', ParadisRemoteHostsContribution, WorkbenchPhase.BlockRestore);
