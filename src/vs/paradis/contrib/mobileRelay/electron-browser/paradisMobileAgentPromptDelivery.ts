/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { raceTimeout } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisCollectAllTerminalInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { paradisStripTerminalControlCharacters } from '../../../common/paradisTerminalControlCharacters.js';
import { paradisCanPasteMultiline } from '../../agentIde/browser/paradisAgentIdeTerminalInput.js';
import { paradisScreenShowsAgentPrompt, paradisVisibleTerminalText } from '../../agentChat/browser/paradisAgentTuiInput.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisAgentPromptQuotingError } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisConfiguredAgents, paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { IParadisTerminalIdentityService } from '../browser/paradisTerminalIdentityService.js';
import { paradisSendAgentMessageToTui } from '../common/paradisAgentMessageSender.js';
import { paradisResolveMobileTerminalStateKey } from '../common/paradisMobileRelay.js';

/**
 * スマホから頼まれた依頼文を、そのスペースのエージェントへ届ける（Orca W2-28 の差分レビューのメモの送信から
 * 切り出したもの。W2-15 のコミットの失敗と W2-36 の CI の失敗も同じ道を通る）。
 *
 * 依頼文は PC が組み立てたものだけを渡すこと（スマホから届いた文章をそのまま打ち込まない）。ここでも
 * 改行以外の制御文字を落とす（`ESC [201~` で貼り付けの囲みを抜けられるため）。
 */

/** エージェントのターミナルへ送ってよいか。 */
export type ParadisReviewNotesTargetVerdict = 'ready' | 'not-agent' | 'busy' | 'parked' | 'not-running';

/**
 * 既にあるターミナルへ依頼文を貼り付けてよいかの判定。**貼り付けた後に Enter を送る**ので、エージェントが
 * 抜けてシェル（や ssh・python など別のプログラム）に戻っていると、依頼文がそのプログラムへの入力として
 * 実行される。複数行の貼り付けの判定はエージェント向けの IDE 操作ツールと同じ `paradisCanPasteMultiline`
 * （貼り付けの囲みが有効で、シェル統合で前面のコマンドが Claude Code / Codex と確かめられたときだけ）を使う。
 * 確かめられないターミナルには送らない（新しいエージェントを起動してもらう）。
 */
export function paradisReviewNotesTargetVerdict(input: {
	/** そのスペースのターミナルで、エージェントが動いた実績がある。 */
	readonly isAgent: boolean;
	readonly status: ParadisAgentStatus | undefined;
	/** PC の画面から外れていて（park 中）、画面の中身を読めない。 */
	readonly parked: boolean;
	/** 複数行を貼り付けてよい（`paradisCanPasteMultiline`）。 */
	readonly canPasteMultiline: boolean;
	/** 画面に許可の確認や質問の選択肢が出ている（Enter が選択肢を確定してしまう）。 */
	readonly screenShowsPrompt: boolean;
}): ParadisReviewNotesTargetVerdict {
	if (!input.isAgent) {
		return 'not-agent';
	}
	if (input.parked) {
		return 'parked';
	}
	if (input.status === 'working' || input.status === 'permission' || input.status === 'question' || input.screenShowsPrompt) {
		return 'busy';
	}
	return input.canPasteMultiline ? 'ready' : 'not-running';
}

const TARGET_ERRORS: Record<Exclude<ParadisReviewNotesTargetVerdict, 'ready'>, string> = {
	'not-agent': 'このターミナルではエージェントが動いていません。',
	'busy': 'エージェントが作業中か、確認を待っています。終わってから送ってください。',
	'parked': 'このターミナルは PC の画面に出ていないため、エージェントの状態を確かめられません。新しいエージェントで送ってください。',
	'not-running': 'このターミナルでエージェントが入力を待っていることを確かめられません。新しいエージェントで送ってください。',
};

/** 新しいエージェントの起動を待つ上限。 */
const LAUNCH_TIMEOUT_MS = 45_000;

/** 送り先。 */
export type ParadisAgentPromptTarget =
	| { readonly kind: 'terminal'; readonly terminalKey: string }
	| { readonly kind: 'launch'; readonly agent: string }
	/** そのスペースで入力を待っているエージェントへ。エージェントがいなければ既定のエージェントを起動（Q114 A / Q15-2）。 */
	| { readonly kind: 'auto' }
	/** 既定のエージェントを新しく起動する。 */
	| { readonly kind: 'new' };

/**
 * スマホから届いた送り先を読む。`{ terminalKey }` / `{ agent }` は W2-28 の形、`'auto'` / `'new'` は W2-15 / W2-36 の形。
 * `allowNamed` が false なら文字列の2つだけを受ける。
 */
