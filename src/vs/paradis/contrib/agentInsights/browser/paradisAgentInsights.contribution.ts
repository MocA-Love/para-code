/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisAgentInsightsService } from '../common/paradisAgentInsights.js';
import { ParadisAgentInsightsStore } from './paradisAgentInsightsStore.js';
import { setParadisPromptCacheBadgeHost } from './paradisPromptCacheBadge.js';
import { ParadisPromptCacheClock } from './paradisPromptCacheClock.js';

registerSingleton(IParadisAgentInsightsService, ParadisAgentInsightsStore, InstantiationType.Delayed);

/**
 * エディタエリアのターミナル右上のバッジへ、残り時間の供給元を登録する。
 * Web ビルドでもこれは動くが、書き込み係（electron-browser）がいないのでストアは空のまま＝何も出ない。
 */
class ParadisPromptCacheBadgeHostContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisPromptCacheBadgeHost';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		const clock = this._register(instantiationService.createInstance(ParadisPromptCacheClock));
		setParadisPromptCacheBadgeHost({
			onDidChange: Event.any(clock.onDidTick, clock.onDidChangeVisibility),
			read: instanceId => clock.readInstance(instanceId),
			setupHover: (element, content) => hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), element, content),
		});
		this._register(toDisposable(() => setParadisPromptCacheBadgeHost(undefined)));
	}
}

registerWorkbenchContribution2(ParadisPromptCacheBadgeHostContribution.ID, ParadisPromptCacheBadgeHostContribution, WorkbenchPhase.AfterRestored);
