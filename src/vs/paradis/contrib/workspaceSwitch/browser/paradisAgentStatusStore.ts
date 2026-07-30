/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusStore, paradisAggregateAgentStatus, paradisSortAgentStatuses } from '../common/paradisWorkspaceSwitch.js';

/** 全スコープで共有する空の結果。キャスト経由の書き込みで汚染されないよう凍結しておく */
const EMPTY_BREAKDOWN: readonly ParadisAgentStatus[] = Object.freeze([]);

/**
 * IParadisAgentStatusStore の実装 (単純なインメモリストア)。
 * 書き込み元は electron-browser のポーラー (paradisAgentStatus.contribution.ts)。
 * Web ビルドではポーラーが存在しないため常に空 = 状態表示なし、で安全に成立する。
 *
 * 保持するのはスコープ内の内訳のみで、代表値 (getScopeStatus) は内訳から導出する。
 * 2つを別々に持つと、集約の基準がストアとポーラーで二重定義になり得るため。
 */
export class ParadisAgentStatusStore extends Disposable implements IParadisAgentStatusStore {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAgentStatuses = this._register(new Emitter<void>());
	readonly onDidChangeAgentStatuses = this._onDidChangeAgentStatuses.event;

	private _breakdowns = new Map<string, ParadisAgentStatus[]>();
	private _statuses = new Map<string, ParadisAgentStatus>();
	private _instanceStatuses = new Map<number, ParadisAgentStatus>();
	private _agentInstanceIds = new Set<number>();

	getScopeStatus(stateKey: string): ParadisAgentStatus | undefined {
		return this._statuses.get(stateKey);
	}

	getScopeBreakdown(stateKey: string): readonly ParadisAgentStatus[] {
		return this._breakdowns.get(stateKey) ?? EMPTY_BREAKDOWN;
	}

	getInstanceStatus(instanceId: number): ParadisAgentStatus | undefined {
		return this._instanceStatuses.get(instanceId);
	}

	isAgentInstance(instanceId: number): boolean {
		return this._agentInstanceIds.has(instanceId);
	}

	setScopeBreakdowns(breakdowns: ReadonlyMap<string, readonly ParadisAgentStatus[]>): void {
		// 比較は整列後の値どうしで行う (保持する側だけを整列すると、同じ内容でも
		// 並びの違いで毎回「変化あり」と判定されてしまう)
		const sorted = new Map([...breakdowns].map(([key, value]) => [key, paradisSortAgentStatuses(value)] as const));
		// 変化がある時だけイベントを発火 (2秒ポーリングのたびに再描画しない)
		const unchanged = this._breakdowns.size === sorted.size && [...sorted].every(([key, value]) => {
			const previous = this._breakdowns.get(key);
			return previous !== undefined && previous.length === value.length && previous.every((status, index) => status === value[index]);
		});
		if (unchanged) {
			return;
		}
		this._breakdowns = new Map(sorted);
		this._statuses = new Map();
		for (const [key, value] of this._breakdowns) {
			const aggregated = paradisAggregateAgentStatus(value);
			if (aggregated !== undefined) {
				this._statuses.set(key, aggregated);
			}
		}
		this._onDidChangeAgentStatuses.fire();
	}

	setInstanceStates(statuses: Map<number, ParadisAgentStatus>, agentInstanceIds: Set<number>): void {
		// setScopeStatuses と同じく、変化がある時だけイベントを発火する
		const statusesUnchanged = this._instanceStatuses.size === statuses.size && [...statuses].every(([key, value]) => this._instanceStatuses.get(key) === value);
		const agentsUnchanged = this._agentInstanceIds.size === agentInstanceIds.size && [...agentInstanceIds].every(id => this._agentInstanceIds.has(id));
		if (statusesUnchanged && agentsUnchanged) {
			return;
		}
		this._instanceStatuses = new Map(statuses);
		this._agentInstanceIds = new Set(agentInstanceIds);
		this._onDidChangeAgentStatuses.fire();
	}
}
