/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { Channels } from '../common/paradisMobileProtocol.js';
import { IParadisMobileInboundFrame, IParadisMobileInboundFrame as InboundFrame } from '../common/paradisMobileRelay.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** ワークスペース状態スナップショット（stateチャネルのペイロード）。 */
interface StateSnapshot {
	activeWs: string | undefined;
	workspaces: { id: string; name: string; color?: string }[];
	terminals: { id: number; title: string; ws?: string; agentStatus?: string }[];
}

/** ターミナルのサブプロトコル（termチャネルのペイロード、JSON）。 */
type TermInbound =
	| { t: 'attach'; id: number }
	| { t: 'detach'; id: number }
	| { t: 'input'; id: number; data: string };
type TermOutbound =
	| { t: 'data'; id: number; data: string }
	| { t: 'exit'; id: number };

/**
 * shared process のリレーサービスと、このウィンドウのワークスペース/ターミナルを橋渡しする。
 * - state: ワークスペース・ターミナル・エージェント状態のスナップショットを push
 * - term: モバイルからの attach/input を処理し、ターミナル出力を stream 送信
 *
 * SCM / fs / browser チャネルは本スライスでは未実装（設計書 M2/M3。ここに追加していく）。
 */
export class ParadisMobileWorkspaceProvider extends Disposable {
	private readonly attachedTerminals = this._register(new DisposableMap<number>());

	constructor(
		private readonly sendFrame: (frame: IParadisMobileInboundFrame) => void,
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly terminalService: ITerminalService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly agentStatusStore: IParadisAgentStatusStore,
		private readonly logService: ILogService,
	) {
		super();

		// 状態が変わったらスナップショットを再送。
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => this.pushState()));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.pushState()));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.pushState()));
		this._register(this.terminalService.onDidChangeInstances(() => this.pushState()));
	}

	/** 接続確立直後などに全状態を送る。 */
	pushState(): void {
		const snapshot = this.buildSnapshot();
		this.sendFrame({ ch: Channels.State, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoder.encode(JSON.stringify(snapshot))) });
	}

	private buildSnapshot(): StateSnapshot {
		const workspaces = this.workspaceSwitchService.repositories.map(r => ({
			id: r.id,
			name: r.name,
			...(r.color ? { color: r.color } : {}),
		}));
		const terminals = this.terminalService.instances.map(inst => {
			const stateKey = this.terminalScopeService.getStateKeyForInstance(inst.instanceId);
			const agentStatus = stateKey ? this.agentStatusStore.getScopeStatus(stateKey) : undefined;
			return {
				id: inst.instanceId,
				title: inst.title,
				...(stateKey ? { ws: stateKey } : {}),
				...(agentStatus ? { agentStatus } : {}),
			};
		});
		return { activeWs: this.workspaceSwitchService.activeStateKey, workspaces, terminals };
	}

	/** shared process から届いたモバイル→PCフレームを処理する。 */
	handleInbound(frame: InboundFrame): void {
		if (frame.ch === Channels.State) {
			// モバイルからの state 要求（空ペイロード）には現在のスナップショットで応答。
			this.pushState();
			return;
		}
		if (frame.ch === Channels.Terminal) {
			this.handleTerminalInbound(frame.payload);
		}
	}

	private handleTerminalInbound(payload: VSBuffer): void {
		let msg: TermInbound;
		try {
			msg = JSON.parse(decoder.decode(payload.buffer)) as TermInbound;
		} catch {
			return;
		}
		const instance = this.terminalService.instances.find(i => i.instanceId === msg.id);
		if (!instance) {
			return;
		}
		if (msg.t === 'attach') {
			if (this.attachedTerminals.has(msg.id)) {
				return;
			}
			const store = new DisposableStore();
			store.add(instance.onData(data => this.sendTerm({ t: 'data', id: msg.id, data })));
			store.add(instance.onExit(() => {
				this.sendTerm({ t: 'exit', id: msg.id });
				this.attachedTerminals.deleteAndDispose(msg.id);
			}));
			this.attachedTerminals.set(msg.id, store);
		} else if (msg.t === 'detach') {
			this.attachedTerminals.deleteAndDispose(msg.id);
		} else if (msg.t === 'input') {
			// 生入力を送る（改行はモバイル側が明示的に送る）。
			instance.sendText(msg.data, false).catch(err => this.logService.warn('[paradisMobileRelay] sendText failed', err));
		}
	}

	private sendTerm(msg: TermOutbound): void {
		this.sendFrame({ ch: Channels.Terminal, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoder.encode(JSON.stringify(msg))) });
	}
}
