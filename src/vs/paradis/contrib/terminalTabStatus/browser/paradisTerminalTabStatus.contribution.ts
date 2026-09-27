/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 呼んでいるターミナルのエディタタブに、色の点を付ける。
// あわせて、タブ左のアイコンを状態で差し替え、状態が無ければ Claude / OpenAI のロゴにする。
//
// 仕組みは upstream のベル表示と同じファイル装飾（IDecorationsService）で、タブの部品には手を
// 入れない。upstream の提供元（`terminalTabsList.ts` の TabDecorationsProvider）は下部パネルの
// ターミナル一覧を作ったときにしか登録されないので、パネルを一度も開いていないとエディタのタブには
// 何も出ない。ここでは自前の提供元を起動時に登録し、パネルの有無に関係なく出す。
//
// 色はスペース一覧のドットと同じで、完了は緑、許可待ちと質問は赤、ベルは黄。点はそのターミナルを
// 操作する（フォーカスする・キーを打つ）まで残す。

import './media/paradisTerminalTabStatus.css';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { getCodiconFontCharacters } from '../../../../base/common/codiconsUtil.js';
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
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { PARADIS_CLAUDE_LOGO_PATH, PARADIS_CODEX_LOGO_PATH } from '../../../common/paradisAgentLogoPaths.js';
import { paradisInteractiveAgentCommand } from '../../mobileRelay/common/paradisAgentCliCommand.js';
import { IParadisTerminalTabIcon, paradisRegisterTerminalTabIconProvider } from '../../workspaceSwitch/browser/paradisTerminalTabIconRegistry.js';
import { ParadisTerminalAttention, ParadisTerminalTabIconKind, paradisAttentionColor, paradisGuessAgentKindFromTitle, paradisNextAttentionOnBell, paradisNextAttentionOnStatus, paradisTerminalTabIconKind } from '../common/paradisTerminalTabStatus.js';

const DOT = '\u25CF';

/** upstream のベルの状態（`TerminalStatus.Bell`。const enum なので値で持つ）。 */
const UPSTREAM_BELL_STATUS_ID = 'bell';

/**
 * 種類ごとのタブのアイコン。codicon は「その種類のクラスが付いた ::before」を CSS が描き替える
 * 土台で、回転（作業中）とロゴはクラスの側で描く（`media/paradisTerminalTabStatus.css`）。
 * 作業中に `Codicon.loading` を使わないのは、`.codicon-loading` の回転がラベル全体に掛かるため。
 */
const TAB_ICONS: Record<ParadisTerminalTabIconKind, IParadisTerminalTabIcon> = {
	working: { icon: Codicon.sync, extraClasses: ['paradis-terminal-tab-state', 'paradis-terminal-tab-working'] },
	permission: { icon: Codicon.bell, extraClasses: ['paradis-terminal-tab-state', 'paradis-terminal-tab-waiting'] },
	question: { icon: Codicon.question, extraClasses: ['paradis-terminal-tab-state', 'paradis-terminal-tab-waiting'] },
	done: { icon: Codicon.circleFilled, extraClasses: ['paradis-terminal-tab-state', 'paradis-terminal-tab-done'] },
	claude: { icon: Codicon.terminal, extraClasses: ['paradis-terminal-tab-logo', 'paradis-terminal-tab-logo-claude'] },
	codex: { icon: Codicon.terminal, extraClasses: ['paradis-terminal-tab-logo', 'paradis-terminal-tab-logo-codex'] },
};

/**
 * 実行時に作る CSS のセレクタの頭。`media/paradisTerminalTabStatus.css` と揃える。
 * `.file-icons-enabled` を含めるのは、ファイルアイコンテーマを外している人には upstream と同じく
 * タブのアイコンを出さないため（upstream はその場合 codicon の ::before を消している）。
 */
const TAB_ICON_SELECTOR = '.monaco-workbench.file-icons-enabled .monaco-icon-label.terminal-tab';

/** ロゴは色をテーマに追従させるため、SVG を mask にして地の色（currentColor）で塗る。 */
function logoMaskRule(kind: 'claude' | 'codex', path: string): string {
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600'><path d='${path}'/></svg>`;
	const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
	return `${TAB_ICON_SELECTOR}.paradis-terminal-tab-logo-${kind}[class*='codicon-']::before { -webkit-mask-image: ${url}; mask-image: ${url}; }`;
}

