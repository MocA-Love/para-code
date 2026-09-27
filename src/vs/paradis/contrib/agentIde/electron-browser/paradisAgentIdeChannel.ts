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
//  - 範囲: 読み取りはウィンドウ全体。送信は同じスペース（設定で同じウィンドウ全体）と、
//    呼び出し元が作ったターミナル・スペースだけ。閉じる・削除は呼び出し元が作ったものだけ
//  - 「誰が作ったか」の台帳。このウィンドウが生きている間だけ持つ（再読み込みで消えると
//    閉じる・削除ができなくなるだけで、安全側に倒れる）
//
// 設定（送信・作成の可否）は shared process でも見ているが、ここでも見る（どちらか片方の
// 取りこぼしで送らないように）。

import { Sequencer } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { ACTIVE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisCollectLivePaneInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import {
	IParadisAgentStatusStore,
	IParadisTerminalScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktree,
	IParadisWorktreeService,
	PARADIS_UNATTRIBUTED_TERMINAL_SCOPE,
	paradisWorktreeStateKey,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentCommandTemplate } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisLaunchAgentInWorkspace, paradisRunWorktreeCreateFlow } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { paradisSendTextToTerminal } from '../browser/paradisAgentIdeTerminalInput.js';
import {
	PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING,
	PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING,
	PARADIS_AGENT_IDE_MAX_READ_LINES,
	PARADIS_AGENT_IDE_METHOD,
	ParadisAgentIdeRequest,
	ParadisAgentIdeResult,
	ParadisAgentIdeTerminalStatus,
	paradisAgentIdeActionScope,
	paradisAgentIdeActionsAllowed,
	paradisAgentIdeKeySequence,
	paradisAgentIdeNeedsHuman,
	paradisAgentIdeStatusLabel,
	paradisAgentIdeTailLines,
} from '../common/paradisAgentIde.js';

/** Workspaces ビューの「ワークツリーを削除」（確認ダイアログつき）。contribution を import すると登録の副作用が走るので ID を直書きする。 */
const REMOVE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.removeWorktree';

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
	/** 所属スペース。共通ターミナル・所属が未確定のものは undefined。 */
	readonly space: string | undefined;
}

interface ISpaceEntry {
	readonly space: string;
	readonly name: string;
	readonly kind: 'repository' | 'worktree';
	readonly repositoryId: string;
	readonly uri: URI;
	readonly worktree?: IParadisWorktree;
}

interface ICallerLedger {
	readonly terminals: Set<string>;
	readonly spaces: Set<string>;
}

type Failure = { readonly ok: false; readonly error: string };

function fail(error: string): Failure {
	return { ok: false, error };
}

const UNKNOWN_TERMINAL = (id: string) => `There is no terminal with id "${id}" in this Para Code window (it may have been closed). Call list_terminals for the current ids.`;
const UNKNOWN_SPACE = (space: string) => `Unknown space "${space}". Call list_spaces for the space keys.`;
const CALLER_UNKNOWN = 'Para Code cannot find your own terminal in this window yet (it may still be restoring). Retry in a few seconds.';
const OUT_OF_SCOPE = 'That terminal is in a different space from yours. Agents can only send input to terminals in their own space and to terminals and spaces they created themselves (the user can widen this to the whole window in Para Code settings).';
const CALLER_NO_SPACE = 'Para Code cannot tell which space your terminal belongs to (it may be the shared panel terminal or still restoring), so it only lets you reach terminals and spaces you created yourself.';
const NEEDS_HUMAN = 'That terminal is waiting for the user to answer a permission request or a question, so Para Code does not send anything to it. Tell the user instead.';

export class ParadisAgentIdeChannel implements IServerChannel {