export function paradisParseAgentPromptTarget(raw: unknown, allowNamed = true): ParadisAgentPromptTarget | undefined {
	if (raw === 'auto') {
		return { kind: 'auto' };
	}
	if (raw === 'new') {
		return { kind: 'new' };
	}
	if (!allowNamed || typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const value = raw as { readonly terminalKey?: unknown; readonly agent?: unknown };
	const terminalKey = typeof value.terminalKey === 'string' && value.terminalKey.length > 0 && value.terminalKey.length <= 200 ? value.terminalKey : undefined;
	const agent = typeof value.agent === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.agent) ? value.agent : undefined;
	return terminalKey !== undefined && agent === undefined ? { kind: 'terminal', terminalKey }
		: agent !== undefined && terminalKey === undefined ? { kind: 'launch', agent }
			: undefined;
}

/** 送るのに使うサービス（要求の処理の同期的な先頭で {@link paradisAgentPromptServices} で取り出す）。 */
export interface IParadisAgentPromptServices {
	readonly terminalService: ITerminalService;
	readonly terminalGroupService: ITerminalGroupService;
	readonly identityService: IParadisTerminalIdentityService;
	readonly scopeService: IParadisTerminalScopeService;
	readonly switchService: IParadisWorkspaceSwitchService;
	readonly agentStatusStore: IParadisAgentStatusStore;
	readonly instantiationService: IInstantiationService;
	readonly configurationService: IConfigurationService;
	readonly modelCatalogService: IParadisAgentModelCatalogService;
}

/** `accessor` は await の前でしか使えないので、処理の先頭で呼ぶ。 */
export function paradisAgentPromptServices(accessor: ServicesAccessor): IParadisAgentPromptServices {
	return {
		terminalService: accessor.get(ITerminalService),
		terminalGroupService: accessor.get(ITerminalGroupService),
		identityService: accessor.get(IParadisTerminalIdentityService),
		scopeService: accessor.get(IParadisTerminalScopeService),
		switchService: accessor.get(IParadisWorkspaceSwitchService),
		agentStatusStore: accessor.get(IParadisAgentStatusStore),
		instantiationService: accessor.get(IInstantiationService),
		configurationService: accessor.get(IConfigurationService),
		modelCatalogService: accessor.get(IParadisAgentModelCatalogService),
	};
}

/** 届けた結果。失敗の `error` はアプリがそのまま出す一文、`code` は判定用。 */
export type ParadisAgentPromptOutcome =
	| { readonly ok: true; readonly via: 'terminal' | 'launch'; readonly title?: string }
	| { readonly ok: false; readonly error: string; readonly code: string; readonly consumed?: boolean };

function isInSpaceAgent(services: IParadisAgentPromptServices, instance: ITerminalInstance, ws: string): boolean {
	const stateKey = paradisResolveMobileTerminalStateKey(services.scopeService.getStateKeyForInstance(instance.instanceId), services.scopeService.resolveScope(instance.instanceId), services.switchService.activeStateKey);
	return stateKey === ws && services.agentStatusStore.isAgentInstance(instance.instanceId);
}

function verdictOf(services: IParadisAgentPromptServices, instance: ITerminalInstance | undefined, ws: string): ParadisReviewNotesTargetVerdict {
	if (instance === undefined || instance.isDisposed) {
		return 'not-agent';
	}
	return paradisReviewNotesTargetVerdict({
		isAgent: isInSpaceAgent(services, instance, ws),
		status: services.agentStatusStore.getInstanceStatus(instance.instanceId),
		parked: instance.xterm === undefined,
		canPasteMultiline: paradisCanPasteMultiline(instance),
		screenShowsPrompt: paradisScreenShowsAgentPrompt(paradisVisibleTerminalText(instance)),
	});
}

/**
 * 既定のエージェント（設定 `paradis.workspaceSwitch.defaultAgent`。空・「実行しない」・一覧に無いなら
 * 一覧の先頭）。一覧が空なら undefined。
 */
export function paradisDefaultMobileAgentId(configured: string | undefined, agentIds: readonly string[]): string | undefined {
	const value = (configured ?? '').trim();
	return value.length > 0 && value !== 'none' && agentIds.includes(value) ? value : agentIds[0];
}

async function sendToInstance(services: IParadisAgentPromptServices, instance: ITerminalInstance, ws: string, prompt: string, find: () => ITerminalInstance | undefined): Promise<ParadisAgentPromptOutcome> {
	// 貼り付けの前と Enter の前に、同じ判定で同じターミナルがまだ受け取れる状態かを確かめ直す
	const outcome = await paradisSendAgentMessageToTui(
		prompt,
		(text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode),
		async () => find() === instance && verdictOf(services, instance, ws) === 'ready',
	);
	if (!outcome.executed) {
		return { ok: false, error: outcome.consumed ? '貼り付けた後にエージェントの状態が変わったため、送信の確定をしませんでした。PC で確かめてください。' : '送る直前にエージェントの状態が変わりました。', code: 'changed', consumed: outcome.consumed };
	}
	return { ok: true, via: 'terminal', title: instance.title };
}

