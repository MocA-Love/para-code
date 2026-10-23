/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser（LLM）の list_viewports / set_viewport / open_browser_tab の viewport / list_browser_tabs の
// viewport を、shared process の ParadisAgentBrowserService から呼べるようにするチャネル。
//
// どのタブをそのペインが使えるかは shared process が確かめてから呼ぶ（tab_id の解決と同じ判定）。ここは
// 大きさを解決して当て、構造化した結果だけを返す。LLM が変えるときもユーザーへの確認は出さない
// （Q451 のユーザーの決定）。代わりに chip を数秒強調し、ホバーで誰が変えたかを出す。

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IBrowserDeviceProfile } from '../../../../platform/browserView/common/browserView.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisAgentBrowserBindingModel } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import {
	IParadisListViewportsResult,
	IParadisSetViewportResult,
	IParadisViewportState,
	PARADIS_BROWSER_VIEWPORT_MCP_CHANNEL,
	ParadisViewportMcpMethod,
	paradisResolveViewportSpec,
} from '../common/paradisBrowserViewport.js';
import { IParadisBrowserViewportService } from './paradisBrowserViewportService.js';

const AGENT_LABEL_MAX_LENGTH = 40;

class ParadisBrowserViewportMcpChannel implements IServerChannel {

	constructor(
		private readonly viewportService: IParadisBrowserViewportService,
		private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		private readonly bindingModel: IParadisAgentBrowserBindingModel,
		private readonly paneTokenService: IParadisPaneTokenService,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case ParadisViewportMcpMethod.List:
				return this._list() as T;
			case ParadisViewportMcpMethod.Set:
				return await this._set(
					typeof args[0] === 'string' ? args[0] : undefined,
					typeof args[1] === 'string' ? args[1] : '',
					typeof args[2] === 'string' ? args[2] : '',
				) as T;
			case ParadisViewportMcpMethod.NoteAgentEmulation: {
				const model = typeof args[1] === 'string' ? this.browserViewWorkbenchService.getKnownBrowserViews().get(args[1])?.model : undefined;
				if (model) {
					const previous = args[2] && typeof args[2] === 'object' ? args[2] as IBrowserDeviceProfile : undefined;
					await this.viewportService.noteAgentEmulation(model, this._agentLabel(typeof args[0] === 'string' ? args[0] : undefined), previous);
				}
				return undefined as T;
			}
			case ParadisViewportMcpMethod.Describe:
				return this._describe(Array.isArray(args[0]) ? args[0].filter((id): id is string => typeof id === 'string') : []) as T;
		}
		throw new Error(`Method not found: ${command}`);
	}

	private _list(): IParadisListViewportsResult {
		return {
			sizes: this.viewportService.getSizes().map(size => ({ name: size.name, width: size.width, height: size.height, mobile: !!size.mobile })),
			globalDefault: this.viewportService.getGlobalDefault(),
		};
	}

	private _describe(tabIds: readonly string[]): Record<string, IParadisViewportState> {
		const known = this.browserViewWorkbenchService.getKnownBrowserViews();
		const result: Record<string, IParadisViewportState> = {};
		for (const tabId of tabIds.slice(0, 64)) {
			const model = known.get(tabId)?.model;
			if (model) {
				result[tabId] = this.viewportService.describe(model);
			}
		}
		return result;
	}

	private async _set(token: string | undefined, tabId: string, spec: string): Promise<IParadisSetViewportResult> {
		const target = paradisResolveViewportSpec(spec, this.viewportService.getSizes());
		if (!target) {
			return { ok: false, reason: 'unknownViewport' };
		}
		const input = this.browserViewWorkbenchService.getKnownBrowserViews().get(tabId);
		if (!input) {
			return { ok: false, reason: 'unknownTab' };
		}
		let model: IBrowserViewModel;
		try {
			model = input.model ?? await input.resolve();
		} catch {
			return { ok: false, reason: 'tabNotReady' };
		}
		const previous = this.viewportService.describe(model);
		await this.viewportService.apply(model, target, { kind: 'agent', agentLabel: this._agentLabel(token) });
		return { ok: true, previous, viewport: this.viewportService.describe(model) };
	}

	/**
	 * chip のホバーに出すペインの呼び名（「claude、ターミナル 1」）。タイトルはエージェントが書き換えられる
	 * ので危ない文字を落とし、書き換えられないターミナル番号を並べる。
	 */
	private _agentLabel(token: string | undefined): string {
		const pane = token !== undefined ? this.bindingModel.getPanes().find(candidate => candidate.token === token) : undefined;
		const instanceId = token !== undefined ? this.paneTokenService.getInstanceForToken(token) : undefined;
		const name = paradisSanitizeDisplayText(pane?.agentKind !== undefined && pane.agentKind !== 'shell' ? pane.agentKind : pane?.title, AGENT_LABEL_MAX_LENGTH);
		if (name && instanceId !== undefined) {
			return localize('paradis.browserViewport.agent.nameAndTerminal', "{0}、ターミナル {1}", name, instanceId);
		}
		if (instanceId !== undefined) {
			return localize('paradis.browserViewport.agent.terminal', "ターミナル {0}", instanceId);
		}
		return name ?? localize('paradis.browserViewport.agent.unknown', "ターミナル");
	}
}

class ParadisBrowserViewportMcpContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisBrowserViewportMcp';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisBrowserViewportService viewportService: IParadisBrowserViewportService,
		@IBrowserViewWorkbenchService browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisAgentBrowserBindingModel bindingModel: IParadisAgentBrowserBindingModel,
		@IParadisPaneTokenService paneTokenService: IParadisPaneTokenService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_BROWSER_VIEWPORT_MCP_CHANNEL, new ParadisBrowserViewportMcpChannel(viewportService, browserViewWorkbenchService, bindingModel, paneTokenService));
	}
}

registerWorkbenchContribution2(ParadisBrowserViewportMcpContribution.ID, ParadisBrowserViewportMcpContribution, WorkbenchPhase.AfterRestored);