/**
 * 作業中の回転アイコンの中身。codicon の loading の文字を upstream の登録から引く（文字コードを
 * 直に書くと、codicon の更新で別の図形になる）。
 */
function workingGlyphRule(): string {
	const code = getCodiconFontCharacters()[Codicon.loading.id];
	return code === undefined ? '' : `${TAB_ICON_SELECTOR}.paradis-terminal-tab-working[class*='codicon-']::before { content: '\\${code.toString(16)}' !important; }`;
}

export class ParadisTerminalTabStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalTabStatus';

	/** instanceId → 呼んでいる理由。操作されるまで残す。 */
	private readonly _attention = new Map<number, ParadisTerminalAttention>();
	/** instanceId → 直前に見たエージェントの状態（遷移を見分けるため）。 */
	private readonly _lastStatus = new Map<number, ParadisAgentStatus>();
	private readonly _instanceListeners = this._register(new DisposableMap<number, DisposableStore>());
	private readonly _onDidChangeDecorations = this._register(new Emitter<URI[]>());
	/** instanceId → 動いているエージェント（コマンドラインから分かったもの）。 */
	private readonly _agentKinds = new Map<number, 'claude' | 'codex'>();
	/** instanceId → 直前に出したタブのアイコン。変わったときだけ描き直させる。 */
	private readonly _tabIconKinds = new Map<number, ParadisTerminalTabIconKind>();
	private readonly _onDidChangeTabIcon = this._register(new Emitter<number>());

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
		this._register(paradisRegisterTerminalTabIconProvider({
			onDidChange: this._onDidChangeTabIcon.event,
			getTabIcon: instance => this.getTabIcon(instance.instanceId),
		}));
		const logoStyles = this._register(new DisposableStore());
		// 中身は追加する前に入れる（補助ウィンドウへの複製は追加した時点の内容で作られる）。
		createStyleSheet(undefined, style => {
			style.textContent = [
				logoMaskRule('claude', PARADIS_CLAUDE_LOGO_PATH),
				logoMaskRule('codex', PARADIS_CODEX_LOGO_PATH),
				workingGlyphRule(),
			].join('\n');
		}, logoStyles);
		// どのエージェントが動いているかは、シェル統合が報告するコマンドラインで知る。
		const executed = this._register(this.terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, capability => capability.onCommandExecuted));
		this._register(executed.event(({ instance, data }) => this.onCommandExecuted(instance, data.command)));
		const finished = this._register(this.terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, capability => capability.onCommandFinished));
		this._register(finished.event(({ instance, data }) => this.onCommandFinished(instance, data.command)));
		this._register(this.terminalService.onAnyInstanceTitleChange(instance => this.refreshTabIcon(instance)));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.onAgentStatusesChanged()));
		// 「操作した」とみなすのは、そのターミナルにフォーカスが入ったときとキーを打ったときだけ。
		// `onAnyInstanceDataInput` は使わない。カーソル位置の問い合わせへの自動応答やフォーカス
		// 報告、モバイルやプリセットからの送信でも発火し、ユーザーが見ていないのに点が消える。
		this._register(this.terminalService.onDidFocusInstance(instance => this.clearAttention(instance)));
		// upstream のベル表示（パネルのタブ一覧を作ったときだけ登録される）と重ならないよう、
		// その状態が変わったら描き直す。
		this._register(this.terminalService.onAnyInstancePrimaryStatusChange(instance => this._onDidChangeDecorations.fire([instance.resource])));
		this._register(this.terminalService.onDidCreateInstance(instance => this.watchInstance(instance)));
		this._register(this.terminalService.onDidDisposeInstance(instance => this.forgetInstance(instance)));
		for (const instance of this.terminalService.instances) {
			this.watchInstance(instance);
		}
		this.onAgentStatusesChanged();
	}

	/** タブ左のアイコン。エージェントでないターミナルは undefined（upstream のまま）。 */
	private getTabIcon(instanceId: number): IParadisTerminalTabIcon | undefined {
		const kind = this._tabIconKinds.get(instanceId) ?? this.computeTabIconKind(instanceId);
		return kind === undefined ? undefined : TAB_ICONS[kind];
	}

	private computeTabIconKind(instanceId: number): ParadisTerminalTabIconKind | undefined {
		return paradisTerminalTabIconKind(
			this.agentStatusStore.getInstanceStatus(instanceId),
			this._attention.get(instanceId),
			this.agentKind(instanceId),
		);
	}

	/**
	 * そのターミナルで動いているエージェント。コマンドラインで分かったものを優先し、再接続した
	 * ターミナルは実行中のコマンド、最後にエージェントだと分かっているタブのタイトルから推測する。
	 */
	private agentKind(instanceId: number): 'claude' | 'codex' | undefined {
		const known = this._agentKinds.get(instanceId);
		if (known !== undefined) {
			return known;
		}
		const instance = this.terminalService.instances.find(candidate => candidate.instanceId === instanceId);
		if (instance === undefined) {
			return undefined;
		}
		const executing = instance.capabilities.get(TerminalCapability.CommandDetection)?.executingCommand;
		const fromCommand = executing === undefined ? undefined : paradisInteractiveAgentCommand(executing)?.agent;
		if (fromCommand !== undefined) {
			return fromCommand;
		}
		return this.agentStatusStore.isAgentInstance(instanceId) ? paradisGuessAgentKindFromTitle(instance.title) : undefined;
	}

	private onCommandExecuted(instance: ITerminalInstance, commandLine: string): void {
		const agent = paradisInteractiveAgentCommand(commandLine)?.agent;
		if (agent === undefined) {
			return;
		}
		this._agentKinds.set(instance.instanceId, agent);
		this.refreshTabIcon(instance);
	}

	private onCommandFinished(instance: ITerminalInstance, commandLine: string): void {
		// エージェントを終えてシェルへ戻ったら、ロゴをふつうのターミナルのアイコンへ戻す。
		if (!this._agentKinds.has(instance.instanceId) || paradisInteractiveAgentCommand(commandLine) === undefined) {
			return;
		}
		this._agentKinds.delete(instance.instanceId);
		this.refreshTabIcon(instance);
	}

	private refreshTabIcon(instance: ITerminalInstance): void {
		const kind = this.computeTabIconKind(instance.instanceId);
		if (this._tabIconKinds.get(instance.instanceId) === kind) {
			return;
		}
		if (kind === undefined) {
			this._tabIconKinds.delete(instance.instanceId);
		} else {
			this._tabIconKinds.set(instance.instanceId, kind);
		}
		this._onDidChangeTabIcon.fire(instance.instanceId);
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
		// upstream のベル表示が出ている間は、同じベルをもう1つ並べない（色だけ付ける）。
		const upstreamBellShown = attention === 'bell' && instance?.statusList.statuses.some(status => status.id === UPSTREAM_BELL_STATUS_ID) === true;
		return {
			color: paradisAttentionColor(attention),
			letter: upstreamBellShown ? undefined : attention === 'bell' ? Codicon.bell : DOT,
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
			const stoppedForUser = current === undefined && this.agentStatusStore.wasStoppedForUser?.(instance.instanceId) === true;
			this.setAttention(instance, paradisNextAttentionOnStatus(previous, current, this._attention.get(instance.instanceId), this.isWatching(instance), stoppedForUser));
			this.refreshTabIcon(instance);
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
			// キー入力（貼り付けはフォーカスを伴うので上のフォーカスで消える）。
			store.add(xterm.raw.onKey(() => this.clearAttention(instance)));
		}, () => { /* xterm を作れなかったターミナルはベルも鳴らない */ });
	}

	private forgetInstance(instance: ITerminalInstance): void {
		this._instanceListeners.deleteAndDispose(instance.instanceId);
		this._lastStatus.delete(instance.instanceId);
		this._attention.delete(instance.instanceId);
		this._agentKinds.delete(instance.instanceId);
		this._tabIconKinds.delete(instance.instanceId);
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
		this.refreshTabIcon(instance);
	}
}

registerWorkbenchContribution2(ParadisTerminalTabStatusContribution.ID, ParadisTerminalTabStatusContribution, WorkbenchPhase.AfterRestored);
