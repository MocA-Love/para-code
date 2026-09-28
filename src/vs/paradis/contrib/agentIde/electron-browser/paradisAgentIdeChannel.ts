/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// IDE 操作ツール（O1）のウィンドウ側の受け口。shared process の MCP サーバーが「呼び出し元ペインを
// 所有するウィンドウ」だけへ振り分けて呼ぶので、ここに来る要求はこのウィンドウのペインからのもの。
//
// ここで決めること:
//  - 対象のターミナルの特定（ID はペイントークンのハッシュ。トークンそのものはエージェントへ出さない）
//  - 範囲: 読み取りは同じスペースと呼び出し元が作ったもの（設定でウィンドウ全体）。送信は同じスペース
//    （設定でウィンドウ全体）と呼び出し元が作ったもの。閉じる・削除は呼び出し元が作ったものだけ。
//    所属は台帳の記録だけで決める（記録の無いターミナルを今のスペースとみなさない）
//  - 「誰が作ったか」「誰が子か」の台帳。ワークスペースの保存領域に ID（トークンのハッシュ）だけで残し、
//    ターミナルが閉じたら消す。子（エージェントのツールで起動したペイン）はさらに起動・作成できない
//  - 作成の上限と、送信・起動の利用者への知らせ
//
// 設定（送信・作成の可否）は shared process でも見ているが、ここでも見る（どちらか片方の
// 取りこぼしで送らないように）。

import { disposableTimeout, Sequencer } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisCollectLivePaneInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import {
	IParadisAgentStatusStore,
	IParadisSpaceEntry,
	IParadisTerminalScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktreeService,
	PARADIS_REMOVE_WORKTREE_COMMAND_ID,
	paradisListSpaces,
	paradisResolveInstanceSpace,
	paradisWorktreeStateKey,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentCommandTemplate, ParadisAgentPromptQuotingError } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisLaunchAgentInWorkspace, paradisOpenEditorTerminalInSpace, paradisRunWorktreeCreateFlow } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { paradisCanPasteMultiline, paradisTerminalRunsAgent } from '../browser/paradisAgentIdeTerminalInput.js';
import {
	PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING,
	PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING,
	PARADIS_AGENT_IDE_ALLOW_SHELL_COMMANDS_SETTING,
	PARADIS_AGENT_IDE_CONTEXT_LINES,
	PARADIS_AGENT_IDE_LAUNCH_GRACE_MS,
	PARADIS_AGENT_IDE_MAX_CREATED_PER_CALLER,
	PARADIS_AGENT_IDE_MAX_CREATED_PER_WINDOW,
	PARADIS_AGENT_IDE_MAX_SCROLLBACK_LINES,
	PARADIS_AGENT_IDE_MAX_SPACES_PER_CALLER,
	PARADIS_AGENT_IDE_METHOD,
	PARADIS_AGENT_IDE_OUT_OF_READ_SCOPE_MESSAGE,
	PARADIS_AGENT_IDE_READ_OTHER_SPACES_SETTING,
	PARADIS_AGENT_IDE_SHELL_DISABLED_MESSAGE,
	ParadisAgentIdeKey,
	ParadisAgentIdeRequest,
	ParadisAgentIdeResult,
	ParadisAgentIdeTerminalStatus,
	paradisAgentIdeActionScope,
	paradisAgentIdeActionsAllowed,
	paradisAgentIdeKeySequence,
	paradisAgentIdeMessagePrefix,
	paradisAgentIdeNeedsHuman,
	paradisAgentIdeScreenShowsPrompt,
	paradisAgentIdeStatusLabel,
	paradisAgentIdeTailLines,
	paradisAgentIdeUntrustedTitle,
} from '../common/paradisAgentIde.js';
import { PARADIS_AGENT_TRUST_DIALOG_MESSAGE, paradisAgentStartupScreenState } from '../common/paradisAgentStartupScreen.js';

/** 台帳の保存先（ワークスペースの保存領域）。中身はターミナル ID とスペースのキーだけで、トークンは入れない。 */
const LEDGER_STORAGE_KEY = 'paradis.agentIde.ledger';
/** 台帳に残す呼び出し元の数・子の数の上限（古いものから捨てる）。 */
const MAX_LEDGER_CALLERS = 200;
const MAX_LEDGER_CHILDREN = 500;
/** 起動・再読み込みの後、台帳を生きているペインと突き合わせるまでの時間（常駐ターミナルの再接続を待つ）。 */
const LEDGER_PRUNE_DELAY_MS = 60_000;

/** ペイントークンからエージェントへ見せる ID を作る。トークンは推測できない乱数なので、ハッシュから元へは戻せない。 */
export function paradisAgentIdeTerminalId(paneToken: string): string {
	const sha = new StringSHA1();
	sha.update(`paradis-agent-ide:${paneToken}`);
	return `t_${sha.digest().slice(0, 12)}`;
}

interface IResolvedTerminal {
	readonly id: string;
	readonly token: string;
	readonly instance: ITerminalInstance;
	/** 所属スペース（台帳の記録）。共通ターミナル・所属が未確定のものは undefined。 */
	readonly space: string | undefined;
}

interface ICallerLedger {
	readonly terminals: Set<string>;
	readonly spaces: Set<string>;
}

interface IStoredLedger {
	readonly callers?: Record<string, { readonly terminals?: unknown; readonly spaces?: unknown }>;
	readonly children?: unknown;
}

type Failure = { readonly ok: false; readonly error: string };

