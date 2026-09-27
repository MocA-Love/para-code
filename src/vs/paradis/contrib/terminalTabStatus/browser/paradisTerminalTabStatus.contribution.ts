/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 呼んでいるターミナルのエディタタブに、色の点を付ける（Q43 案A）。
//
// 仕組みは upstream のベル表示と同じファイル装飾（IDecorationsService）で、タブの部品には手を
// 入れない。upstream の提供元（`terminalTabsList.ts` の TabDecorationsProvider）は下部パネルの
// ターミナル一覧を作ったときにしか登録されないので、パネルを一度も開いていないとエディタのタブには
// 何も出ない。ここでは自前の提供元を起動時に登録し、パネルの有無に関係なく出す。
//
// 色はスペース一覧のドットと同じで、完了は緑、許可待ちと質問は赤、ベルは黄。点はそのターミナルを
// 操作する（フォーカスする・キーを打つ）まで残す。

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDecorationData, IDecorationsService } from '../../../../workbench/services/decorations/common/decorations.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisCollectAllTerminalInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisAgentStatusStore } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisTerminalAttention, paradisAttentionColor, paradisNextAttentionOnBell, paradisNextAttentionOnStatus } from '../common/paradisTerminalTabStatus.js';

const DOT = '●';

export class ParadisTerminalTabStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalTabStatus';

	/** instanceId → 呼んでいる理由。操作されるまで残す。 */
	private readonly _attention = new Map<number, ParadisTerminalAttention>();
	/** instanceId → 直前に見たエージェントの状態（遷移を見分けるため）。 */
	private readonly _lastStatus = new Map<number, ParadisAgentStatus>();
	private readonly _instanceListeners = this._register(new DisposableMap<number, DisposableStore>());
	private readonly _onDidChangeDecorations = this._register(new Emitter<URI[]>());
	private readonly _onDidChangeAttention = this._register(new Emitter<ITerminalInstance>());
	/** 呼んでいる理由が変わったターミナル。タブのアイコン（Q52）もこれで描き直す。 */
	readonly onDidChangeAttention = this._onDidChangeAttention.event;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@IDecorationsService decorationsService: IDecorationsService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();
		this._register(decorationsService.registerDecorationsProvider({
			label: localize('paradis.terminalTabStatus.decorations', "ターミナルの呼び出し"),
			onDidChange: this._onDidChangeDecorations.event,
			provideDecorations: uri => this.provideDecorations(uri),
		}));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.onAgentStatusesChanged()));
		// 「操作した」とみなすのは、そのターミナルにフォーカスが入ったときとキーを打ったとき。
		this._register(this.terminalService.onDidFocusInstance(instance => this.clearAttention(instance)));
		this._register(this.terminalService.onAnyInstanceDataInput(instance => this.clearAttention(instance)));
		this._register(this.terminalService.onDidCreateInstance(instance => this.watchInstance(instance)));
		this._register(this.terminalService.onDidDisposeInstance(instance => this.forgetInstance(instance)));
		for (const instance of this.terminalService.instances) {
			this.watchInstance(instance);
		}
		this.onAgentStatusesChanged();
	}

	/** そのターミナルが今呼んでいる理由。 */
	getAttention(instanceId: number): ParadisTerminalAttention | undefined {
		return this._attention.get(instanceId);
	}

	private provideDecorations(uri: URI): IDecorationData | undefined {
		if (uri.scheme !== Schemas.vscodeTerminal) {
			return undefined;
		}
		const instance = this.terminalService.getInstanceFromResource(uri);
		const attention = instance === undefined ? undefined : this._attention.get(instance.instanceId);
		if (attention === undefined) {
			return undefined;
		}
		return {
			color: paradisAttentionColor(attention),
			letter: attention === 'bell' ? Codicon.bell : DOT,
			tooltip: attention === 'waiting'
				? localize('paradis.terminalTabStatus.waiting', "確認を待っています")
				: attention === 'done'
					? localize('paradis.terminalTabStatus.done', "作業が終わりました")
					: localize('paradis.terminalTabStatus.bell', "ベルが鳴りました"),
			// 一覧の親（フォルダ）へは伝えない。ターミナルの URI に親は無い。
			bubble: false,
		};
	}

	/** ユーザーがそのターミナルを見ているか。見ている間は呼ぶ必要が無い。 */
	private isWatching(instance: ITerminalInstance): boolean {
		return instance.hasFocus && this.hostService.hasFocus;
	}

	private onAgentStatusesChanged(): void {
		const instances = paradisCollectAllTerminalInstances(this.terminalService, this.terminalGroupService);
		for (const instance of instances) {
			const current = this.agentStatusStore.getInstanceStatus(instance.instanceId);
			const previous = this._lastStatus.get(instance.instanceId);
			if (current === undefined) {
				this._lastStatus.delete(instance.instanceId);
			} else {
				this._lastStatus.set(instance.instanceId, current);
			}
			if (current === previous && !this._attention.has(instance.instanceId)) {
				continue;
			}
			this.setAttention(instance, paradisNextAttentionOnStatus(previous, current, this._attention.get(instance.instanceId), this.isWatching(instance)));
		}
	}

	private watchInstance(instance: ITerminalInstance): void {
		if (this._instanceListeners.has(instance.instanceId)) {
			return;
		}
		const store = new DisposableStore();
		this._instanceListeners.set(instance.instanceId, store);
		// 別のスペースへ退避中のエディタのターミナルは、terminalService の一覧から外れたまま
		// 破棄されることがある。インスタンス自身の破棄で確実に片付ける。
		store.add(instance.onDisposed(() => this.forgetInstance(instance)));
		// xterm は遅れて作られる。ベルは upstream の設定（visual bell）に関係なく拾い、鳴ったあと
		// 操作されるまで残す（upstream の表示は 1 秒で消える）。
		void instance.xtermReadyPromise.then(xterm => {
			if (xterm === undefined || store.isDisposed) {
				return;
			}
			store.add(xterm.raw.onBell(() => {
				this.setAttention(instance, paradisNextAttentionOnBell(this._attention.get(instance.instanceId), this.isWatching(instance)));
			}));
		}, () => { /* xterm を作れなかったターミナルはベルも鳴らない */ });
	}

	private forgetInstance(instance: ITerminalInstance): void {
		this._instanceListeners.deleteAndDispose(instance.instanceId);
		this._lastStatus.delete(instance.instanceId);
		this._attention.delete(instance.instanceId);
	}

	private clearAttention(instance: ITerminalInstance): void {
		this.setAttention(instance, undefined);
	}

	private setAttention(instance: ITerminalInstance, attention: ParadisTerminalAttention | undefined): void {
		if (this._attention.get(instance.instanceId) === attention) {
			return;
		}
		if (attention === undefined) {
			this._attention.delete(instance.instanceId);
		} else {
			this._attention.set(instance.instanceId, attention);
		}
		this._onDidChangeDecorations.fire([instance.resource]);
		this._onDidChangeAttention.fire(instance);
	}
}

registerWorkbenchContribution2(ParadisTerminalTabStatusContribution.ID, ParadisTerminalTabStatusContribution, WorkbenchPhase.AfterRestored);
