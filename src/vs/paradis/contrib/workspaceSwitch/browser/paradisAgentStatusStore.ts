/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusStore } from '../common/paradisWorkspaceSwitch.js';

/**
 * IParadisAgentStatusStore の実装 (単純なインメモリストア)。
 * 書き込み元は electron-browser のポーラー (paradisAgentStatus.contribution.ts)。
 * Web ビルドではポーラーが存在しないため常に空 = 状態表示なし、で安全に成立する。
 */
export class ParadisAgentStatusStore extends Disposable implements IParadisAgentStatusStore {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAgentStatuses = this._register(new Emitter<void>());
	readonly onDidChangeAgentStatuses = this._onDidChangeAgentStatuses.event;

	private _statuses = new Map<string, ParadisAgentStatus>();
	private _instanceStatuses = new Map<number, ParadisAgentStatus>();
	private _agentInstanceIds = new Set<number>();

	getScopeStatus(stateKey: string): ParadisAgentStatus | undefined {
		return this._statuses.get(stateKey);
	}

	getInstanceStatus(instanceId: number): ParadisAgentStatus | undefined {
		return this._instanceStatuses.get(instanceId);
	}

	isAgentInstance(instanceId: number): boolean {
		return this._agentInstanceIds.has(instanceId);
	}

	setScopeStatuses(statuses: Map<string, ParadisAgentStatus>): void {
		// 変化がある時だけイベントを発火 (2秒ポーリングのたびに再描画しない)
		if (this._statuses.size === statuses.size && [...statuses].every(([key, value]) => this._statuses.get(key) === value)) {
			return;
		}
		this._statuses = new Map(statuses);
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