function fail(error: string): Failure {
	return { ok: false, error };
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const UNKNOWN_TERMINAL = (id: string) => `There is no terminal with id "${id}" in this Para Code window (it may have been closed). Call list_terminals for the current ids.`;
const UNKNOWN_SPACE = (space: string) => `Unknown space "${space}". Call list_spaces for the space keys.`;
const CALLER_UNKNOWN = 'Para Code cannot find your own terminal in this window yet (it may still be restoring). Retry in a few seconds.';
const OUT_OF_SCOPE = 'That terminal is in a different space from yours. Agents can only send input to terminals in their own space and to terminals and spaces they created themselves (the user can widen this to the whole window in Para Code settings).';
const CALLER_NO_SPACE = 'Para Code cannot tell which space your terminal belongs to (it may be the shared panel terminal or still restoring), so it only lets you reach terminals and spaces you created yourself.';
const NEEDS_HUMAN = 'That terminal is waiting for the user to answer a permission request or a question, so Para Code does not send anything to it. Tell the user instead.';
const CHILD_CANNOT_CREATE = 'You were started by another agent through Para Code, so you cannot launch agents, open terminals or create spaces yourself. Report back to the agent or the user instead.';

export class ParadisAgentIdeChannel extends Disposable implements IServerChannel {

	/** 呼び出し元のターミナル ID → その呼び出し元が作ったもの。 */
	private readonly _ledgers = new Map<string, ICallerLedger>();
	/** エージェントのツールで起動したペインの ID（子。さらに起動・作成はできない）。 */
	private readonly _children = new Set<string>();
	/** エージェントのツールで作ったペインを作った時刻（起動待ちの猶予に使う。保存しない）。 */
	private readonly _launchedAt = new Map<string, number>();
	/** プロンプト無しで起動したエージェントのターミナル（準備ができたら、それ以上は動き出さない）。 */
	private readonly _launchedIdle = new Set<string>();
	/** ペイントークン → ID の計算結果。 */
	private readonly _idCache = new Map<string, string>();
	/** インスタンス → ID（閉じたときに台帳を掃除するため。閉じた後はトークンを引けない）。 */
	private readonly _instanceIds = new Map<number, string>();
	/** worktree の作成は同じリポジトリで重なると名前の重複回避がずれるので、1本ずつ流す。 */
	private readonly _createSequencer = new Sequencer();
	/** 利用者に確認を出している削除の依頼（同時に1件まで）。 */
	private _pendingRemoval = false;

	constructor(
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@IParadisAgentModelCatalogService private readonly modelCatalogService: IParadisAgentModelCatalogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._loadLedger();
		// 再読み込みの直後は、前のセッションで作ったターミナルがまだ一覧に戻っていない（常駐から再接続する）。
		// 端末の接続（SSH の再接続を含む）が済んでから、さらに少し待って、もう居ないものを台帳から掃除する
		// （ツールを一度も呼ばないまま閉じた子など）。子の印は掃除では消さない（遅れて戻った子が作成の
		// 制限から外れないように）。子の印は件数の上限だけで絞る
		void this.terminalService.whenConnected.then(() => {
			if (!this._store.isDisposed) {
				this._register(disposableTimeout(() => this._pruneLedger(), LEDGER_PRUNE_DELAY_MS));
			}
		});
		this._register(this.terminalService.onDidDisposeInstance(instance => {
			// ウィンドウを閉じる・再読み込みするときの破棄では消さない（ターミナルは常駐して戻ってくる）
			if (this.lifecycleService.willShutdown) {
				return;
			}
			const id = this._instanceIds.get(instance.instanceId);
			this._instanceIds.delete(instance.instanceId);
			if (id !== undefined) {
				this._forgetTerminal(id);
			}
		}));
		this._register(this.workspaceSwitchService.onDidRetireScope(stateKey => {
			let changed = false;
			for (const ledger of this._ledgers.values()) {
				changed = ledger.spaces.delete(stateKey) || changed;
			}
			if (changed) {
				this._saveLedger();
			}
		}));
	}

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		if (command !== PARADIS_AGENT_IDE_METHOD) {
			throw new Error(`Method not found: ${command}`);
		}
		const args = Array.isArray(arg) ? arg : [];
		const callerToken = typeof args[0] === 'string' ? args[0] : undefined;
		const request = args[1] as ParadisAgentIdeRequest | undefined;
		if (!callerToken || !request || typeof request !== 'object' || typeof request.op !== 'string') {
			return fail('Malformed request.') as T;
		}
		try {
			return await this.run(callerToken, request) as T;
		} catch (error) {
			this.logService.warn(`[ParadisAgentIde] ${request.op} failed`, error);
			// エージェント向けの文は英語。利用者向けに日本語の文言を持つエラーは、英文の側を返す
			if (error instanceof ParadisAgentPromptQuotingError) {
				return fail(error.agentMessage) as T;
			}
			return fail(`Para Code failed to run the operation: ${error instanceof Error ? error.message : String(error)}`) as T;
		}
	}

	async run(callerToken: string, request: ParadisAgentIdeRequest): Promise<ParadisAgentIdeResult> {
		switch (request.op) {
			case 'listSpaces': return this._listSpaces(callerToken);
			case 'listTerminals': return this._listTerminals(callerToken, request.space);
			case 'readTerminal': return this._readTerminal(callerToken, request.terminal, request.scrollbackLines);
			case 'probeTerminal': return this._probeTerminal(callerToken, request.terminal);
		}
		// ここから下は書き込み系。shared process が門番をしていても、ここでも設定を確かめる
		if (!this._setting(PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING)) {
			return fail('Agent actions are turned off in Para Code settings.');
		}
		switch (request.op) {
			case 'resolveWriteTarget': {
				const target = this._resolveWritable(callerToken, request.terminal);
				return target.ok
					? { ok: true, data: { terminal: target.value.id }, internal: { paneToken: target.value.token, status: this._status(target.value), agent: this._runsAgent(target.value), screen: this._screen(target.value.instance, 0), ...(target.value.instance.remoteAuthority ? { remote: true } : {}) } }
					: target;
			}
			case 'sendInput': return this._sendInput(callerToken, request.terminal, request.text);
			case 'sendKey': return this._sendKey(callerToken, request.terminal, request.key, request.typedText);
			case 'launchAgent': return this._launchAgent(callerToken, request);
			case 'createTerminal': return this._createTerminal(callerToken, request.space);
			case 'createSpace': return this._createSpace(callerToken, request);
			case 'closeTerminal': return this._closeTerminal(callerToken, request.terminal);
			case 'removeSpace': return this._removeSpace(callerToken, request.space);
			default:
				return fail(`Unsupported operation: ${String((request as { op?: unknown }).op)}`);
		}
	}

	// --- 設定 ----------------------------------------------------------------------------------

	private _setting(key: string): boolean {
		return paradisAgentIdeActionsAllowed(this.configurationService.getValue(key));
	}

	private _windowScope(): boolean {
		return paradisAgentIdeActionScope(this.configurationService.getValue(PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING)) === 'window';
	}

	/** 別のスペースも読めるか。読み取り専用の設定か、ウィンドウ全体へ送れる設定（送れるなら読めて当然）で開く。 */
	private _readWindowWide(): boolean {
		return this._setting(PARADIS_AGENT_IDE_READ_OTHER_SPACES_SETTING)
			|| (this._setting(PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING) && this._windowScope());
	}

	// --- 台帳 ----------------------------------------------------------------------------------

	private _loadLedger(): void {
		let stored: IStoredLedger | undefined;
		try {
			stored = JSON.parse(this.storageService.get(LEDGER_STORAGE_KEY, StorageScope.WORKSPACE, '{}')) as IStoredLedger;
		} catch {
			stored = undefined;
		}
		for (const [callerId, entry] of Object.entries(stored?.callers ?? {})) {
			this._ledgers.set(callerId, { terminals: new Set(stringArray(entry?.terminals)), spaces: new Set(stringArray(entry?.spaces)) });
		}
		for (const id of stringArray(stored?.children)) {
			this._children.add(id);
		}
	}

	private _saveLedger(): void {
		const callers: Record<string, { terminals: string[]; spaces: string[] }> = {};
		const entries = [...this._ledgers].filter(([, ledger]) => ledger.terminals.size > 0 || ledger.spaces.size > 0).slice(-MAX_LEDGER_CALLERS);
		for (const [callerId, ledger] of entries) {
			callers[callerId] = { terminals: [...ledger.terminals], spaces: [...ledger.spaces] };
		}
		this.storageService.store(LEDGER_STORAGE_KEY, JSON.stringify({ callers, children: [...this._children].slice(-MAX_LEDGER_CHILDREN) }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _ledger(callerId: string): ICallerLedger {
		let ledger = this._ledgers.get(callerId);
		if (!ledger) {
			ledger = { terminals: new Set(), spaces: new Set() };
			this._ledgers.set(callerId, ledger);
		}
		return ledger;
	}

	private _createdBy(callerToken: string): ICallerLedger | undefined {
		return this._ledgers.get(this._id(callerToken));
	}

	/** 閉じたターミナルを台帳から消す（作ったものの一覧・呼び出し元としての台帳・子の印）。 */
	private _forgetTerminal(id: string): void {
		let changed = this._ledgers.delete(id);
		changed = this._children.delete(id) || changed;
		this._launchedAt.delete(id);
		this._launchedIdle.delete(id);
		for (const ledger of this._ledgers.values()) {
			changed = ledger.terminals.delete(id) || changed;
		}
		if (changed) {
			this._saveLedger();
		}
	}

	/** 生きているペインに居ない ID を台帳から消す。 */
	private _pruneLedger(): void {
		const live = new Set(this._terminals().map(terminal => terminal.id));
		let changed = false;
		for (const [callerId, ledger] of [...this._ledgers]) {
			for (const id of [...ledger.terminals]) {
				if (!live.has(id)) {
					ledger.terminals.delete(id);
					changed = true;
				}
			}
			if (!live.has(callerId) && ledger.terminals.size === 0) {
				// 呼び出し元のペインが居なくなり、作ったターミナルも残っていない（スペースは残すと閉じられないだけ）
				this._ledgers.delete(callerId);
				changed = true;
			}
		}
		if (changed) {
			this._saveLedger();
		}
	}

	private _recordCreatedTerminal(callerToken: string, id: string, child: boolean, idleAgent = false): void {
		this._ledger(this._id(callerToken)).terminals.add(id);
		if (child) {
			this._children.add(id);
		}
		if (idleAgent) {
			this._launchedIdle.add(id);
		}
		this._launchedAt.set(id, Date.now());
		this._saveLedger();
	}

	// --- 対象の解決 ----------------------------------------------------------------------------

	private _id(token: string): string {
		let id = this._idCache.get(token);
		if (id === undefined) {
			id = paradisAgentIdeTerminalId(token);
			if (this._idCache.size > 1000) {
				this._idCache.clear();
			}
			this._idCache.set(token, id);
		}
		return id;
	}

	private _terminals(): IResolvedTerminal[] {
		return paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService)
			.map(({ instance, token }) => {
				const id = this._id(token);
				this._instanceIds.set(instance.instanceId, id);
				return { id, token, instance, space: this._spaceOf(instance.instanceId) };
			});
	}

	private _findTerminal(id: string): IResolvedTerminal | undefined {
		return this._terminals().find(candidate => candidate.id === id);
	}

	private _caller(callerToken: string): IResolvedTerminal | undefined {
		return this._terminals().find(candidate => candidate.token === callerToken);
	}

	/** 権限の判断に使う所属。記録の無いものを今のスペースで埋めない（strict）。 */
	private _spaceOf(instanceId: number): string | undefined {
		return paradisResolveInstanceSpace(this.terminalScopeService, this.workspaceSwitchService.activeStateKey, instanceId, { strict: true });
	}

	private _spaces(): IParadisSpaceEntry[] {
		return paradisListSpaces(this.workspaceSwitchService.repositories, this.worktreeService);
	}

	private _status(terminal: IResolvedTerminal): ParadisAgentIdeTerminalStatus {
		const status = paradisAgentIdeStatusLabel(this.agentStatusStore.getInstanceStatus(terminal.instance.instanceId));
		// フォルダの信頼の確認は hook が届く前に出る。利用者の答え待ちとして扱う
		return this._showsTrustDialog(terminal, status) ? 'waiting_for_permission' : status;
	}

	/**
	 * 起動直後の信頼の確認が画面に出ているか（作業中・答え待ちと分かっているときは見ない）。
	 * 画面の文字は中のプログラムが書けるので、hook の状態をまだ一度も受け取っていないペインか、
	 * エージェントのツールで起動してから猶予の間のペインでだけ見る。
	 */
	private _showsTrustDialog(terminal: IResolvedTerminal, status = paradisAgentIdeStatusLabel(this.agentStatusStore.getInstanceStatus(terminal.instance.instanceId))): boolean {
		if (status === 'working' || paradisAgentIdeNeedsHuman(status) || !this._runsAgent(terminal)) {
			return false;
		}
		const launchedAt = this._launchedAt.get(terminal.id);
		const justLaunched = launchedAt !== undefined && Date.now() - launchedAt <= PARADIS_AGENT_IDE_LAUNCH_GRACE_MS;
		if (!justLaunched && this.agentStatusStore.isAgentInstance(terminal.instance.instanceId)) {
			return false;
		}
		return paradisAgentStartupScreenState(this._screen(terminal.instance, 0)) === 'trust_dialog';
	}

	private _runsAgent(terminal: IResolvedTerminal): boolean {
		return paradisTerminalRunsAgent(terminal.instance);
	}

	/** 自分自身・自分が作ったもの・自分のスペースのもの（設定でウィンドウ全体）だけ読める。 */
	private _checkReadable(callerToken: string, target: IResolvedTerminal): string | undefined {
		if (target.token === callerToken) {
			return undefined;
		}
		const ledger = this._createdBy(callerToken);
		if (ledger && (ledger.terminals.has(target.id) || (target.space !== undefined && ledger.spaces.has(target.space)))) {
			return undefined;
		}
		if (this._readWindowWide()) {
			return undefined;
		}
		const caller = this._caller(callerToken);
		if (!caller) {
			return CALLER_UNKNOWN;
		}
		return caller.space !== undefined && target.space === caller.space ? undefined : PARADIS_AGENT_IDE_OUT_OF_READ_SCOPE_MESSAGE;
	}

	/**
	 * 入力を送ってよい相手か。自分自身には送らない。自分が作ったターミナル・スペースは
	 * 範囲の外でも送れる。それ以外は同じスペース（設定でウィンドウ全体）。
	 */
	private _checkWritable(callerToken: string, target: IResolvedTerminal): string | undefined {
		const caller = this._caller(callerToken);
		if (!caller) {
			return CALLER_UNKNOWN;
		}
		if (target.token === callerToken) {
			return 'That is your own terminal. Agents cannot send input to themselves.';
		}
		const ledger = this._createdBy(callerToken);
		if (ledger && (ledger.terminals.has(target.id) || (target.space !== undefined && ledger.spaces.has(target.space)))) {
			return undefined;
		}
		if (this._windowScope()) {
			return undefined;
		}
		if (caller.space === undefined) {
			return CALLER_NO_SPACE;
		}
		return target.space === caller.space ? undefined : OUT_OF_SCOPE;
	}

	private _resolveReadable(callerToken: string, id: string): { readonly ok: true; readonly value: IResolvedTerminal } | Failure {
		const target = this._findTerminal(id);
		if (!target) {
			return fail(UNKNOWN_TERMINAL(id));
		}
		const refusal = this._checkReadable(callerToken, target);
		return refusal === undefined ? { ok: true, value: target } : fail(refusal);
	}

	private _resolveWritable(callerToken: string, id: string): { readonly ok: true; readonly value: IResolvedTerminal } | Failure {
		const target = this._findTerminal(id);
		if (!target) {
			return fail(UNKNOWN_TERMINAL(id));
		}
		const refusal = this._checkWritable(callerToken, target);
		return refusal === undefined ? { ok: true, value: target } : fail(refusal);
	}

	/** 作成先のスペース。省略時は呼び出し元のスペース。範囲外なら断る。 */
	private _resolveTargetSpace(callerToken: string, space: string | undefined): { readonly ok: true; readonly value: IParadisSpaceEntry } | Failure {
		const caller = this._caller(callerToken);
		if (!caller) {
			return fail(CALLER_UNKNOWN);
		}
		const key = space ?? caller.space;
		if (key === undefined) {
			return fail('Para Code cannot tell which space your terminal belongs to. Pass "space" explicitly (from list_spaces).');
		}
		const entry = this._spaces().find(candidate => candidate.space === key);
		if (!entry) {
			return fail(UNKNOWN_SPACE(key));
		}
		if (key !== caller.space && !this._windowScope() && !this._createdBy(callerToken)?.spaces.has(key)) {
			return fail('That space is not yours. Agents can only open terminals in their own space and in spaces they created themselves (the user can widen this to the whole window in Para Code settings).');
		}
		return { ok: true, value: entry };
	}

	/** 子（エージェントのツールで起動したペイン）は作れない。作れる数にも上限がある。 */
	private _checkCanCreate(callerToken: string, terminals: IResolvedTerminal[]): string | undefined {
		const callerId = this._id(callerToken);
		if (this._children.has(callerId)) {
			return CHILD_CANNOT_CREATE;
		}
		const live = new Set(terminals.map(terminal => terminal.id));
		const mine = [...(this._ledgers.get(callerId)?.terminals ?? [])].filter(id => live.has(id)).length;
		if (mine >= PARADIS_AGENT_IDE_MAX_CREATED_PER_CALLER) {
			return `You already have ${mine} terminals you created open (limit: ${PARADIS_AGENT_IDE_MAX_CREATED_PER_CALLER}). Close ones you no longer need with close_terminal first.`;
		}
		const total = new Set([...this._ledgers.values()].flatMap(ledger => [...ledger.terminals]).filter(id => live.has(id))).size;
		if (total >= PARADIS_AGENT_IDE_MAX_CREATED_PER_WINDOW) {
			return `Agents already have ${total} terminals they created open in this window (limit: ${PARADIS_AGENT_IDE_MAX_CREATED_PER_WINDOW}). Ask the user to close some first.`;
		}
		return undefined;
	}

	/** 利用者への知らせに使う、呼び出し元の名乗り。タイトルはプログラムが書けるので短く均す。 */
	private _describeCaller(callerToken: string): string {
		const caller = this._caller(callerToken);
		const id = this._id(callerToken);
		return caller ? `${paradisAgentIdeUntrustedTitle(caller.instance.title)} (${id})` : id;
	}

	// --- 読み取り ------------------------------------------------------------------------------

	private _listSpaces(callerToken: string): ParadisAgentIdeResult {
		const caller = this._caller(callerToken);
		const created = this._createdBy(callerToken);
		const active = this.workspaceSwitchService.activeStateKey;
		const spaces = this._spaces().map(entry => ({
			space: entry.space,
			name: entry.name,
			kind: entry.kind,
			...(entry.kind === 'worktree' ? { repository: entry.repositoryId, branch: entry.worktree?.branch } : {}),
			...(entry.space === caller?.space ? { current: true } : {}),
			...(entry.space === active ? { on_screen: true } : {}),
			...(created?.spaces.has(entry.space) ? { created_by_you: true } : {}),
		}));
		const agents = this.modelCatalogService.getAgentTemplates().map(agent => this._describeAgent(agent));
		return { ok: true, data: { spaces, agents } };
	}

	private _describeAgent(agent: IParadisAgentCommandTemplate): object {
		return {
			id: agent.id,
			name: agent.label,
			...(agent.models && agent.models.length > 0 ? { models: agent.models.map(model => model.id) } : {}),
			...(agent.efforts && agent.efforts.length > 0 ? { efforts: agent.efforts.map(effort => effort.id) } : {}),
		};
	}

	private _listTerminals(callerToken: string, space: string | undefined): ParadisAgentIdeResult {
		const spaces = this._spaces();
		if (space !== undefined && !spaces.some(entry => entry.space === space)) {
			return fail(UNKNOWN_SPACE(space));
		}
		const names = new Map(spaces.map(entry => [entry.space, entry.name]));
		const created = this._createdBy(callerToken);
		const active = this.workspaceSwitchService.activeStateKey;
		const actionsAllowed = this._setting(PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING);
		const all = this._terminals().filter(terminal => space === undefined || terminal.space === space);
		const readable = all.filter(terminal => this._checkReadable(callerToken, terminal) === undefined);
		const terminals = readable.map(terminal => {
			const status = this._status(terminal);
			const canSend = actionsAllowed && !paradisAgentIdeNeedsHuman(status) && this._checkWritable(callerToken, terminal) === undefined;
			return {
				id: terminal.id,
				title: paradisAgentIdeUntrustedTitle(terminal.instance.title),
				space: terminal.space ?? null,
				space_name: terminal.space !== undefined ? names.get(terminal.space) ?? null : null,
				status,
				agent: this._runsAgent(terminal),
				...(terminal.token === callerToken ? { self: true } : {}),
				...(created?.terminals.has(terminal.id) ? { created_by_you: true } : {}),
				...(terminal.space !== undefined && terminal.space === active ? { on_screen: true } : {}),
				can_send: canSend,
			};
		});
		const hidden = all.length - readable.length;
		return {
			ok: true,
			data: {
				terminals,
				...(hidden > 0 ? { not_listed: `${hidden} terminal(s) in other spaces are not shown: agents can only read their own space unless the user allows more.` } : {}),
			},
		};
	}

	/** 見えている画面とその上 `extraLines` 行。折り返しでできた行は元の1行へつなぐ。 */
	private _screen(instance: ITerminalInstance, extraLines: number): string | undefined {
		const raw = instance.xterm?.raw;
		if (!raw) {
			return undefined;
		}
		const buffer = raw.buffer.active;
		const limit = raw.rows + Math.min(extraLines, PARADIS_AGENT_IDE_MAX_SCROLLBACK_LINES + PARADIS_AGENT_IDE_CONTEXT_LINES);
		// 折り返しをつなぐと行数が減るので、多めに読んでから末尾を切る
		const start = Math.max(0, buffer.length - limit * 4);
		const logical: string[] = [];
		for (let y = start; y < buffer.length; y++) {
			const line = buffer.getLine(y);
			if (!line) {
				continue;
			}
			const text = line.translateToString(true);
			if (line.isWrapped && logical.length > 0) {
				logical[logical.length - 1] += text;
			} else {
				logical.push(text);
			}
		}
		return paradisAgentIdeTailLines(logical, limit);
	}

	private _readTerminal(callerToken: string, id: string, scrollbackLines: number): ParadisAgentIdeResult {
		const resolved = this._resolveReadable(callerToken, id);
		if (!resolved.ok) {
			return resolved;
		}
		const terminal = resolved.value;
		const screen = this._screen(terminal.instance, PARADIS_AGENT_IDE_CONTEXT_LINES + scrollbackLines);
		return {
			ok: true,
			data: {
				id: terminal.id,
				title: paradisAgentIdeUntrustedTitle(terminal.instance.title),
				status: this._status(terminal),
				agent: this._runsAgent(terminal),
				text: screen ?? '',
				...(screen === undefined ? { note: 'The terminal has not drawn its screen yet (it may have just been created). Retry in a moment.' } : {}),
			},
			internal: { paneToken: terminal.token },
		};
	}

	private _probeTerminal(callerToken: string, id: string): ParadisAgentIdeResult {
		const target = this._findTerminal(id);
		if (!target) {
			// 待機を「閉じられた」として終えられるよう、失敗ではなく gone を返す
			return { ok: true, data: { id }, internal: { gone: true } };
		}
		const refusal = this._checkReadable(callerToken, target);
		if (refusal !== undefined) {
			return fail(refusal);
		}
		const launchedAt = this._launchedAt.get(target.id);
		return {
			ok: true,
			data: { id: target.id },
			internal: {
				paneToken: target.token,
				status: this._status(target),
				agent: this._runsAgent(target),
				screen: this._screen(target.instance, 0) ?? '',
				...(launchedAt !== undefined ? { launchedAt } : {}),
				...(this._launchedIdle.has(target.id) ? { launchedIdle: true } : {}),
			},
		};
	}

	// --- 送信 ----------------------------------------------------------------------------------

	/** 貼り付けだけ行う。Enter は shared process が状態を確かめ直してから `sendKey` で送る。 */
	private async _sendInput(callerToken: string, id: string, text: string): Promise<ParadisAgentIdeResult> {
		const resolved = this._resolveWritable(callerToken, id);
		if (!resolved.ok) {
			return resolved;
		}
		const target = resolved.value;
		// 信頼の確認へ文字を貼ると、数字が選択肢を選んでしまう
		if (this._showsTrustDialog(target)) {
			return fail(PARADIS_AGENT_TRUST_DIALOG_MESSAGE);
		}
		if (paradisAgentIdeNeedsHuman(this._status(target))) {
			return fail(NEEDS_HUMAN);
		}
		// 貼り付けを受け付けないプログラム（素のシェルなど）へ複数行を送ると、行ごとに実行される
		if (text.includes('\n') && !paradisCanPasteMultiline(target.instance)) {
			return fail('That terminal does not run Claude Code / Codex in the foreground, so pasted lines could run one by one as commands. Send one line at a time.');
		}
		// 受け取ったエージェントが「利用者の指示」と取り違えないよう、エージェントからだと印を付ける
		const agent = this._runsAgent(target);
		const body = agent ? `${paradisAgentIdeMessagePrefix(this._id(callerToken))}${text}` : text;
		await target.instance.sendText(body, false, true);
		this.notificationService.notify({
			severity: Severity.Info,
			priority: NotificationPriority.SILENT,
			// allow-any-unicode-next-line
			message: localize('paradis.agentIde.notify.sent', "エージェント「{0}」がターミナル「{1}」へ入力しました。", this._describeCaller(callerToken), paradisAgentIdeUntrustedTitle(target.instance.title)),
		});
		return { ok: true, data: { terminal: id, typed: true, pressed_enter: false, ...(agent ? { marked_as_agent_message: true } : {}) } };
	}

	private async _sendKey(callerToken: string, id: string, key: ParadisAgentIdeKey, typedText?: string): Promise<ParadisAgentIdeResult> {
		const resolved = this._resolveWritable(callerToken, id);
		if (!resolved.ok) {
			return resolved;
		}
		const target = resolved.value;
		// 信頼の確認では Esc も矢印も答えになる（Esc は終了を選ぶ）
		if (this._showsTrustDialog(target)) {
			return fail(PARADIS_AGENT_TRUST_DIALOG_MESSAGE);
		}
		const status = this._status(target);
		if (paradisAgentIdeNeedsHuman(status)) {
			return fail(NEEDS_HUMAN);
		}
		if (key === 'enter') {
			// 画面の確認はシェルかエージェントかによらず掛ける。読めないときは確かめられないので送らない。
			// 貼った本文が確認の文言に似ている場合の見逃しは shared process 側が扱う（こちらは Enter の直前の最後の見張り）
			const screen = this._screen(target.instance, 0);
			if (screen === undefined) {
				return fail('Para Code cannot read that terminal\'s screen right now, so it does not press Enter there. Retry in a moment.');
			}
			// Enter の直前の最後の見張り（shared process の確認から Enter までの間に出た確認を拾う）。
			// 直前に貼った本文の部分は除いて探す
			if (paradisAgentIdeScreenShowsPrompt(screen, typedText)) {
				return fail('That terminal shows a confirmation prompt on screen, so Para Code does not press Enter there. Tell the user instead.');
			}
			if (!this._runsAgent(target)) {
				if (!this._setting(PARADIS_AGENT_IDE_ALLOW_SHELL_COMMANDS_SETTING)) {
					return fail(PARADIS_AGENT_IDE_SHELL_DISABLED_MESSAGE);
				}
			} else if (status === 'working') {
				return fail('The agent in that terminal is working right now, so Para Code does not press Enter there.');
			}
		}
		const applicationMode = target.instance.xterm?.raw.modes.applicationCursorKeysMode === true;
		await target.instance.sendText(paradisAgentIdeKeySequence(key, applicationMode), false);
		// Enter（指示の送信・コマンドの実行）と中断は、利用者の目に見える形で知らせる
		if (key === 'enter' || key === 'ctrl_c') {
			this.notificationService.notify({
				severity: Severity.Info,
				message: key === 'enter'
					// allow-any-unicode-next-line
					? localize('paradis.agentIde.notify.enter', "エージェント「{0}」がターミナル「{1}」で Enter を押しました。", this._describeCaller(callerToken), paradisAgentIdeUntrustedTitle(target.instance.title))
					// allow-any-unicode-next-line
					: localize('paradis.agentIde.notify.interrupt', "エージェント「{0}」がターミナル「{1}」を中断しました（Ctrl+C）。", this._describeCaller(callerToken), paradisAgentIdeUntrustedTitle(target.instance.title)),
			});
		}
		return { ok: true, data: { terminal: id, key } };
	}

	// --- 作成 ----------------------------------------------------------------------------------

	private _findAgent(agentId: string, model: string | undefined, effort: string | undefined): { readonly ok: true; readonly value: IParadisAgentCommandTemplate } | Failure {
		const agents = this.modelCatalogService.getAgentTemplates();
		const agent = agents.find(candidate => candidate.id === agentId);
		if (!agent) {
			return fail(`Unknown agent "${agentId}". Available: ${agents.map(candidate => candidate.id).join(', ')}.`);
		}
		if (model !== undefined && !(agent.models ?? []).some(candidate => candidate.id === model)) {
			return fail(`Unknown model "${model}" for ${agent.id}. Available: ${(agent.models ?? []).map(candidate => candidate.id).join(', ') || '(none)'}.`);
		}
		if (effort !== undefined && !(agent.efforts ?? []).some(candidate => candidate.id === effort)) {
			return fail(`Unknown effort "${effort}" for ${agent.id}. Available: ${(agent.efforts ?? []).map(candidate => candidate.id).join(', ') || '(none)'}.`);
		}
		return { ok: true, value: agent };
	}

	private _notifyCreated(message: string): void {
		this.notificationService.notify({ severity: Severity.Info, message });
	}

	private async _launchAgent(callerToken: string, request: Extract<ParadisAgentIdeRequest, { op: 'launchAgent' }>): Promise<ParadisAgentIdeResult> {
		const limit = this._checkCanCreate(callerToken, this._terminals());
		if (limit !== undefined) {
			return fail(limit);
		}
		const agent = this._findAgent(request.agent, request.model, request.effort);
		if (!agent.ok) {
			return agent;
		}
		const space = this._resolveTargetSpace(callerToken, request.space);
		if (!space.ok) {
			return space;
		}
		// 権限モードは渡さない（既定のまま）。エージェントが子を「確認なし」で起動して権限を広げないため。
		// 利用者の入力を横取りしないよう、フォーカスを奪わずに開く
		const launched = await this.instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
			rootUri: space.value.uri,
			stateKey: space.value.space,
			agentId: agent.value.id,
			...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
			...(request.model !== undefined ? { modelId: request.model } : {}),
			...(request.effort !== undefined ? { effortId: request.effort } : {}),
			preserveFocus: true,
		});
		const id = launched.paneToken !== undefined ? this._id(launched.paneToken) : undefined;
		if (id !== undefined) {
			this._instanceIds.set(launched.instanceId, id);
			this._recordCreatedTerminal(callerToken, id, true, !request.prompt);
		}
		// allow-any-unicode-next-line
		this._notifyCreated(localize('paradis.agentIde.notify.launched', "エージェント「{0}」が {1} を起動しました（{2}）。", this._describeCaller(callerToken), agent.value.label, space.value.name));
		return {
			ok: true,
			data: {
				terminal: id ?? null,
				space: space.value.space,
				agent: agent.value.id,
				...(id === undefined ? { note: 'The agent was started, but Para Code could not assign an id to its terminal. Call list_terminals to find it.' } : {}),
			},
		};
	}

	private async _createTerminal(callerToken: string, space: string | undefined): Promise<ParadisAgentIdeResult> {
		// シェルを開いても、コマンドを実行する許可が無ければ使い道が無い（開くだけで断る）
		if (!this._setting(PARADIS_AGENT_IDE_ALLOW_SHELL_COMMANDS_SETTING)) {
			return fail(PARADIS_AGENT_IDE_SHELL_DISABLED_MESSAGE);
		}
		const limit = this._checkCanCreate(callerToken, this._terminals());
		if (limit !== undefined) {
			return fail(limit);
		}
		const target = this._resolveTargetSpace(callerToken, space);
		if (!target.ok) {
			return target;
		}
		const instance = await paradisOpenEditorTerminalInSpace({ terminalService: this.terminalService, terminalEditorService: this.terminalEditorService, terminalScopeService: this.terminalScopeService }, target.value.uri, target.value.space, true);
		const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
		const id = token !== undefined ? this._id(token) : undefined;
		if (id !== undefined) {
			this._instanceIds.set(instance.instanceId, id);
			this._recordCreatedTerminal(callerToken, id, true);
		}
		// allow-any-unicode-next-line
		this._notifyCreated(localize('paradis.agentIde.notify.terminal', "エージェント「{0}」がターミナルを開きました（{1}）。", this._describeCaller(callerToken), target.value.name));
		return { ok: true, data: { terminal: id ?? null, space: target.value.space } };
	}

	private async _createSpace(callerToken: string, request: Extract<ParadisAgentIdeRequest, { op: 'createSpace' }>): Promise<ParadisAgentIdeResult> {
		const caller = this._caller(callerToken);
		if (!caller) {
			return fail(CALLER_UNKNOWN);
		}
		const callerId = this._id(callerToken);
		if (this._children.has(callerId)) {
			return fail(CHILD_CANNOT_CREATE);
		}
		const spaces = this._spaces();
		const existingSpaces = new Set(spaces.map(entry => entry.space));
		const mySpaces = [...(this._ledgers.get(callerId)?.spaces ?? [])].filter(space => existingSpaces.has(space)).length;
		if (mySpaces >= PARADIS_AGENT_IDE_MAX_SPACES_PER_CALLER) {
			return fail(`You already created ${mySpaces} spaces that still exist (limit: ${PARADIS_AGENT_IDE_MAX_SPACES_PER_CALLER}). Ask the user to remove ones that are done (remove_space).`);
		}
		if (request.agent !== undefined) {
			const limit = this._checkCanCreate(callerToken, this._terminals());
			if (limit !== undefined) {
				return fail(limit);
			}
		}
		if (request.runSetup === true && !this._setting(PARADIS_AGENT_IDE_ALLOW_SHELL_COMMANDS_SETTING)) {
			return fail(`run_setup=true runs the repository's setup script outside your sandbox. ${PARADIS_AGENT_IDE_SHELL_DISABLED_MESSAGE}`);
		}
		const callerRepository = spaces.find(entry => entry.space === caller.space)?.repositoryId;
		const repositoryId = request.repository ?? callerRepository;
		if (repositoryId === undefined) {
			return fail('Para Code cannot tell which repository your terminal belongs to. Pass "repository" (a space key of kind "repository" from list_spaces).');
		}
		const repository = this.workspaceSwitchService.repositories.find(candidate => candidate.id === repositoryId);
		if (!repository) {
			return fail(`Unknown repository "${repositoryId}". Pass a space key of kind "repository" from list_spaces.`);
		}
		if (repositoryId !== callerRepository && !this._windowScope()) {
			return fail('Agents can only create spaces in the repository of their own space (the user can widen this to the whole window in Para Code settings).');
		}
		let agentLabel: string | undefined;
		if (request.agent !== undefined) {
			const agent = this._findAgent(request.agent, request.model, request.effort);
			if (!agent.ok) {
				return agent;
			}
			agentLabel = agent.value.label;
		}
		const runSetup = request.runSetup === true;
		const result = await this._createSequencer.queue(() => this.instantiationService.invokeFunction(paradisRunWorktreeCreateFlow, {
			repositoryId,
			...(request.name !== undefined ? { name: request.name } : {}),
			...(request.branch !== undefined ? { branch: request.branch } : {}),
			...(request.baseBranch !== undefined ? { baseRef: request.baseBranch } : {}),
			...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
			agentId: request.agent ?? 'none',
			...(request.model !== undefined ? { modelId: request.model } : {}),
			...(request.effort !== undefined ? { effortId: request.effort } : {}),
			runSetup,
		}, { switchToCreated: false, preserveFocus: true, runAutoRunPresets: runSetup }));
		// 呼び出しが時間切れになっていても、作ったことは台帳に残す（後から閉じる・削除できるように）
		const space = paradisWorktreeStateKey(result.worktree.uri);
		this._ledger(callerId).spaces.add(space);
		const agentTerminal = result.agent?.paneToken !== undefined ? this._id(result.agent.paneToken) : undefined;
		if (agentTerminal !== undefined && result.agent) {
			this._instanceIds.set(result.agent.instanceId, agentTerminal);
			this._recordCreatedTerminal(callerToken, agentTerminal, true, !request.prompt);
		} else {
			this._saveLedger();
		}
		this._notifyCreated(agentLabel !== undefined
			// allow-any-unicode-next-line
			? localize('paradis.agentIde.notify.spaceWithAgent', "エージェント「{0}」がスペース「{1}」を作り、{2} を起動しました。", this._describeCaller(callerToken), result.name, agentLabel)
			// allow-any-unicode-next-line
			: localize('paradis.agentIde.notify.space', "エージェント「{0}」がスペース「{1}」を作りました。", this._describeCaller(callerToken), result.name));
		return {
			ok: true,
			data: {
				space,
				name: result.name,
				branch: result.branch,
				...(agentTerminal !== undefined ? { agent_terminal: agentTerminal } : {}),
				...(result.warning !== undefined ? { warning: `The worktree was created, but a later step failed: ${result.warning}` } : {}),
			},
		};
	}

	// --- 閉じる・削除 -------------------------------------------------------------------------

	private async _closeTerminal(callerToken: string, id: string): Promise<ParadisAgentIdeResult> {
		if (!this._createdBy(callerToken)?.terminals.has(id)) {
			return fail('You can only close terminals that you created with launch_agent, create_terminal or create_space.');
		}
		const terminal = this._findTerminal(id);
		if (!terminal) {
			this._forgetTerminal(id);
			return { ok: true, data: { terminal: id, closed: true, note: 'It was already closed.' } };
		}
		if (this.terminalService.instances.includes(terminal.instance)) {
			await this.terminalService.safeDisposeTerminal(terminal.instance);
		} else {
			// 別のスペースへ退避（park）中のものは一覧に居ないので、直接閉じる
			terminal.instance.dispose(TerminalExitReason.User);
		}
		this._forgetTerminal(id);
		return { ok: true, data: { terminal: id, closed: true } };
	}

	private _removeSpace(callerToken: string, space: string): ParadisAgentIdeResult {
		if (!this._createdBy(callerToken)?.spaces.has(space)) {
			return fail('You can only ask to remove spaces that you created with create_space.');
		}
		const entry = this._spaces().find(candidate => candidate.space === space);
		if (!entry?.worktree) {
			return fail(UNKNOWN_SPACE(space));
		}
		if (this._pendingRemoval) {
			return fail('Para Code is already asking the user about another removal. Wait until they answer.');
		}
		// 削除は利用者の確認ダイアログを通す（エージェントからの依頼だと出し、未コミットの変更の強制削除も
		// 利用者が決める）。ダイアログを待つとツールの呼び出しが時間切れになるので、出したところで返す
		this._pendingRemoval = true;
		this.commandService.executeCommand(PARADIS_REMOVE_WORKTREE_COMMAND_ID, entry.worktree, { requestedByAgent: this._describeCaller(callerToken) })
			.catch(error => this.logService.warn('[ParadisAgentIde] remove worktree failed', error))
			.finally(() => { this._pendingRemoval = false; });
		return { ok: true, data: { space, requested: true, note: 'Para Code asked the user to confirm the deletion. It is deleted only if they agree; call list_spaces later to see the result.' } };
	}
}
