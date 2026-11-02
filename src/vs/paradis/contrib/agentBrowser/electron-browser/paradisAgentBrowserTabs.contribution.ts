/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのタブ操作と共有の要求（実体は paradisAgentBrowserTabsService.ts）を、shared process の
// ParadisAgentBrowserService から呼べるようにするチャネル。引数の形を確かめてサービスへ渡すだけ。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { PARADIS_AGENT_BROWSER_TABS_CHANNEL, ParadisAgentTabMethod } from '../common/paradisAgentBrowserTabs.js';
import { IParadisAgentBrowserTabsService } from './paradisAgentBrowserTabsService.js';
import { paradisIsPaneStorageAffinity } from '../common/paradisBrowserPageOps.js';
import { paradisParseHumanCheckKind } from '../common/paradisBrowserHumanCheck.js';
import { ParadisChannelArgs } from '../../../common/paradisChannelArgs.js';

/** shared process から届く呼び出しを {@link IParadisAgentBrowserTabsService} へ流すだけのチャネル。 */
export class ParadisAgentBrowserTabsChannel implements IServerChannel {

	constructor(private readonly _tabs: IParadisAgentBrowserTabsService) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		const args = ParadisChannelArgs.from(arg);
		const token = args.string(0);
		switch (command) {
			case ParadisAgentTabMethod.Open: {
				const affinity = args.at(3);
				return this._tabs.openTab(token, args.string(1), args.at(2) === true, paradisIsPaneStorageAffinity(affinity) ? affinity : undefined) as Promise<T>;
			}
			case ParadisAgentTabMethod.List:
				return this._tabs.listTabs(token) as T;
			case ParadisAgentTabMethod.Select:
				return this._tabs.selectTab(token, args.string(1) ?? '') as Promise<T>;
			case ParadisAgentTabMethod.Close:
				return this._tabs.closeTab(token, args.string(1) ?? '') as Promise<T>;
			case ParadisAgentTabMethod.RequestPage:
				return this._tabs.requestPage(token, args.string(1), args.string(2), cancellationToken) as Promise<T>;
			case ParadisAgentTabMethod.NoteHumanCheck:
				this._tabs.noteHumanCheck(token, args.string(1) ?? '', paradisParseHumanCheckKind(args.at(2)));
				return undefined as T;
		}
		throw new Error(`Method not found: ${command}`);
	}
}

class ParadisAgentBrowserTabsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentBrowserTabs';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisAgentBrowserTabsService tabs: IParadisAgentBrowserTabsService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_AGENT_BROWSER_TABS_CHANNEL, new ParadisAgentBrowserTabsChannel(tabs));
	}
}

registerWorkbenchContribution2(ParadisAgentBrowserTabsContribution.ID, ParadisAgentBrowserTabsContribution, WorkbenchPhase.AfterRestored);
