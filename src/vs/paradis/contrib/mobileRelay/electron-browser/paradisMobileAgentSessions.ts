/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 終わった会話をスマホから開き直し、続きを頼む（Orca W2-29、Q121 案 A）。scm チャネルの 3 つの種類を受ける。
 *
 * - `agentSessions { ws, offset?, limit?, query? }`: そのスペースの過去の会話（セッション履歴と同じ一覧）。PC で今開いている
 *   会話には `terminalKey` を付ける（スマホはそのタブを開く。二重に再開しない）
 * - `agentSessionPreview { ws, key }`: 会話の中身（読むだけ）
 * - `agentSessionResume { ws, key, prompt, requestId }`: 会話を**裏で**再開し、準備ができたら依頼を渡す。PC の画面の
 *   スペースは切り替えず、今のスペースでもフォーカスを移さない。権限の省略（`--dangerously-skip-permissions` など）は
 *   決して付けず、PC の既定の権限モードで起動する。PC に「スマホから再開しました」と通知する
 *
 * スマホへはセッション ID もパスも渡さない。宛先は会話の指紋（`paradisAgentSessionKey`）で、PC が一覧を引き直して探す。
 * 再開の依頼は `requestId` を最近 500 件だけ PC に残し、PC が再起動しても同じ依頼で二度再開しない（スマホは PC に
 * 届かない間の送信を最大 24 時間預かって送り直すため）。
 */