async function launch(services: IParadisAgentPromptServices, ws: string, root: URI, prompt: string, agentId: string, pushState: () => void): Promise<ParadisAgentPromptOutcome> {
	try {
		// 利用者が PC で作業している最中に前へ出さない（エージェントの IDE 操作や定期実行と同じ扱い）
		const launched = services.instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, { rootUri: root, stateKey: ws, agentId, prompt, preserveFocus: true });
		// 起動が返ってこなくても送信中の印が外れるよう、待つ時間に上限を付ける（後から失敗しても未処理の例外にしない）
		launched.catch(() => undefined);
		if (await raceTimeout(launched.then(() => true), LAUNCH_TIMEOUT_MS) !== true) {
			return { ok: false, error: 'エージェントの起動に時間がかかっています。起動したかを PC で確かめてください（未送信のまま残しています）。', code: 'timeout' };
		}
	} catch (error) {
		if (error instanceof ParadisAgentPromptQuotingError) {
			return { ok: false, error: '依頼文にバックスラッシュ（\\）が含まれていて、PC のシェルの種類が分からないため、新しいエージェントへは安全に渡せません。動いているエージェントへ送るか、PC で起動してください。', code: 'quoting' };
		}
		throw error;
	}
	// 新しいターミナルをすぐスマホの送り先・一覧に出す
	pushState();
	return { ok: true, via: 'launch' };
}

/**
 * 依頼文を送り先へ届ける。依頼文の改行以外の制御文字はここで落とす。
 * - `terminal`: そのターミナルが「そのスペースのエージェント」で入力を待っているときだけ
 * - `launch`: 指定のエージェントを新しく起動して、起動のコマンドに依頼文を渡す
 * - `auto`: そのスペースで入力を待っているエージェントがいればそこへ。エージェントのターミナルはあるが
 *   どれも受け取れない（作業中・確かめられない）なら送らずに `busy` を返す（黙って別のエージェントを増やさない）。
 *   エージェントのターミナルが無ければ既定のエージェントを起動する
 * - `new`: 既定のエージェントを新しく起動する
 */
export async function paradisDeliverAgentPrompt(services: IParadisAgentPromptServices, ws: string, root: URI, rawPrompt: string, target: ParadisAgentPromptTarget, pushState: () => void): Promise<ParadisAgentPromptOutcome> {
	const prompt = paradisStripTerminalControlCharacters(rawPrompt);
	const instances = () => paradisCollectAllTerminalInstances(services.terminalService, services.terminalGroupService);
	if (target.kind === 'terminal') {
		const find = (): ITerminalInstance | undefined => {
			const instanceId = services.identityService.getInstanceId(target.terminalKey);
			return instanceId === undefined ? undefined : instances().find(candidate => candidate.instanceId === instanceId);
		};
		const instance = find();
		const verdict = verdictOf(services, instance, ws);
		if (instance === undefined || verdict !== 'ready') {
			return { ok: false, error: TARGET_ERRORS[verdict === 'ready' ? 'not-agent' : verdict], code: verdict };
		}
		return sendToInstance(services, instance, ws, prompt, find);
	}
	if (target.kind === 'launch') {
		return launch(services, ws, root, prompt, target.agent, pushState);
	}
	if (target.kind === 'auto') {
		const agents = instances().filter(instance => isInSpaceAgent(services, instance, ws));
		const ready = agents.find(instance => verdictOf(services, instance, ws) === 'ready');
		if (ready !== undefined) {
			return sendToInstance(services, ready, ws, prompt, () => instances().find(candidate => candidate === ready && !candidate.isDisposed));
		}
		if (agents.length > 0) {
			return { ok: false, error: 'このスペースのエージェントは作業中か、入力を待っていることを確かめられません。終わってから送るか、新しいエージェントで直してもらってください。', code: 'busy' };
		}
	}
	const agentId = paradisDefaultMobileAgentId(services.configurationService.getValue<string>('paradis.workspaceSwitch.defaultAgent'), paradisConfiguredAgents(services.modelCatalogService).map(agent => agent.id));
	if (agentId === undefined) {
		return { ok: false, error: '起動できるエージェントが PC に設定されていません。', code: 'no-agent' };
	}
	return launch(services, ws, root, prompt, agentId, pushState);
}

/** スペースごとの送信中の印（iPhone と iPad から同時に・連打で送って、同じ依頼を二度貼り付けないため）。 */
export class ParadisMobileSendGate {
	private readonly sending = new Set<string>();

	/** 送信中でなければ印を付けて `run` を実行し、終わったら外す。送信中なら undefined。 */
	async run<T>(key: string, run: () => Promise<T>): Promise<T | undefined> {
		if (this.sending.has(key)) {
			return undefined;
		}
		this.sending.add(key);
		try {
			return await run();
		} finally {
			this.sending.delete(key);
		}
	}
}
