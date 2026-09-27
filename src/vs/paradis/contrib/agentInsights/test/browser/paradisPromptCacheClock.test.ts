/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusStore } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentInsightsService, IParadisAgentPaneInsight, IParadisAgentScopePane, PARADIS_PROMPT_CACHE_TTL_5M } from '../../common/paradisAgentInsights.js';
import { ParadisPromptCacheClock } from '../../browser/paradisPromptCacheClock.js';

const SCOPE = 'space-1';

class TestInsights implements IParadisAgentInsightsService {
	declare readonly _serviceBrand: undefined;
	readonly changed = new Emitter<void>();
	readonly onDidChange = this.changed.event;
	insights: IParadisAgentPaneInsight[] = [];
	getForToken(token: string): IParadisAgentPaneInsight | undefined { return this.insights.find(insight => insight.token === token); }
	getForInstance(instanceId: number): IParadisAgentPaneInsight | undefined { return this.getForToken(`t${instanceId}`); }
	getScopePanes(stateKey: string): readonly IParadisAgentScopePane[] {
		return stateKey === SCOPE ? this.insights.map(insight => ({ instanceId: Number(insight.token.slice(1)), token: insight.token, title: insight.token, insight })) : [];
	}
	setInsights(insights: readonly IParadisAgentPaneInsight[]): void {
		this.insights = [...insights];
		this.changed.fire();
	}
}

class TestStatuses implements IParadisAgentStatusStore {
	declare readonly _serviceBrand: undefined;
	readonly changed = new Emitter<void>();
	readonly onDidChangeAgentStatuses = this.changed.event;
	statuses = new Map<number, ParadisAgentStatus>();
	getScopeStatus(): ParadisAgentStatus | undefined { return undefined; }
	getScopeBreakdown(): readonly ParadisAgentStatus[] { return []; }
	getInstanceStatus(instanceId: number): ParadisAgentStatus | undefined { return this.statuses.get(instanceId); }
	isAgentInstance(): boolean { return false; }
	hasDiscoveredAgentSession(): boolean { return false; }
	getScopeIssueUrls(): readonly string[] { return []; }
	setDiscoveredAgentPaneTokens(): void { }
	setScopeBreakdowns(): void { }
	setInstanceStates(): void { }
	setScopeIssueUrls(): void { }
}

class TestPaneTokens implements IParadisPaneTokenService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;
	constructor(private readonly insights: TestInsights) { }
	getTokenForInstance(instanceId: number): string | undefined { return `t${instanceId}`; }
	getInstanceForToken(token: string): number | undefined { return Number(token.slice(1)); }
	listPaneTokens(): readonly { readonly instanceId: number; readonly token: string }[] {
		return this.insights.insights.map(insight => ({ instanceId: Number(insight.token.slice(1)), token: insight.token }));
	}
	isCodexPaneAppServerEnabled(): boolean { return false; }
	prepareShellLaunchConfig(_shellLaunchConfig: IShellLaunchConfig): void { }
}

suite('ParadisPromptCacheClock', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the Workspaces slot while a Claude pane has a cache record, so the row height does not follow each turn', () => {
		const insights = new TestInsights();
		const statuses = new TestStatuses();
		store.add(insights.changed);
		store.add(statuses.changed);
		const clock = store.add(new ParadisPromptCacheClock(insights, statuses, new TestPaneTokens(insights)));
		let candidateChanges = 0;
		store.add(clock.onDidChangeCandidates(() => candidateChanges++));

		const now = Date.now();
		const claude = (lastUsedAt: number): IParadisAgentPaneInsight => ({ token: 't1', agent: 'claude', subagents: [], promptCache: { lastUsedAt, ttlMs: PARADIS_PROMPT_CACHE_TTL_5M } });
		const kinds: unknown[] = [clock.readScopeState(SCOPE, now)?.kind];

		insights.setInsights([claude(now - 60_000)]);
		const counting = clock.readScopeState(SCOPE, now);
		kinds.push(counting?.kind === 'counting' ? Math.round(counting.reading.remainingMs / 1000) : counting);
		const afterAppear = candidateChanges;

		// 応答を始めた・期限が切れた: 数字は止まるが、枠は残る (行の高さを変えない)
		statuses.statuses.set(1, 'working');
		statuses.changed.fire();
		kinds.push(clock.readScopeState(SCOPE, now));
		statuses.statuses.delete(1);
		statuses.changed.fire();
		insights.setInsights([claude(now - PARADIS_PROMPT_CACHE_TTL_5M - 1)]);
		kinds.push(clock.readScopeState(SCOPE, now));
		const afterTurns = candidateChanges;

		// Codex だけなら枠を出さない
		insights.setInsights([{ token: 't1', agent: 'codex', subagents: [], promptCache: { lastUsedAt: now, ttlMs: PARADIS_PROMPT_CACHE_TTL_5M } }]);
		kinds.push(clock.readScopeState(SCOPE, now));

		assert.deepStrictEqual({ kinds, afterAppear, afterTurns, final: candidateChanges }, {
			kinds: [undefined, 240, { kind: 'paused', reason: 'working' }, { kind: 'paused', reason: 'expired' }, undefined],
			// 出る・消えるのときだけ知らせる。応答の開始・終了と期限切れでは知らせない
			afterAppear: 1,
			afterTurns: 1,
			final: 2,
		});
	});
});