import { toAction } from '../../../../base/common/actions.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisScreenShowsAgentPrompt, paradisVisibleTerminalText } from '../../agentChat/browser/paradisAgentTuiInput.js';
import { paradisCollectAllTerminalInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneSession } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { paradisAgentStartupScreenState } from '../../agentIde/common/paradisAgentStartupScreen.js';
import { IParadisResumeSession } from '../../sessionResume/common/paradisSessionResume.js';
import { IParadisResumeSpaceWithUri, ParadisSessionResumeClient } from '../../sessionResume/electron-browser/paradisSessionResumeClient.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisIsSettledOnSpace, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisResumeAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { IParadisTerminalIdentityService } from '../browser/paradisTerminalIdentityService.js';
import { paradisSendAgentMessageToTui } from '../common/paradisAgentMessageSender.js';
import { paradisStripTerminalControlCharacters } from '../../../common/paradisTerminalControlCharacters.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { paradisCanPasteMultiline, paradisTerminalRunsAgent } from '../../agentIde/browser/paradisAgentIdeTerminalInput.js';
import { IParadisResumeLedgerEntry, PARADIS_AGENT_RESUME_PROMPT_LIMIT, PARADIS_AGENT_SESSION_KEY_PATTERN, PARADIS_AGENT_SESSIONS_PAGE_LIMIT, paradisAgentSessionKey, paradisClipAgentSessionText, paradisMobileAgentSessionMatches, paradisMobileAgentSessionView, paradisRecordResumeRequest, paradisResumedSessionOfCommand, paradisResumeRequestVerdict } from '../common/paradisMobileAgentResume.js';
import { registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/** 再開の依頼の台帳（PC の再起動をまたいで同じ依頼を二度実行しないため）。 */
const RESUME_LEDGER_KEY = 'paradis.mobile.agentResumeRequests';
/** 再開したエージェントの準備ができるのを待つ上限。 */
const RESUME_READY_TIMEOUT_MS = 60_000;
const RESUME_READY_POLL_MS = 500;
const PREVIEW_MESSAGE_LIMIT = 4_000;
const PREVIEW_MESSAGES = 200;

function readLedger(storageService: IStorageService): IParadisResumeLedgerEntry[] {
	try {
		const parsed: unknown = JSON.parse(storageService.get(RESUME_LEDGER_KEY, StorageScope.APPLICATION, '[]'));
		return Array.isArray(parsed)
			? parsed.filter((item): item is IParadisResumeLedgerEntry => typeof item === 'object' && item !== null && typeof (item as IParadisResumeLedgerEntry).id === 'string' && typeof (item as IParadisResumeLedgerEntry).at === 'number')
			: [];
	} catch {
		return [];
	}
}

function writeLedgerEntry(storageService: IStorageService, entry: IParadisResumeLedgerEntry): void {
	const next = paradisRecordResumeRequest(readLedger(storageService), entry, Date.now());
	storageService.store(RESUME_LEDGER_KEY, JSON.stringify(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
}

/** スペース（リポジトリか worktree）の id から、セッション履歴に渡すスペースを作る。 */
function findSpace(switchService: IParadisWorkspaceSwitchService, worktreeService: IParadisWorktreeService, ws: string | undefined): IParadisResumeSpaceWithUri | undefined {
	if (ws === undefined) {
		return undefined;
	}
	const current = switchService.activeStateKey;
	const resumable = (scheme: string) => scheme === Schemas.file || scheme === Schemas.vscodeRemote;
	for (const repository of switchService.repositories) {
		if (!resumable(repository.uri.scheme)) {
			continue;
		}
		if (repository.id === ws) {
			return { stateKey: repository.id, name: repository.name, uri: repository.uri, current: repository.id === current };
		}
		for (const worktree of worktreeService.getWorktrees(repository.id)) {
			if (worktree.missing || worktree.isMainCheckout || !resumable(worktree.uri.scheme)) {
				continue;
			}
			const stateKey = paradisWorktreeStateKey(worktree.uri);
			if (stateKey === ws) {
				// allow-any-unicode-next-line
				return { stateKey, name: `${repository.name} ✦ ${worktree.name}`, uri: worktree.uri, current: stateKey === current, repositoryStateKey: repository.id };
			}
		}
	}
	return undefined;
}

/** ウィンドウの道具（同期的な先頭で集め、await の後でも使えるようにする）。 */
interface IAgentSessionTools {
	readonly instantiationService: IInstantiationService;
	readonly snapshotService: IParadisAgentStatusSnapshotService;
	readonly paneTokenService: IParadisPaneTokenService;
	readonly identityService: IParadisTerminalIdentityService;
	readonly terminalService: ITerminalService;
	readonly terminalGroupService: ITerminalGroupService;
	readonly switchService: IParadisWorkspaceSwitchService;
	readonly worktreeService: IParadisWorktreeService;
	readonly notificationService: INotificationService;
	readonly storageService: IStorageService;
}

function collectTools(accessor: ServicesAccessor): IAgentSessionTools {
	return {
		instantiationService: accessor.get(IInstantiationService),
		snapshotService: accessor.get(IParadisAgentStatusSnapshotService),
		paneTokenService: accessor.get(IParadisPaneTokenService),
		identityService: accessor.get(IParadisTerminalIdentityService),
		terminalService: accessor.get(ITerminalService),
		terminalGroupService: accessor.get(ITerminalGroupService),
		switchService: accessor.get(IParadisWorkspaceSwitchService),
		worktreeService: accessor.get(IParadisWorktreeService),
		notificationService: accessor.get(INotificationService),
		storageService: accessor.get(IStorageService),
	};
}

/**
 * 今ターミナルで動いている会話（指紋 → そのターミナルのキー）。3 つの手がかりを合わせる（レビュー M6）:
 * - hook が報告した各ペインの会話（状態のスナップショットの `paneSessions`）
 * - 各ターミナルのシェル統合が記録している実行中のコマンド（`claude --resume <id>` / `codex resume <id>`）
 * - このウィンドウがスマホから再開した直後の会話（hook も届いていない数分の間。レビュー H1）
 */
function liveSessionTerminals(tools: IAgentSessionTools): Map<string, string> {
	let paneSessions: readonly IParadisAgentPaneSession[] = [];
	tools.snapshotService.subscribe(outcome => { paneSessions = outcome.snapshot?.paneSessions ?? paneSessions; }).dispose();
	const result = new Map<string, string>();
	for (const session of paneSessions) {
		const instanceId = tools.paneTokenService.getInstanceForToken(session.token);
		const terminalKey = instanceId !== undefined ? tools.identityService.getTerminalKey(instanceId) : undefined;
		if (terminalKey !== undefined) {
			result.set(paradisAgentSessionKey(session.agent, session.sessionId), terminalKey);
		}
	}
	const instances = paradisCollectAllTerminalInstances(tools.terminalService, tools.terminalGroupService).filter(instance => !instance.isDisposed);
	for (const instance of instances) {
		const executing = instance.capabilities.get(TerminalCapability.CommandDetection)?.executingCommand;
		const resumed = executing !== undefined ? paradisResumedSessionOfCommand(executing) : undefined;
		const terminalKey = resumed !== undefined ? tools.identityService.getTerminalKey(instance.instanceId) : undefined;
		if (resumed !== undefined && terminalKey !== undefined) {
			const key = paradisAgentSessionKey(resumed.agent, resumed.sessionId);
			if (!result.has(key)) {
				result.set(key, terminalKey);
			}
		}
	}
	const now = Date.now();
	for (const [key, recent] of recentResumes) {
		const alive = instances.some(instance => instance.instanceId === recent.instanceId);
		if (now - recent.at > RECENT_RESUME_TTL_MS || !alive) {
			recentResumes.delete(key);
			continue;
		}
		const terminalKey = tools.identityService.getTerminalKey(recent.instanceId);
		if (terminalKey !== undefined && !result.has(key)) {
			result.set(key, terminalKey);
		}
	}
	return result;
}

/** スマホからの再開を処理している会話（指紋）と依頼 ID。最初の await より前に入れる（二重の再開を防ぐ。レビュー H1）。 */
const resumingKeys = new Set<string>();
const resumingRequestIds = new Set<string>();
/** スマホから再開した直後の会話 → そのターミナル（hook が届くまでの間も「開いている」とみなす）。 */
const recentResumes = new Map<string, { readonly instanceId: number; readonly at: number }>();
/** {@link recentResumes} を覚えておく時間。 */
const RECENT_RESUME_TTL_MS = 5 * 60_000;

async function listSessions(tools: IAgentSessionTools, space: IParadisResumeSpaceWithUri): Promise<readonly IParadisResumeSession[]> {
	const client = tools.instantiationService.createInstance(ParadisSessionResumeClient);
	const sessions = await client.list({ spaces: [space] });
	return sessions.filter(session => session.spaceStateKey === space.stateKey && session.empty !== true);
}

function requireString(value: unknown, name: string, limit: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
		throw new Error(`invalid ${name}`);
	}
	return value;
}

/** 再開したエージェントが入力を待つまで待つ。信頼の確認で止まっていれば 'trust'、待ちきれなければ 'timeout'。 */
async function waitForAgentReady(instance: ITerminalInstance): Promise<'ready' | 'trust' | 'timeout' | 'gone'> {
	const deadline = Date.now() + RESUME_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (instance.isDisposed) {
			return 'gone';
		}
		const state = paradisAgentStartupScreenState(paradisVisibleTerminalText(instance));
		if (state === 'trust_dialog') {
			return 'trust';
		}
		if (state === 'ready') {
			return 'ready';
		}
		await new Promise<void>(resolve => setTimeout(resolve, RESUME_READY_POLL_MS));
	}
	return 'timeout';
}

registerParadisMobileRequestHandler('scm', 'agentSessions', {
	handle(accessor, request, context) {
		const tools = collectTools(accessor);
		const space = findSpace(tools.switchService, tools.worktreeService, request.ws);
		if (space === undefined) {
			throw new Error('このスペースは PC で開けません');
		}
		const offset = typeof request.offset === 'number' && Number.isInteger(request.offset) && request.offset >= 0 ? request.offset : 0;
		const limit = typeof request.limit === 'number' && Number.isInteger(request.limit) && request.limit > 0 ? Math.min(request.limit, PARADIS_AGENT_SESSIONS_PAGE_LIMIT) : PARADIS_AGENT_SESSIONS_PAGE_LIMIT;
		const query = typeof request.query === 'string' ? request.query.slice(0, 200) : undefined;
		const live = liveSessionTerminals(tools);
		return listSessions(tools, space).then(sessions => {
			const views = sessions
				.map(session => paradisMobileAgentSessionView(session, live.get(paradisAgentSessionKey(session.agent, session.id))))
				.filter(session => paradisMobileAgentSessionMatches(session, query));
			const page = views.slice(offset, offset + limit);
			context.reply({ t: 'agentSessions', sessions: page, total: views.length, ...(offset + page.length < views.length ? { nextOffset: offset + page.length } : {}) });
		});
	},
});

registerParadisMobileRequestHandler('scm', 'agentSessionPreview', {
	handle(accessor, request, context) {
		const tools = collectTools(accessor);
		const space = findSpace(tools.switchService, tools.worktreeService, request.ws);
		const key = requireString(request.key, 'key', 64);
		if (space === undefined || !PARADIS_AGENT_SESSION_KEY_PATTERN.test(key)) {
			throw new Error('この会話は見つかりませんでした');
		}
		const client = tools.instantiationService.createInstance(ParadisSessionResumeClient);
		return client.list({ spaces: [space] }).then(async sessions => {
			const session = sessions.find(candidate => paradisAgentSessionKey(candidate.agent, candidate.id) === key);
			if (session === undefined) {
				throw new Error('この会話は見つかりませんでした');
			}
			const preview = await client.preview(session.catalogId);
			const messages = preview.messages.slice(-PREVIEW_MESSAGES).map(message => ({
				role: message.role,
				// allow-any-unicode-next-line
				text: message.text.length > PREVIEW_MESSAGE_LIMIT ? `${message.text.slice(0, PREVIEW_MESSAGE_LIMIT)}…` : message.text,
				...(message.timestamp !== undefined ? { ts: message.timestamp } : {}),
			}));
			const terminalKey = liveSessionTerminals(tools).get(key);
			context.reply({
				t: 'agentSessionPreview', session: paradisMobileAgentSessionView(session, terminalKey), messages,
				truncated: preview.truncated || preview.messages.length > messages.length,
			});
		});
	},
});

registerParadisMobileRequestHandler('scm', 'agentSessionResume', {
	handle(accessor, request, context) {
		const tools = collectTools(accessor);
		const key = requireString(request.key, 'key', 64);
		const requestId = requireString(request.requestId, 'requestId', 100);
		const rawPrompt = typeof request.prompt === 'string' ? request.prompt : '';
		if (!PARADIS_AGENT_SESSION_KEY_PATTERN.test(key) || rawPrompt.trim().length === 0 || rawPrompt.length > PARADIS_AGENT_RESUME_PROMPT_LIMIT) {
			throw new Error('送る内容が正しくありません');
		}
		const reply = (body: IResumeReply) => context.reply({ t: 'agentSessionResume', ...body });
		// ここから最初の await までを同期で済ませる（同じ依頼・同じ会話の求めが重なっても、再開は 1 回だけ。レビュー H1）。
		if (resumingRequestIds.has(requestId)) {
			reply({ status: 'duplicate', message: 'この依頼は PC で処理している最中です' });
			return undefined;
		}
		// 同じ依頼（スマホが預かって送り直したもの）は二度実行しない。ターミナルを開く前に失敗した・止まったものだけは、やり直せる。
		const previous = readLedger(tools.storageService).find(entry => entry.id === requestId);
		const verdict = paradisResumeRequestVerdict(previous, Date.now());
		if (verdict === 'pending') {
			// 別のウィンドウが進めている最中か、PC が落ちてから間が無い。エラーで断り、スマホに預かりのまま残させる
			throw new Error('この依頼は PC で途中まで進んでいます。少し待ってからもう一度送ってください');
		}
		if (previous !== undefined && verdict === 'duplicate') {
			reply({ status: 'duplicate', ...(previous.terminalKey !== undefined ? { terminalKey: previous.terminalKey } : {}), ...(previous.delivered !== undefined ? { delivered: previous.delivered } : {}) });
			return undefined;
		}
		if (resumingKeys.has(key)) {
			reply({ status: 'running', message: 'この会話は今スマホから再開しているところです。少し待ってから会話の画面で送ってください' });
			return undefined;
		}
		const running = liveSessionTerminals(tools).get(key);
		if (running !== undefined) {
			reply({ status: 'running', terminalKey: running, message: 'この会話は PC で開いています' });
			return undefined;
		}
		const space = findSpace(tools.switchService, tools.worktreeService, request.ws);
		if (space === undefined) {
			throw new Error('このスペースは PC で開けません');
		}
		resumingKeys.add(key);
		resumingRequestIds.add(requestId);
		// 台帳へも先に入れる（再開の途中で PC が落ちても、送り直しで二度目を起こさない）。
		writeLedgerEntry(tools.storageService, { id: requestId, at: Date.now(), status: 'started' });
		return resumeFromMobile(tools, space, key, requestId, paradisStripTerminalControlCharacters(rawPrompt), reply).finally(() => {
			resumingKeys.delete(key);
			resumingRequestIds.delete(requestId);
		});
	},
});

interface IResumeReply {
	readonly status: 'resumed' | 'running' | 'needs-trust' | 'duplicate';
	readonly terminalKey?: string;
	readonly delivered?: boolean;
	readonly message?: string;
}

/**
 * 再開したターミナルへ依頼を渡してよいか（W2-28 の差分メモの送信と同じ規則。レビュー M3）: 前面のコマンドが Claude Code /
 * Codex だとシェル統合で確かめられ（エージェントが抜けてシェルに戻っていたら、依頼がコマンドとして実行される）、確認や
 * 質問の画面が出ておらず、複数行なら貼り付けの囲みが有効なこと。
 */
function canDeliverPrompt(instance: ITerminalInstance, prompt: string): boolean {
	return !instance.isDisposed
		&& paradisTerminalRunsAgent(instance)
		&& (!prompt.includes('\n') || paradisCanPasteMultiline(instance))
		&& !paradisScreenShowsAgentPrompt(paradisVisibleTerminalText(instance));
}

async function resumeFromMobile(
	tools: IAgentSessionTools,
	space: IParadisResumeSpaceWithUri,
	key: string,
	requestId: string,
	prompt: string,
	reply: (body: IResumeReply) => void,
): Promise<void> {
	let terminalKey: string | undefined;
	try {
		const sessions = await listSessions(tools, space);
		const session = sessions.find(candidate => paradisAgentSessionKey(candidate.agent, candidate.id) === key);
		if (session === undefined) {
			throw new Error('この会話は見つかりませんでした');
		}
		// 一覧を引いている間に PC で開かれていないか、もう一度確かめる。
		const running = liveSessionTerminals(tools).get(key);
		if (running !== undefined) {
			writeLedgerEntry(tools.storageService, { id: requestId, at: Date.now(), status: 'failed' });
			reply({ status: 'running', terminalKey: running, message: 'この会話は PC で開いています' });
			return;
		}
		const launched = await tools.instantiationService.invokeFunction(paradisResumeAgentInWorkspace, {
			rootUri: space.uri,
			stateKey: space.stateKey,
			agent: session.agent,
			sessionId: session.id,
			// スマホからは権限の省略を決して付けない（PC の既定の権限モードで起動する。Q121）。
			dangerouslyBypassPermissions: false,
			preserveFocus: true,
			...(session.agent === 'codex' && session.codexHome !== undefined ? { codexHome: session.codexHome } : {}),
		});
		recentResumes.set(key, { instanceId: launched.instanceId, at: Date.now() });
		const instance = paradisCollectAllTerminalInstances(tools.terminalService, tools.terminalGroupService).find(candidate => candidate.instanceId === launched.instanceId);
		terminalKey = tools.identityService.getTerminalKey(launched.instanceId);
		writeLedgerEntry(tools.storageService, { id: requestId, at: Date.now(), status: 'started', ...(terminalKey !== undefined ? { terminalKey } : {}) });
		const readiness = instance !== undefined ? await waitForAgentReady(instance) : 'gone';
		// 通知は準備の結果が分かってから出す（L6。開いたタブがまだ空のシェルのうちに「表示」を押させない）。
		notifyResumed(tools, space, session, instance);
		let delivered = false;
		if (readiness === 'ready' && instance !== undefined) {
			const outcome = await paradisSendAgentMessageToTui(
				prompt,
				(text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode),
				async () => canDeliverPrompt(instance, prompt),
			);
			delivered = outcome.executed;
		}
		writeLedgerEntry(tools.storageService, { id: requestId, at: Date.now(), status: 'resumed', ...(terminalKey !== undefined ? { terminalKey } : {}), delivered });
		if (readiness === 'trust') {
			reply({ status: 'needs-trust', ...(terminalKey !== undefined ? { terminalKey } : {}), delivered: false, message: 'PC でフォルダを信頼するかの確認が出ています。PC で答えてから送ってください' });
			return;
		}
		reply({
			status: 'resumed', ...(terminalKey !== undefined ? { terminalKey } : {}), delivered,
			...(delivered ? {} : { message: '会話は再開しましたが、依頼を渡せませんでした。会話の画面から送ってください' }),
		});
	} catch (error) {
		writeLedgerEntry(tools.storageService, { id: requestId, at: Date.now(), status: 'failed', ...(terminalKey !== undefined ? { terminalKey } : {}) });
		throw error;
	}
}

/** PC に「スマホから再開しました」を出す（裏で開いたタブに気づけるように。Q121）。 */
function notifyResumed(tools: IAgentSessionTools, space: IParadisResumeSpaceWithUri, session: IParadisResumeSession, instance: ITerminalInstance | undefined): void {
	tools.notificationService.notify({
		severity: Severity.Info,
		message: localize('paradis.mobile.agentResumed', "スマホから「{0}」の会話を再開しました（{1}）", paradisClipAgentSessionText(session.title, 80), space.name),
		actions: {
			primary: [toAction({
				id: 'paradis.mobile.agentResumed.show',
				label: localize('paradis.mobile.agentResumed.show', "表示"),
				run: async () => {
					if (tools.switchService.activeStateKey !== space.stateKey) {
						await tools.switchService.switchToStateKey(space.stateKey);
					}
					// 待っている間に別の切り替えが割り込んだら開かない（今のスペースのタブに紛れ込む）。
					if (!paradisIsSettledOnSpace(tools.switchService, space.stateKey)) {
						return;
					}
					if (instance !== undefined && !instance.isDisposed) {
						tools.terminalService.setActiveInstance(instance);
						await tools.terminalService.revealActiveTerminal();
						instance.focus();
					}
				},
			})],
		},
	});
}
