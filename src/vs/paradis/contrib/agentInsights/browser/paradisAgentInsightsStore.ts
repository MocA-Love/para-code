/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisTerminalScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentInsightsService, IParadisAgentPaneInsight, IParadisAgentScopePane } from '../common/paradisAgentInsights.js';

/**
 * {@link IParadisAgentInsightsService} の実装（単純なインメモリストア）。
 *
 * 持つのは「ペイントークン → 様子」だけ。ペインがどのスペースに属するかは読むたびに
 * ターミナルのスコープから引き直す（スペースの切り替えや park で所属が動いても、
 * 様子そのものは変わらないため、書き込みの契機にしない）。
 */
export class ParadisAgentInsightsStore extends Disposable implements IParadisAgentInsightsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _insights = new Map<string, IParadisAgentPaneInsight>();
	private _signature = '';

	constructor(
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
	}

	getForToken(token: string): IParadisAgentPaneInsight | undefined {
		return this._insights.get(token);
	}

	getForInstance(instanceId: number): IParadisAgentPaneInsight | undefined {
		const token = this.paneTokenService.getTokenForInstance(instanceId);
		return token !== undefined ? this._insights.get(token) : undefined;
	}

	getScopePanes(stateKey: string): readonly IParadisAgentScopePane[] {
		const panes: IParadisAgentScopePane[] = [];
		for (const insight of this._insights.values()) {
			const instanceId = this.paneTokenService.getInstanceForToken(insight.token);
			if (instanceId === undefined) {
				continue;
			}
			// cwd の最長一致や記憶からの推測では紐付けない。別のスペースの内訳を出すくらいなら出さない
			// （Issue マークと同じ基準。paradisAgentStatusSnapshotConsumer 参照）。
			const scope = this.terminalScopeService.resolveScope(instanceId);
			if (scope.kind !== 'managed' || scope.stateKey !== stateKey) {
				continue;
			}
			panes.push({ instanceId, token: insight.token, title: this.terminalService.getInstanceFromId(instanceId)?.title ?? '', insight });
		}
		return panes.sort((a, b) => a.instanceId - b.instanceId);
	}

	setInsights(insights: readonly IParadisAgentPaneInsight[]): void {
		const signature = JSON.stringify([...insights].sort((a, b) => a.token.localeCompare(b.token)));
		if (signature === this._signature) {
			return;
		}
		this._signature = signature;
		this._insights = new Map(insights.map(insight => [insight.token, insight]));
		this._onDidChange.fire();
	}
}