	private readonly _ledgers = new Map<string, ICallerLedger>();
	private readonly _idCache = new Map<string, string>();
	/** worktree の作成は同じリポジトリで重なると名前の重複回避がずれるので、1本ずつ流す。 */
	private readonly _createSequencer = new Sequencer();

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
		@ILogService private readonly logService: ILogService,
	) { }

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
			return fail(`Para Code failed to run the operation: ${error instanceof Error ? error.message : String(error)}`) as T;
		}
	}

	async run(callerToken: string, request: ParadisAgentIdeRequest): Promise<ParadisAgentIdeResult> {
		switch (request.op) {
			case 'listSpaces': return this._listSpaces(callerToken);
			case 'listTerminals': return this._listTerminals(callerToken, request.space);
			case 'readTerminal': return this._readTerminal(request.terminal, request.lines);
			case 'probeTerminal': return this._probeTerminal(request.terminal, request.lines);
		}
		// ここから下は書き込み系。shared process が門番をしていても、ここでも設定を確かめる
		if (!this._actionsAllowed()) {
			return fail('Agent actions are turned off in Para Code settings.');
		}
		switch (request.op) {
			case 'resolveWriteTarget': {
				const target = this._resolveWritable(callerToken, request.terminal);
				return target.ok ? { ok: true, data: { terminal: target.value.id }, internal: { paneToken: target.value.token, status: this._status(target.value) } } : target;
			}
			case 'sendInput': return this._sendInput(callerToken, request.terminal, request.text, request.pressEnter);
			case 'sendKey': return this._sendKey(callerToken, request.terminal, request.key);
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

	private _actionsAllowed(): boolean {
		return paradisAgentIdeActionsAllowed(this.configurationService.getValue(PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING));
	}

	private _windowScope(): boolean {
		return paradisAgentIdeActionScope(this.configurationService.getValue(PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING)) === 'window';
	}

	// --- 台帳 ----------------------------------------------------------------------------------

	private _ledger(callerToken: string): ICallerLedger {
		let ledger = this._ledgers.get(callerToken);
		if (!ledger) {
			ledger = { terminals: new Set(), spaces: new Set() };
			this._ledgers.set(callerToken, ledger);
		}
		return ledger;
	}

	private _createdBy(callerToken: string): ICallerLedger | undefined {
		return this._ledgers.get(callerToken);
	}

	// --- 対象の解決 ----------------------------------------------------------------------------

	private _id(token: string): string {
		let id = this._idCache.get(token);
		if (id === undefined) {
			id = paradisAgentIdeTerminalId(token);
			this._idCache.set(token, id);
		}
		return id;
	}

	private _terminals(): IResolvedTerminal[] {
		return paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService)
			.map(({ instance, token }) => ({ id: this._id(token), token, instance, space: this._spaceOf(instance.instanceId) }));
	}

	private _findTerminal(id: string): IResolvedTerminal | undefined {
		return this._terminals().find(candidate => candidate.id === id);
	}

	private _caller(callerToken: string): IResolvedTerminal | undefined {
		return this._terminals().find(candidate => candidate.token === callerToken);
	}

	/**
	 * インスタンスの所属スペース。台帳の記録を優先し、無ければ確定したスコープだけを見る。
	 * 切り替え中などの未確定（pending）を今のスペースで埋めると、別スペースへ送れてしまうので埋めない。
	 */
	private _spaceOf(instanceId: number): string | undefined {
		if (this.terminalScopeService.isSharedPanelTerminal?.(instanceId)) {
			return undefined;
		}
		const recorded = this.terminalScopeService.getStateKeyForInstance(instanceId);
		if (recorded !== undefined) {
			return recorded === PARADIS_UNATTRIBUTED_TERMINAL_SCOPE ? undefined : recorded;
		}
		const scope = this.terminalScopeService.resolveScope(instanceId);
		return scope.kind === 'managed'
			? scope.stateKey
			: scope.kind === 'unscoped'
				? this.workspaceSwitchService.activeStateKey
				: undefined;
	}

	private _spaces(): ISpaceEntry[] {
		const entries: ISpaceEntry[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			entries.push({ space: repository.id, name: repository.name, kind: 'repository', repositoryId: repository.id, uri: repository.uri });
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (worktree.missing || worktree.isMainCheckout) {
					continue;
				}
				entries.push({
					space: paradisWorktreeStateKey(worktree.uri),
					name: `${repository.name} / ${worktree.name}`,
					kind: 'worktree',
					repositoryId: repository.id,
					uri: worktree.uri,
					worktree,
				});
			}
		}
		return entries;
	}

	private _status(terminal: IResolvedTerminal): ParadisAgentIdeTerminalStatus {
		return paradisAgentIdeStatusLabel(this.agentStatusStore.getInstanceStatus(terminal.instance.instanceId));
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

	private _resolveWritable(callerToken: string, id: string): { readonly ok: true; readonly value: IResolvedTerminal } | Failure {
		const target = this._findTerminal(id);
		if (!target) {
			return fail(UNKNOWN_TERMINAL(id));
		}
		const refusal = this._checkWritable(callerToken, target);
		return refusal === undefined ? { ok: true, value: target } : fail(refusal);
	}

	/** 作成先のスペース。省略時は呼び出し元のスペース。範囲外なら断る。 */
	private _resolveTargetSpace(callerToken: string, space: string | undefined): { readonly ok: true; readonly value: ISpaceEntry } | Failure {
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
		const actionsAllowed = this._actionsAllowed();
		const terminals = this._terminals()
			.filter(terminal => space === undefined || terminal.space === space)
			.map(terminal => {
				const status = this._status(terminal);
				const canSend = actionsAllowed && !paradisAgentIdeNeedsHuman(status) && this._checkWritable(callerToken, terminal) === undefined;
				return {
					id: terminal.id,
					title: terminal.instance.title,
					space: terminal.space ?? null,
					space_name: terminal.space !== undefined ? names.get(terminal.space) ?? null : 'shared panel terminal',
					status,
					agent_detected: this.agentStatusStore.isAgentInstance(terminal.instance.instanceId),
					...(terminal.token === callerToken ? { self: true } : {}),
					...(created?.terminals.has(terminal.id) ? { created_by_you: true } : {}),
					...(terminal.space !== undefined && terminal.space === active ? { on_screen: true } : {}),
					can_send: canSend,
				};
			});
		return { ok: true, data: { terminals } };
	}

	/** 画面の末尾 `lines` 行。折り返しでできた行は元の1行へつなぐ。 */
	private _screen(instance: ITerminalInstance, lines: number): string | undefined {
		const raw = instance.xterm?.raw;
		if (!raw) {
			return undefined;
		}
		const buffer = raw.buffer.active;
		const limit = Math.min(lines, PARADIS_AGENT_IDE_MAX_READ_LINES);
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

	private _readTerminal(id: string, lines: number): ParadisAgentIdeResult {
		const terminal = this._findTerminal(id);
		if (!terminal) {
			return fail(UNKNOWN_TERMINAL(id));
		}
		const screen = this._screen(terminal.instance, lines);
		return {
			ok: true,
			data: {
				id: terminal.id,
				title: terminal.instance.title,
				status: this._status(terminal),
				text: screen ?? '',
				...(screen === undefined ? { note: 'The terminal has not drawn its screen yet (it may have just been created). Retry in a moment.' } : {}),
			},
			internal: { paneToken: terminal.token },
		};
	}

	private _probeTerminal(id: string, lines: number): ParadisAgentIdeResult {
		const terminal = this._findTerminal(id);
		if (!terminal) {
			return fail(UNKNOWN_TERMINAL(id));
		}
		return {
			ok: true,
			data: { id: terminal.id },
			internal: { paneToken: terminal.token, status: this._status(terminal), screen: this._screen(terminal.instance, lines) ?? '' },
		};
	}

	// --- 送信 ----------------------------------------------------------------------------------

	private async _sendInput(callerToken: string, id: string, text: string, pressEnter: boolean): Promise<ParadisAgentIdeResult> {
		const resolved = this._resolveWritable(callerToken, id);
		if (!resolved.ok) {
			return resolved;
		}
		const target = resolved.value;
		if (paradisAgentIdeNeedsHuman(this._status(target))) {
			return fail(NEEDS_HUMAN);
		}
		const stillValid = async () => {
			const current = this._findTerminal(id);
			return current?.instance === target.instance && this._checkWritable(callerToken, current) === undefined && !paradisAgentIdeNeedsHuman(this._status(current));
		};
		const outcome = await paradisSendTextToTerminal(target.instance, text, pressEnter, stillValid);
		switch (outcome.kind) {
			case 'sent':
				return { ok: true, data: { terminal: id, typed: text.length > 0, pressed_enter: outcome.pressedEnter } };
			case 'multilineRefused':
				return fail('That terminal does not accept pasted multi-line text right now (for example a plain shell prompt), so each line would run as its own command. Send one line at a time.');
			case 'typedButNotSubmitted':
				return fail('The text was typed, but the terminal started waiting for the user before Enter was pressed, so Enter was not sent.');
			case 'invalidBeforeSend':
				return fail(NEEDS_HUMAN);
		}
	}

	private async _sendKey(callerToken: string, id: string, key: Parameters<typeof paradisAgentIdeKeySequence>[0]): Promise<ParadisAgentIdeResult> {
		const resolved = this._resolveWritable(callerToken, id);
		if (!resolved.ok) {
			return resolved;
		}
		const target = resolved.value;
		if (paradisAgentIdeNeedsHuman(this._status(target))) {
			return fail(NEEDS_HUMAN);
		}
		const applicationMode = target.instance.xterm?.raw.modes.applicationCursorKeysMode === true;
		await target.instance.sendText(paradisAgentIdeKeySequence(key, applicationMode), false);
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

	private async _launchAgent(callerToken: string, request: Extract<ParadisAgentIdeRequest, { op: 'launchAgent' }>): Promise<ParadisAgentIdeResult> {
		const agent = this._findAgent(request.agent, request.model, request.effort);
		if (!agent.ok) {
			return agent;
		}
		const space = this._resolveTargetSpace(callerToken, request.space);
		if (!space.ok) {
			return space;
		}
		// 権限モードは渡さない（既定のまま）。エージェントが子を「確認なし」で起動して権限を広げないため
		const launched = await this.instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
			rootUri: space.value.uri,
			stateKey: space.value.space,
			agentId: agent.value.id,
			...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
			...(request.model !== undefined ? { modelId: request.model } : {}),
			...(request.effort !== undefined ? { effortId: request.effort } : {}),
		});
		const id = launched.paneToken !== undefined ? this._id(launched.paneToken) : undefined;
		if (id !== undefined) {
			this._ledger(callerToken).terminals.add(id);
		}
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
		const target = this._resolveTargetSpace(callerToken, space);
		if (!target.ok) {
			return target;
		}
		// 利用者が別のターミナルで入力している最中でもフォーカスを奪わない
		const instance = await this.terminalService.createTerminal({
			cwd: target.value.uri,
			location: { viewColumn: ACTIVE_GROUP, preserveFocus: true },
		});
		// park は persistentProcessId の確定とエディタを開き切ることが前提（paradisResumeAgentInWorkspace と同じ順）
		await instance.processReady;
		await this.terminalEditorService.openEditor(instance, { viewColumn: ACTIVE_GROUP, preserveFocus: true });
		this.terminalScopeService.assignInstanceScope(instance.instanceId, target.value.space);
		const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
		const id = token !== undefined ? this._id(token) : undefined;
		if (id !== undefined) {
			this._ledger(callerToken).terminals.add(id);
		}
		return { ok: true, data: { terminal: id ?? null, space: target.value.space } };
	}

	private async _createSpace(callerToken: string, request: Extract<ParadisAgentIdeRequest, { op: 'createSpace' }>): Promise<ParadisAgentIdeResult> {
		const caller = this._caller(callerToken);
		if (!caller) {
			return fail(CALLER_UNKNOWN);
		}
		const spaces = this._spaces();
		const callerRepository = spaces.find(entry => entry.space === caller.space)?.repositoryId;
		const repositoryId = request.repository ?? callerRepository;
		if (repositoryId === undefined) {
			return fail('Para Code cannot tell which repository your terminal belongs to. Pass "repository" (a space key of kind "repository" from list_spaces).');
		}
		if (!this.workspaceSwitchService.repositories.some(repository => repository.id === repositoryId)) {
			return fail(`Unknown repository "${repositoryId}". Pass a space key of kind "repository" from list_spaces.`);
		}
		if (repositoryId !== callerRepository && !this._windowScope()) {
			return fail('Agents can only create spaces in the repository of their own space (the user can widen this to the whole window in Para Code settings).');
		}
		if (request.agent !== undefined) {
			const agent = this._findAgent(request.agent, request.model, request.effort);
			if (!agent.ok) {
				return agent;
			}
		}
		const result = await this._createSequencer.queue(() => this.instantiationService.invokeFunction(paradisRunWorktreeCreateFlow, {
			repositoryId,
			...(request.name !== undefined ? { name: request.name } : {}),
			...(request.branch !== undefined ? { branch: request.branch } : {}),
			...(request.baseBranch !== undefined ? { baseRef: request.baseBranch } : {}),
			...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
			agentId: request.agent ?? 'none',
			...(request.model !== undefined ? { modelId: request.model } : {}),
			...(request.effort !== undefined ? { effortId: request.effort } : {}),
			...(request.runSetup !== undefined ? { runSetup: request.runSetup } : {}),
		}, { switchToCreated: false }));
		// 呼び出しが時間切れになっていても、作ったことは台帳に残す（後から閉じる・削除できるように）
		const ledger = this._ledger(callerToken);
		const space = paradisWorktreeStateKey(result.worktree.uri);
		ledger.spaces.add(space);
		const agentTerminal = result.agent?.paneToken !== undefined ? this._id(result.agent.paneToken) : undefined;
		if (agentTerminal !== undefined) {
			ledger.terminals.add(agentTerminal);
		}
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
			this._createdBy(callerToken)?.terminals.delete(id);
			return { ok: true, data: { terminal: id, closed: true, note: 'It was already closed.' } };
		}
		if (this.terminalService.instances.includes(terminal.instance)) {
			await this.terminalService.safeDisposeTerminal(terminal.instance);
		} else {
			// 別のスペースへ退避（park）中のものは一覧に居ないので、直接閉じる
			terminal.instance.dispose(TerminalExitReason.User);
		}
		this._createdBy(callerToken)?.terminals.delete(id);
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
		// 削除は利用者の確認ダイアログを通す（未コミットの変更の強制削除も利用者が決める）。
		// ダイアログを待つとツールの呼び出しが時間切れになるので、出したところで返す
		this.commandService.executeCommand(REMOVE_WORKTREE_COMMAND_ID, entry.worktree).catch(error => this.logService.warn('[ParadisAgentIde] remove worktree failed', error));
		return { ok: true, data: { space, requested: true, note: 'Para Code asked the user to confirm the deletion. It is deleted only if they agree; call list_spaces later to see the result.' } };
	}
}
