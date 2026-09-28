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
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisResumeAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { IParadisTerminalIdentityService } from '../browser/paradisTerminalIdentityService.js';
import { paradisSendAgentMessageToTui } from '../common/paradisAgentMessageSender.js';
import { IParadisResumeLedgerEntry, PARADIS_AGENT_RESUME_PROMPT_LIMIT, PARADIS_AGENT_SESSION_KEY_PATTERN, PARADIS_AGENT_SESSIONS_PAGE_LIMIT, paradisAgentSessionKey, paradisClipAgentSessionText, paradisMobileAgentSessionMatches, paradisMobileAgentSessionView, paradisRecordResumeRequest } from '../common/paradisMobileAgentResume.js';
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

/** 今ターミナルで動いている会話（指紋 → そのターミナルのキー）。 */
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
	return result;
}

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
		const prompt = typeof request.prompt === 'string' ? request.prompt : '';
		if (!PARADIS_AGENT_SESSION_KEY_PATTERN.test(key) || prompt.trim().length === 0 || prompt.length > PARADIS_AGENT_RESUME_PROMPT_LIMIT) {
			throw new Error('送る内容が正しくありません');
		}
		// 同じ依頼（スマホが預かって送り直したもの）は二度実行しない。
		const previous = readLedger(tools.storageService).find(entry => entry.id === requestId);
		if (previous !== undefined) {
			context.reply({ t: 'agentSessionResume', status: 'duplicate', ...(previous.terminalKey !== undefined ? { terminalKey: previous.terminalKey } : {}), ...(previous.delivered !== undefined ? { delivered: previous.delivered } : {}) });
			return undefined;
		}
		const space = findSpace(tools.switchService, tools.worktreeService, request.ws);
		if (space === undefined) {
			throw new Error('このスペースは PC で開けません');
		}
		return resumeFromMobile(tools, space, key, requestId, prompt, body => context.reply({ t: 'agentSessionResume', ...body }));
	},
});

async function resumeFromMobile(
	tools: IAgentSessionTools,
	space: IParadisResumeSpaceWithUri,
	key: string,
	requestId: string,
	prompt: string,
	reply: (body: { readonly status: 'resumed' | 'running' | 'needs-trust'; readonly terminalKey?: string; readonly delivered?: boolean; readonly message?: string }) => void,
): Promise<void> {
	const sessions = await listSessions(tools, space);
	const session = sessions.find(candidate => paradisAgentSessionKey(candidate.agent, candidate.id) === key);
	if (session === undefined) {
		throw new Error('この会話は見つかりませんでした');
	}
	// PC で今開いている会話は再開しない（同じ会話を 2 つのターミナルで動かさない）。
	const running = liveSessionTerminals(tools).get(key);
	if (running !== undefined) {
		reply({ status: 'running', terminalKey: running, message: 'この会話は PC で開いています' });
		return;
	}
	// 先に台帳へ入れる（再開の途中で PC が落ちても、送り直しで二度目を起こさない）。
	writeLedgerEntry(tools.storageService, { id: requestId, at: Date.now(), status: 'started' });
	let terminalKey: string | undefined;
	try {
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
		const instance = paradisCollectAllTerminalInstances(tools.terminalService, tools.terminalGroupService).find(candidate => candidate.instanceId === launched.instanceId);
		terminalKey = tools.identityService.getTerminalKey(launched.instanceId);
		notifyResumed(tools, space, session, instance);
		const readiness = instance !== undefined ? await waitForAgentReady(instance) : 'gone';
		let delivered = false;
		if (readiness === 'ready' && instance !== undefined) {
			const outcome = await paradisSendAgentMessageToTui(
				prompt,
				(text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode),
				async () => !instance.isDisposed && !paradisScreenShowsAgentPrompt(paradisVisibleTerminalText(instance)),
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
