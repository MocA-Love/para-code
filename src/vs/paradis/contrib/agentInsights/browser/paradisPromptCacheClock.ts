/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer, TimeoutTimer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusStore } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentInsightsService, IParadisAgentPaneInsight, PARADIS_PROMPT_CACHE_WARNING_MS, paradisVisiblePromptCacheRemainingMs } from '../common/paradisAgentInsights.js';

/** 1ペイン分の残り時間。 */
export interface IParadisPromptCacheReading {
	readonly remainingMs: number;
	readonly ttlMs: number;
	/** 残り60秒以下。 */
	readonly warning: boolean;
}

/** 1スペース分の残り時間。代表値は最も早く切れるペイン。 */
export interface IParadisScopePromptCacheReading extends IParadisPromptCacheReading {
	readonly panes: readonly (IParadisPromptCacheReading & { readonly title: string })[];
}

/**
 * スペース一覧の行に出す状態。行の高さを揺らさないため、Claude のペインにキャッシュの記録が
 * ある間は、応答中や切れた後も枠を残して「止まっている」ことを表す。
 */
export type ParadisScopePromptCacheState =
	| { readonly kind: 'counting'; readonly reading: IParadisScopePromptCacheReading }
	| { readonly kind: 'paused'; readonly reason: 'working' | 'expired' };

/**
 * プロンプトキャッシュの残り時間を秒単位で配る時計。
 *
 * - {@link onDidChangeVisibility}: 表示するペインの集合が変わった（新しく出た・切れた・応答を
 *   始めた）。スペース一覧はこれで行の高さを組み直す
 * - {@link onDidTick}: 表示中の数字を書き換える合図。何も表示していない間は止まっている
 *
 * 切れる瞬間は次の応答を待たずに知らせる必要があるので、最も早く切れるペインの期限に
 * タイマーを掛けて、集合を計算し直す。
 */
export class ParadisPromptCacheClock extends Disposable {

	private readonly _onDidChangeVisibility = this._register(new Emitter<void>());
	readonly onDidChangeVisibility = this._onDidChangeVisibility.event;
	private readonly _onDidTick = this._register(new Emitter<void>());
	readonly onDidTick = this._onDidTick.event;
	/**
	 * キャッシュの記録を持つ Claude ペインの集合が変わった。応答の開始・終了や期限切れでは
	 * 変わらないので、スペース一覧はこれだけで行の高さを組み直す（ターンごとに揺らさない）。
	 */
	private readonly _onDidChangeCandidates = this._register(new Emitter<void>());
	readonly onDidChangeCandidates = this._onDidChangeCandidates.event;

	private readonly ticker = this._register(new IntervalTimer());
	private readonly expiryTimer = this._register(new TimeoutTimer());
	private visibleSignature = '';
	private candidateSignature = '';
	private ticking = false;

	constructor(
		@IParadisAgentInsightsService private readonly insightsService: IParadisAgentInsightsService,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
	) {
		super();
		this._register(this.insightsService.onDidChange(() => this.reevaluate()));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.reevaluate()));
		this.reevaluate();
	}

	/** そのペインで出す残り時間。出さないときは undefined。 */
	readInstance(instanceId: number, now = Date.now()): IParadisPromptCacheReading | undefined {
		return this.read(this.insightsService.getForInstance(instanceId), instanceId, now);
	}

	/** そのスペースで出す残り時間（最も早く切れるペイン）。出さないときは undefined。 */
	readScope(stateKey: string, now = Date.now()): IParadisScopePromptCacheReading | undefined {
		const panes: (IParadisPromptCacheReading & { readonly title: string })[] = [];
		for (const pane of this.insightsService.getScopePanes(stateKey)) {
			const reading = this.read(pane.insight, pane.instanceId, now);
			if (reading) {
				panes.push({ ...reading, title: pane.title });
			}
		}
		if (panes.length === 0) {
			return undefined;
		}
		panes.sort((a, b) => a.remainingMs - b.remainingMs);
		return { ...panes[0], panes };
	}

	/**
	 * スペース一覧の行の状態。Claude のペインにキャッシュの記録が1つも無ければ undefined
	 * （枠ごと出さない）。数えているペインがあれば最も早く切れるもの、無ければ止まっている理由。
	 */
	readScopeState(stateKey: string, now = Date.now()): ParadisScopePromptCacheState | undefined {
		const candidates = this.insightsService.getScopePanes(stateKey).filter(pane => pane.insight.agent === 'claude' && pane.insight.promptCache !== undefined);
		if (candidates.length === 0) {
			return undefined;
		}
		const reading = this.readScope(stateKey, now);
		if (reading) {
			return { kind: 'counting', reading };
		}
		const working = candidates.some(pane => this.agentStatusStore.getInstanceStatus(pane.instanceId) === 'working');
		return { kind: 'paused', reason: working ? 'working' : 'expired' };
	}

	private read(insight: IParadisAgentPaneInsight | undefined, instanceId: number, now: number): IParadisPromptCacheReading | undefined {
		const working = this.agentStatusStore.getInstanceStatus(instanceId) === 'working';
		const remainingMs = paradisVisiblePromptCacheRemainingMs(insight, working, now);
		if (remainingMs === undefined || !insight?.promptCache) {
			return undefined;
		}
		return { remainingMs, ttlMs: insight.promptCache.ttlMs, warning: remainingMs <= PARADIS_PROMPT_CACHE_WARNING_MS };
	}

	private reevaluate(): void {
		const now = Date.now();
		const visible: string[] = [];
		const candidates: string[] = [];
		let nextExpiry: number | undefined;
		for (const { instanceId, token } of this.paneTokenService.listPaneTokens()) {
			const insight = this.insightsService.getForToken(token);
			if (insight?.agent === 'claude' && insight.promptCache) {
				candidates.push(token);
			}
			const reading = this.read(insight, instanceId, now);
			if (!reading) {
				continue;
			}
			visible.push(token);
			nextExpiry = Math.min(nextExpiry ?? Number.MAX_SAFE_INTEGER, reading.remainingMs);
		}
		const signature = visible.sort().join('\n');
		if (nextExpiry !== undefined) {
			// 期限ちょうどでは切り上げた秒表示がまだ 0:01 のことがあるので、少し後で見直す。
			this.expiryTimer.cancelAndSet(() => this.reevaluate(), nextExpiry + 50);
		} else {
			this.expiryTimer.cancel();
		}
		const shouldTick = visible.length > 0;
		if (shouldTick !== this.ticking) {
			this.ticking = shouldTick;
			if (shouldTick) {
				this.ticker.cancelAndSet(() => this._onDidTick.fire(), 1000);
			} else {
				this.ticker.cancel();
			}
		}
		if (signature !== this.visibleSignature) {
			this.visibleSignature = signature;
			this._onDidChangeVisibility.fire();
		}
		const candidateSignature = candidates.sort().join('\n');
		if (candidateSignature !== this.candidateSignature) {
			this.candidateSignature = candidateSignature;
			this._onDidChangeCandidates.fire();
		}
		this._onDidTick.fire();
	}
}
