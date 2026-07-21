/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'fs';
import { createConnection, type Socket } from 'net';
import { WebSocket, type RawData } from 'ws';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';

const RETRY_INTERVAL_MS = 10_000;
const LOADED_POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 8_000;
const SETTINGS_CONFIRM_TIMEOUT_MS = 8_000;
const CATALOG_CACHE_MS = 60_000;
const MAX_LIVE_TEXT_LENGTH = 6_000;
const MAX_RPC_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_PAGES = 10;
const MAX_MODELS = 128;

interface IJsonRpcMessage {
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
}

export interface IParadisCodexApprovalChoice {
	readonly id: string;
	readonly label: string;
	readonly tone: 'approve' | 'neutral' | 'deny';
}

export interface IParadisCodexApprovalInteraction {
	readonly kind: 'approval';
	readonly id: string;
	readonly title: string;
	readonly detail: string;
	readonly choices: readonly IParadisCodexApprovalChoice[];
}

interface IParadisCodexApprovalRequest {
	readonly threadId: string;
	readonly requestId: number | string;
	readonly interaction: IParadisCodexApprovalInteraction;
	readonly results: ReadonlyMap<string, Record<string, unknown>>;
}

interface IPendingRequest {
	readonly method: string;
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface ISettingsWaiter {
	readonly model: string;
	readonly effort: string;
	readonly resolve: (settings: IParadisCodexThreadSettings) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** app-server daemonから受けたthread単位の通知。 */
export interface IParadisCodexDaemonEvent {
	readonly threadId: string;
	readonly method: string;
	readonly params: Record<string, unknown>;
	readonly requestId?: number | string;
	readonly approval?: IParadisCodexApprovalInteraction;
}

/** model/listが広告するreasoning effort 1件。 */
export interface IParadisCodexReasoningEffort {
	readonly value: string;
	readonly description: string;
}

/** model/listから上限つきで正規化したCodexモデル候補。 */
export interface IParadisCodexModelOption {
	readonly id: string;
	/** thread/settings/updateへ渡すモデル名。 */
	readonly model: string;
	readonly displayName: string;
	readonly description: string;
	readonly efforts: readonly IParadisCodexReasoningEffort[];
	readonly defaultEffort: string;
	readonly isDefault: boolean;
}

/** daemonが確認したthreadの次ターン用モデル設定。 */
export interface IParadisCodexThreadSettings {
	readonly model: string;
	readonly effort?: string;
}

export interface IParadisCodexThreadMessage {
	readonly role: 'user' | 'assistant' | 'tool';
	readonly text: string;
	readonly kind: 'text' | 'thinking' | 'tool';
}

/** モバイルへ安全なcode/messageとして返せるCodex制御エラー。 */
export class ParadisCodexControlError extends Error {
	constructor(readonly code: 'disabled' | 'unsupported' | 'unavailable' | 'not-loaded' | 'busy' | 'invalid-selection' | 'timeout' | 'rpc-error', message: string) {
		super(message);
		this.name = 'ParadisCodexControlError';
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown, maxLength: number = 500): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function requestIdValue(value: unknown): number | string | undefined {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
		return value;
	}
	return stringValue(value, 200);
}

function requestIdKey(threadId: string, requestId: number | string): string {
	return `${threadId}\0${typeof requestId === 'number' ? 'n' : 's'}\0${String(requestId)}`;
}

function interactionIdForRequest(requestId: number | string): string {
	const raw = String(requestId);
	const safe = /^[A-Za-z0-9._-]+$/.test(raw) ? raw : Buffer.from(raw, 'utf8').toString('base64url');
	return `codex:${typeof requestId === 'number' ? 'n' : 's'}:${safe}`;
}

function jsonRecordClone(value: unknown): Record<string, unknown> | undefined {
	const source = record(value);
	if (source === undefined) {
		return undefined;
	}
	try {
		const encoded = JSON.stringify(source);
		return encoded.length <= MAX_RPC_PAYLOAD_BYTES ? JSON.parse(encoded) as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function commandDecision(value: unknown): unknown | undefined {
	if (value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel') {
		return value;
	}
	const decision = record(value);
	const execpolicy = record(decision?.['acceptWithExecpolicyAmendment']);
	const amendment = execpolicy?.['execpolicy_amendment'];
	if (Array.isArray(amendment) && amendment.length > 0 && amendment.length <= 100 && amendment.every(part => typeof part === 'string' && part.length <= 1_000)) {
		return { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...amendment] } };
	}
	const network = record(decision?.['applyNetworkPolicyAmendment']);
	const policy = record(network?.['network_policy_amendment']);
	const host = stringValue(policy?.['host'], 1_000);
	const action = policy?.['action'];
	return host !== undefined && (action === 'allow' || action === 'deny')
		? { applyNetworkPolicyAmendment: { network_policy_amendment: { host, action } } }
		: undefined;
}

function decisionLabel(decision: unknown): { readonly label: string; readonly tone: IParadisCodexApprovalChoice['tone'] } | undefined {
	if (decision === 'accept') { return { label: '今回だけ許可', tone: 'approve' }; }
	if (decision === 'acceptForSession') { return { label: 'セッション中は許可', tone: 'neutral' }; }
	if (decision === 'decline') { return { label: '拒否', tone: 'deny' }; }
	if (decision === 'cancel') { return { label: 'キャンセル', tone: 'neutral' }; }
	const value = record(decision);
	if (value?.['acceptWithExecpolicyAmendment'] !== undefined) {
		return { label: '同じ種類のコマンドを今後許可', tone: 'neutral' };
	}
	const network = record(record(value?.['applyNetworkPolicyAmendment'])?.['network_policy_amendment']);
	const host = stringValue(network?.['host'], 1_000);
	if (host !== undefined) {
		return { label: network?.['action'] === 'allow' ? `${host} を今後許可` : `${host} を今後拒否`, tone: 'neutral' };
	}
	return undefined;
}

function commandDecisions(params: Record<string, unknown>): readonly unknown[] {
	const advertised = params['availableDecisions'];
	if (Array.isArray(advertised)) {
		const parsed = advertised.slice(0, 12).map(commandDecision).filter(value => value !== undefined);
		if (parsed.length > 0) {
			return parsed;
		}
	}
	const fallback: unknown[] = ['accept'];
	const execpolicy = params['proposedExecpolicyAmendment'];
	if (Array.isArray(execpolicy)) {
		const parsed = commandDecision({ acceptWithExecpolicyAmendment: { execpolicy_amendment: execpolicy } });
		if (parsed !== undefined) { fallback.push(parsed); }
	}
	if (Array.isArray(params['proposedNetworkPolicyAmendments'])) {
		for (const amendment of params['proposedNetworkPolicyAmendments'].slice(0, 8)) {
			const parsed = commandDecision({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
			if (parsed !== undefined) { fallback.push(parsed); }
		}
	}
	fallback.push('decline');
	return fallback;
}

function approvalDetail(...parts: unknown[]): string {
	return parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
		.map(part => part.trim()).join('\n').slice(0, 6_000);
}

function buildDecisionApproval(
	threadId: string,
	requestId: number | string,
	title: string,
	detail: string,
	decisions: readonly unknown[],
): IParadisCodexApprovalRequest | undefined {
	const choices: IParadisCodexApprovalChoice[] = [];
	const results = new Map<string, Record<string, unknown>>();
	for (const decision of decisions) {
		const label = decisionLabel(decision);
		if (label === undefined) { continue; }
		const id = String(choices.length);
		choices.push({ id, ...label });
		results.set(id, { decision });
	}
	if (choices.length === 0) { return undefined; }
	return {
		threadId, requestId,
		interaction: { kind: 'approval', id: interactionIdForRequest(requestId), title, detail, choices },
		results,
	};
}

/** Codex app-serverの承認server requestを、モバイル表示と安全な回答候補へ正規化する。 */
function parseCodexApprovalRequest(message: IJsonRpcMessage): IParadisCodexApprovalRequest | undefined {
	const method = message.method;
	const requestId = requestIdValue(message.id);
	const params = record(message.params);
	const threadId = stringValue(params?.['threadId'], 500);
	if (requestId === undefined || params === undefined || threadId === undefined) {
		return undefined;
	}
	if (method === 'item/commandExecution/requestApproval') {
		return buildDecisionApproval(threadId, requestId, 'コマンドの実行許可', approvalDetail(params['command'], params['reason'], params['cwd']), commandDecisions(params));
	}
	if (method === 'item/fileChange/requestApproval') {
		return buildDecisionApproval(threadId, requestId, 'ファイル変更の許可', approvalDetail(params['reason'], params['grantRoot']), [
			'accept', ...(stringValue(params['grantRoot'], 6_000) !== undefined ? ['acceptForSession'] : []), 'decline',
		]);
	}
	if (method === 'item/permissions/requestApproval') {
		const requested = record(params['permissions']);
		if (requested === undefined) { return undefined; }
		const granted: Record<string, unknown> = {};
		for (const key of ['network', 'fileSystem']) {
			const value = jsonRecordClone(requested[key]);
			if (value !== undefined) { granted[key] = value; }
		}
		const interaction: IParadisCodexApprovalInteraction = {
			kind: 'approval', id: interactionIdForRequest(requestId), title: '追加権限の許可',
			detail: approvalDetail(params['reason'], params['cwd']),
			choices: [
				{ id: '0', label: '今回だけ許可', tone: 'approve' },
				{ id: '1', label: 'セッション中は許可', tone: 'neutral' },
				{ id: '2', label: '拒否', tone: 'deny' },
			],
		};
		return {
			threadId, requestId, interaction,
			results: new Map([
				['0', { permissions: granted, scope: 'turn' }],
				['1', { permissions: granted, scope: 'session' }],
				['2', { permissions: {}, scope: 'turn' }],
			]),
		};
	}
	return undefined;
}

export function paradisParseCodexApprovalRequestForTest(message: unknown): IParadisCodexApprovalRequest | undefined {
	return record(message) !== undefined ? parseCodexApprovalRequest(message as IJsonRpcMessage) : undefined;
}

function approvalResult(request: IParadisCodexApprovalRequest, choiceId: string): Record<string, unknown> | undefined {
	const direct = request.results.get(choiceId);
	if (direct !== undefined) { return direct; }
	const legacyTone = choiceId === 'yes' ? 'approve' : choiceId === 'no' ? 'deny' : undefined;
	const legacyChoice = legacyTone !== undefined ? request.interaction.choices.find(choice => choice.tone === legacyTone) : undefined;
	return legacyChoice !== undefined ? request.results.get(legacyChoice.id) : undefined;
}

export function paradisCodexApprovalResultForTest(request: IParadisCodexApprovalRequest, choiceId: string): Record<string, unknown> | undefined {
	return approvalResult(request, choiceId);
}

function threadMessageText(value: unknown): string | undefined {
	if (typeof value === 'string') { return value.trim().length > 0 ? truncateCodexLiveText(value) : undefined; }
	if (!Array.isArray(value)) { return undefined; }
	const parts = value.map(part => {
		if (typeof part === 'string') { return part; }
		const item = record(part);
		return typeof item?.['text'] === 'string' ? item['text'] : typeof item?.['content'] === 'string' ? item['content'] : undefined;
	}).filter((part): part is string => part !== undefined && part.trim().length > 0);
	return parts.length > 0 ? truncateCodexLiveText(parts.join('\n')) : undefined;
}

function rawDataToString(data: RawData): string {
	if (Buffer.isBuffer(data)) {
		return data.toString('utf8');
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}
	return Buffer.from(data).toString('utf8');
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

/** Windows: `pcx/<paneToken>.endpoint.json` 形式のtargetからペイントークン（=Bearer認証トークン）を復元する。 */
interface IParadisCodexWsEndpointTarget {
	readonly paneToken: string;
}

export function paradisParseCodexWsEndpointTarget(targetPath: string): IParadisCodexWsEndpointTarget | undefined {
	const match = /[\\/]pcx[\\/]([A-Za-z0-9._-]{1,64})\.endpoint\.json$/.exec(targetPath);
	return match !== null ? { paneToken: match[1] } : undefined;
}

/** ランチャーが書いたendpointファイルから、検証済みのloopbackポートを読む。 */
async function readCodexEndpointPort(endpointPath: string): Promise<number | undefined> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(endpointPath, 'utf8'));
		const port = record(parsed)?.['port'];
		return typeof port === 'number' && Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
	} catch {
		return undefined;
	}
}

function createUnixWebSocketConnection(socketPath: string): typeof createConnection {
	// @types/wsはnet.createConnection型を公開しているが、実行時のws/httpはNode Agentの
	// (error, socket) callbackを渡す。接続完了通知が無いとUnix socket handshakeが切断
	// されるため、実行時契約へ明示的に合わせる。
	return ((_options: unknown, callback: (error: Error | null, socket: Socket) => void): Socket => {
		const connection = createConnection(socketPath);
		connection.once('connect', () => callback(null, connection));
		return connection;
	}) as unknown as typeof createConnection;
}

/**
 * 1つのpane app-serverに対するJSON-RPC接続。macOS/LinuxはUnix socket上のWebSocket、
 * Windowsはランチャーが書いたendpointファイル経由のloopback WebSocket（Bearer=ペイントークン）。
 * - app-serverの起動と停止はターミナルのCodexランチャーが所有する
 * - thread/loaded/listでsocket所有を確認できたthreadだけresume/購読する
 * - model/listをカタログの正本とし、thread/settings/updateを確認通知つきで適用する
 * - 承認server requestは観測だけ行い、モバイルでユーザーが明示選択した時だけ同じ接続から応答する
 */
class ParadisCodexServerConnection extends Disposable {
	private enabled = false;
	private socket: WebSocket | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private loadedPollTimer: ReturnType<typeof setTimeout> | undefined;
	private initialized = false;
	private connectionGeneration = 0;
	private nextRequestId = 1;
	private loadedRefreshInFlight = false;
	private readonly pendingRequests = new Map<number, IPendingRequest>();
	private readonly wantedThreads = new Set<string>();
	private readonly loadedThreads = new Set<string>();
	private readonly pendingThreads = new Set<string>();
	private readonly subscribedThreads = new Set<string>();
	private readonly threadSettings = new Map<string, IParadisCodexThreadSettings>();
	private readonly settingsWaiters = new Map<string, ISettingsWaiter>();
	private readonly pendingApprovals = new Map<string, IParadisCodexApprovalRequest>();
	private readonly resolvingApprovals = new Set<string>();
	private catalogCache: { readonly at: number; readonly models: readonly IParadisCodexModelOption[] } | undefined;

	/** Windows方式（endpointファイル）のtargetなら、その認証情報。undefinedならUnix socket方式。 */
	private readonly endpointTarget: IParadisCodexWsEndpointTarget | undefined;

	constructor(
		private readonly onEvent: (event: IParadisCodexDaemonEvent) => void,
		private readonly logService: ILogService,
		private readonly socketPath: string,
	) {
		super();
		this.endpointTarget = paradisParseCodexWsEndpointTarget(socketPath);
	}

	/** 明示的な実験設定に合わせてsocket連携を開始・停止する。 */
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		if (enabled) {
			void this.ensureConnected();
		} else {
			this.stop();
		}
	}

	/** hookで確定できたCodex thread集合だけを購読候補として同期する。 */
	setThreads(threadIds: readonly string[]): void {
		const next = new Set(threadIds.filter(threadId => threadId.length > 0));
		for (const threadId of this.wantedThreads) {
			if (!next.has(threadId)) {
				this.clearThreadApprovals(threadId);
				this.wantedThreads.delete(threadId);
				this.pendingThreads.delete(threadId);
				this.threadSettings.delete(threadId);
				this.rejectSettingsWaiter(threadId, new ParadisCodexControlError('unavailable', 'Codexセッションが終了しました'));
				if (this.subscribedThreads.has(threadId)) {
					void this.unsubscribeThread(threadId);
				}
			}
		}
		for (const threadId of next) {
			this.wantedThreads.add(threadId);
		}
		if (this.wantedThreads.size === 0) {
			this.stop();
			return;
		}
		if (this.enabled) {
			void this.ensureConnected();
			void this.refreshLoadedThreads();
		}
	}

	/** 指定threadが同一daemonにロード済みかつ購読済みかを返す。 */
	isThreadReady(threadId: string): boolean {
		return this.enabled && this.initialized && this.loadedThreads.has(threadId) && this.subscribedThreads.has(threadId);
	}

	hasPendingApproval(threadId: string, interactionId: string): boolean {
		return [...this.pendingApprovals.values()].some(request => request.threadId === threadId && request.interaction.id === interactionId);
	}

	async answerApproval(threadId: string, interactionId: string, choiceId: string): Promise<void> {
		const request = [...this.pendingApprovals.values()].find(value => value.threadId === threadId && value.interaction.id === interactionId);
		const result = request !== undefined ? approvalResult(request, choiceId) : undefined;
		if (request === undefined || result === undefined || !this.wantedThreads.has(threadId)) {
			throw new ParadisCodexControlError('not-loaded', 'この承認要求はすでに完了しています');
		}
		const key = requestIdKey(threadId, request.requestId);
		if (this.resolvingApprovals.has(key)) {
			throw new ParadisCodexControlError('busy', 'この承認要求には別の端末から回答中です');
		}
		const socket = this.socket;
		if (socket?.readyState !== WebSocket.OPEN || !this.initialized) {
			throw new ParadisCodexControlError('unavailable', 'Codex app-serverへ接続していません');
		}
		this.resolvingApprovals.add(key);
		try {
			await new Promise<void>((resolve, reject) => {
				socket.send(JSON.stringify({ id: request.requestId, result }), error => {
					if (error !== undefined) {
						reject(new ParadisCodexControlError('unavailable', `Codexへ承認結果を送信できませんでした: ${error.message}`));
					} else {
						resolve();
					}
				});
			});
		} catch (error) {
			this.resolvingApprovals.delete(key);
			throw error;
		}
	}

	/** daemon上で稼働中のthreadに対して、現在の動的モデル一覧を返す。 */
	async listModels(threadId: string): Promise<readonly IParadisCodexModelOption[]> {
		await this.awaitThreadReady(threadId);
		if (this.catalogCache !== undefined && Date.now() - this.catalogCache.at < CATALOG_CACHE_MS) {
			return this.catalogCache.models;
		}

		const models: IParadisCodexModelOption[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
			const result = record(await this.request('model/list', cursor === undefined ? { includeHidden: false } : { includeHidden: false, cursor }));
			const data = result?.['data'];
			if (!Array.isArray(data)) {
				throw new ParadisCodexControlError('rpc-error', 'Codexのモデル一覧レスポンスが不正です');
			}
			for (const raw of data) {
				const parsed = this.parseModel(raw);
				if (parsed !== undefined && !models.some(model => model.id === parsed.id || model.model === parsed.model)) {
					models.push(parsed);
					if (models.length >= MAX_MODELS) {
						break;
					}
				}
			}
			cursor = stringValue(result?.['nextCursor']);
			if (cursor === undefined || models.length >= MAX_MODELS) {
				break;
			}
		}
		if (models.length === 0) {
			throw new ParadisCodexControlError('unavailable', '利用可能なCodexモデルがありません');
		}
		this.catalogCache = { at: Date.now(), models };
		return models;
	}

	/** モデルとEffortを原子的にキューへ入れ、実効設定の確認通知を待つ。 */
	async updateThreadSettings(threadId: string, model: string, effort: string): Promise<IParadisCodexThreadSettings> {
		await this.awaitThreadReady(threadId);
		if (this.settingsWaiters.has(threadId)) {
			throw new ParadisCodexControlError('busy', 'このCodexセッションでは設定変更を処理中です');
		}
		const catalog = await this.listModels(threadId);
		const selected = catalog.find(option => option.model === model);
		if (selected === undefined || !selected.efforts.some(option => option.value === effort)) {
			throw new ParadisCodexControlError('invalid-selection', '現在のCodexで利用できないモデルまたはEffortです');
		}
		const current = this.threadSettings.get(threadId);
		if (current?.model === model && current.effort === effort) {
			return current;
		}

		const confirmation = new Promise<IParadisCodexThreadSettings>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.settingsWaiters.delete(threadId);
				reject(new ParadisCodexControlError('timeout', 'Codexから設定変更の確認通知が届きませんでした'));
			}, SETTINGS_CONFIRM_TIMEOUT_MS);
			this.settingsWaiters.set(threadId, { model, effort, resolve, reject, timer });
		});
		try {
			await this.request('thread/settings/update', { threadId, model, effort });
			return await confirmation;
		} catch (error) {
			this.rejectSettingsWaiter(threadId, error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	/** SubAgent詳細用に子threadのturn/itemを上限付きで読み出す。 */
	async readThreadMessages(threadId: string): Promise<readonly IParadisCodexThreadMessage[]> {
		if (!this.enabled || !this.initialized) {
			throw new ParadisCodexControlError('unavailable', 'Codex app-serverへ接続していません');
		}
		const result = record(await this.request('thread/read', { threadId, includeTurns: true }));
		const thread = record(result?.['thread']) ?? result;
		const turns = Array.isArray(thread?.['turns']) ? thread['turns'] : [];
		const messages: IParadisCodexThreadMessage[] = [];
		for (const turn of turns.slice(-100)) {
			const items = Array.isArray(record(turn)?.['items']) ? record(turn)?.['items'] as unknown[] : [];
			for (const rawItem of items) {
				const item = record(rawItem);
				const type = stringValue(item?.['type']);
				const parts = [
					threadMessageText(item?.['text']), threadMessageText(item?.['content']), threadMessageText(item?.['summary']),
					threadMessageText(item?.['query']), threadMessageText(item?.['command']), threadMessageText(item?.['aggregatedOutput']),
					threadMessageText(item?.['output']), threadMessageText(item?.['prompt']), threadMessageText(item?.['error']),
				];
				for (const field of ['changes', 'arguments', 'result'] as const) {
					const value = item?.[field];
					if (value !== undefined) {
						try { parts.push(threadMessageText(JSON.stringify(value))); } catch { /* 循環参照等は表示しない */ }
					}
				}
				if (item?.['action'] !== undefined) {
					try { parts.push(threadMessageText(JSON.stringify(item['action']))); } catch { /* 表示しない */ }
				}
				const text = parts.filter((part, index, values): part is string => part !== undefined && values.indexOf(part) === index).join('\n');
				if (text === undefined || text.trim().length === 0) { continue; }
				const role: IParadisCodexThreadMessage['role'] = type === 'userMessage' ? 'user' : type === 'agentMessage' ? 'assistant' : 'tool';
				const kind: IParadisCodexThreadMessage['kind'] = type === 'reasoning' ? 'thinking' : role === 'tool' ? 'tool' : 'text';
				messages.push({ role, kind, text: truncateCodexLiveText(text) });
			}
		}
		return messages.slice(-200);
	}

	override dispose(): void {
		this.enabled = false;
		this.stop();
		super.dispose();
	}

	private async ensureConnected(): Promise<void> {
		if (!this.enabled || this.socket !== undefined) {
			return;
		}
		if (!(await this.pathExists(this.socketPath)) || !this.enabled || this.socket !== undefined) {
			this.scheduleRetry();
			return;
		}
		if (this.wantedThreads.size === 0) {
			return;
		}
		let endpointPort: number | undefined;
		if (this.endpointTarget !== undefined) {
			endpointPort = await readCodexEndpointPort(this.socketPath);
			if (endpointPort === undefined || !this.enabled || this.socket !== undefined) {
				this.scheduleRetry();
				return;
			}
		}
		try {
			const generation = ++this.connectionGeneration;
			const socket = this.endpointTarget !== undefined && endpointPort !== undefined
				? new WebSocket(`ws://127.0.0.1:${endpointPort}/`, {
					headers: { authorization: `Bearer ${this.endpointTarget.paneToken}` },
					handshakeTimeout: 3_000,
					maxPayload: MAX_RPC_PAYLOAD_BYTES,
					perMessageDeflate: false,
				})
				: new WebSocket('ws://localhost/rpc', {
					createConnection: createUnixWebSocketConnection(this.socketPath),
					handshakeTimeout: 3_000,
					maxPayload: MAX_RPC_PAYLOAD_BYTES,
					// tokio-tungsteniteのUnix socket acceptorはpermessage-deflateを交渉しない。
					perMessageDeflate: false,
				});
			this.socket = socket;
			socket.on('open', () => void this.initialize(generation));
			socket.on('message', data => this.handleMessage(data));
			socket.on('error', error => this.logService.trace('[paradisCodexLive] daemon socket error', String(error)));
			socket.on('close', () => {
				if (this.socket === socket) {
					this.resetConnection(new ParadisCodexControlError('unavailable', 'Codex app-serverとの接続が切れました'));
					this.scheduleRetry();
				}
			});
		} catch (error) {
			this.logService.trace('[paradisCodexLive] daemon connection failed', String(error));
			this.resetConnection(new Error(String(error)));
			this.scheduleRetry();
		}
	}

	private async initialize(generation: number): Promise<void> {
		try {
			await this.request('initialize', {
				clientInfo: { name: 'para-code-mobile', title: 'Para Code Mobile', version: '1' },
				capabilities: { experimentalApi: true, requestAttestation: false },
			}, true);
			if (generation !== this.connectionGeneration || this.socket?.readyState !== WebSocket.OPEN) {
				return;
			}
			this.initialized = true;
			this.sendNotification('initialized');
			await this.refreshLoadedThreads();
		} catch (error) {
			this.logService.warn(`[paradisCodexLive] initialize failed: ${error instanceof Error ? error.message : String(error)}`);
			this.socket?.close();
		}
	}

	private handleMessage(data: RawData): void {
		let message: IJsonRpcMessage;
		try {
			const parsed = JSON.parse(rawDataToString(data));
			if (record(parsed) === undefined) {
				return;
			}
			message = parsed as IJsonRpcMessage;
		} catch {
			return;
		}
		if (typeof message.method === 'string' && message.id !== undefined) {
			// 双方向JSON-RPCのserver request。承認要求は表示用に観測するが、ここでは
			// 自動応答しない。モバイルでユーザーが明示的に選択した時だけanswerApprovalが
			// 同じrequest idへ応答するため、TUIの承認画面ともfirst-response-winsで共存する。
			const approval = parseCodexApprovalRequest(message);
			if (approval !== undefined && this.wantedThreads.has(approval.threadId)) {
				const key = requestIdKey(approval.threadId, approval.requestId);
				this.pendingApprovals.set(key, approval);
				this.onEvent({
					threadId: approval.threadId, method: message.method, params: record(message.params)!,
					requestId: approval.requestId, approval: approval.interaction,
				});
			}
			return;
		}
		if (typeof message.id === 'number') {
			this.handleResponse(message.id, message.result, message.error);
			return;
		}
		if (typeof message.method !== 'string') {
			return;
		}
		const params = record(message.params);
		const threadId = stringValue(params?.['threadId']);
		if (threadId === undefined || params === undefined) {
			return;
		}
		if (message.method === 'thread/settings/updated') {
			this.handleSettingsUpdated(threadId, params);
		} else if (message.method === 'serverRequest/resolved') {
			const requestId = requestIdValue(params['requestId']);
			if (requestId !== undefined) {
				const key = requestIdKey(threadId, requestId);
				const approval = this.pendingApprovals.get(key);
				this.pendingApprovals.delete(key);
				this.resolvingApprovals.delete(key);
				if (approval !== undefined && this.wantedThreads.has(threadId)) {
					this.onEvent({ threadId, method: message.method, params, requestId, approval: approval.interaction });
					return;
				}
			}
		} else if (message.method === 'thread/closed') {
			this.clearThreadApprovals(threadId);
			this.loadedThreads.delete(threadId);
			this.subscribedThreads.delete(threadId);
			this.threadSettings.delete(threadId);
			this.scheduleLoadedPoll();
		}
		if (this.wantedThreads.has(threadId)) {
			this.onEvent({ threadId, method: message.method, params });
		}
	}

	private handleResponse(id: number, result: unknown, error: unknown): void {
		const pending = this.pendingRequests.get(id);
		if (pending === undefined) {
			return;
		}
		this.pendingRequests.delete(id);
		clearTimeout(pending.timer);
		if (error !== undefined && error !== null) {
			const rpcError = record(error);
			const detail = stringValue(rpcError?.['message']) ?? (typeof rpcError?.['code'] === 'number' ? String(rpcError['code']) : 'unknown error');
			pending.reject(new ParadisCodexControlError('rpc-error', `${pending.method}: ${detail}`));
		} else {
			pending.resolve(result);
		}
	}

	private async refreshLoadedThreads(): Promise<void> {
		if (!this.enabled || !this.initialized || this.loadedRefreshInFlight || this.socket?.readyState !== WebSocket.OPEN) {
			return;
		}
		this.loadedRefreshInFlight = true;
		try {
			const result = record(await this.request('thread/loaded/list', {}));
			const data = result?.['data'];
			if (!Array.isArray(data)) {
				throw new Error('thread/loaded/list returned invalid data');
			}
			this.loadedThreads.clear();
			for (const value of data) {
				const threadId = stringValue(value);
				if (threadId !== undefined) {
					this.loadedThreads.add(threadId);
				}
			}
			for (const threadId of this.wantedThreads) {
				if (this.loadedThreads.has(threadId)) {
					void this.resumeLoadedThread(threadId);
				}
			}
		} catch (error) {
			this.logService.trace('[paradisCodexLive] thread/loaded/list failed', String(error));
		} finally {
			this.loadedRefreshInFlight = false;
			if ([...this.wantedThreads].some(threadId => !this.subscribedThreads.has(threadId))) {
				this.scheduleLoadedPoll();
			}
		}
	}

	private async resumeLoadedThread(threadId: string): Promise<void> {
		if (!this.wantedThreads.has(threadId) || !this.loadedThreads.has(threadId) || this.subscribedThreads.has(threadId) || this.pendingThreads.has(threadId)) {
			return;
		}
		this.pendingThreads.add(threadId);
		try {
			const result = record(await this.request('thread/resume', { threadId, excludeTurns: true }));
			if (!this.wantedThreads.has(threadId) || !this.loadedThreads.has(threadId)) {
				await this.unsubscribeThread(threadId);
				return;
			}
			this.subscribedThreads.add(threadId);
			const model = stringValue(result?.['model']);
			const effort = stringValue(result?.['reasoningEffort']);
			if (model !== undefined) {
				this.threadSettings.set(threadId, { model, ...(effort !== undefined ? { effort } : {}) });
			}
		} catch (error) {
			this.logService.trace(`[paradisCodexLive] thread/resume failed for ${threadId}`, String(error));
		} finally {
			this.pendingThreads.delete(threadId);
		}
	}

	private async unsubscribeThread(threadId: string): Promise<void> {
		if (!this.initialized || this.socket?.readyState !== WebSocket.OPEN) {
			this.subscribedThreads.delete(threadId);
			return;
		}
		try {
			await this.request('thread/unsubscribe', { threadId });
		} catch {
			// 接続終了時にも同じ掃除を行うため、unsubscribe失敗はベストエフォート。
		} finally {
			this.subscribedThreads.delete(threadId);
			if (this.wantedThreads.has(threadId)) {
				this.scheduleLoadedPoll();
			}
		}
	}

	private handleSettingsUpdated(threadId: string, params: Record<string, unknown>): void {
		const settings = record(params['threadSettings']);
		const model = stringValue(settings?.['model']);
		const effort = stringValue(settings?.['effort']);
		if (model === undefined) {
			return;
		}
		const effective = { model, ...(effort !== undefined ? { effort } : {}) };
		this.threadSettings.set(threadId, effective);
		const waiter = this.settingsWaiters.get(threadId);
		if (waiter !== undefined && waiter.model === model && waiter.effort === effort) {
			this.settingsWaiters.delete(threadId);
			clearTimeout(waiter.timer);
			waiter.resolve(effective);
		}
	}

	private parseModel(value: unknown): IParadisCodexModelOption | undefined {
		const raw = record(value);
		const id = stringValue(raw?.['id']);
		const model = stringValue(raw?.['model']);
		const displayName = stringValue(raw?.['displayName'], 200);
		const description = typeof raw?.['description'] === 'string' ? raw['description'].slice(0, 1_000) : '';
		const defaultEffort = stringValue(raw?.['defaultReasoningEffort'], 100);
		const rawEfforts = raw?.['supportedReasoningEfforts'];
		if (id === undefined || model === undefined || displayName === undefined || defaultEffort === undefined || !Array.isArray(rawEfforts)) {
			return undefined;
		}
		const efforts: IParadisCodexReasoningEffort[] = [];
		for (const value of rawEfforts.slice(0, 16)) {
			const effort = record(value);
			const effortValue = stringValue(effort?.['reasoningEffort'], 100);
			if (effortValue !== undefined && !efforts.some(option => option.value === effortValue)) {
				efforts.push({
					value: effortValue,
					description: typeof effort?.['description'] === 'string' ? effort['description'].slice(0, 500) : '',
				});
			}
		}
		return efforts.length > 0 ? {
			id, model, displayName, description, efforts, defaultEffort, isDefault: raw?.['isDefault'] === true,
		} : undefined;
	}

	private async awaitThreadReady(threadId: string): Promise<void> {
		if (!this.enabled) {
			throw new ParadisCodexControlError('disabled', 'Codex app-server連携が無効です');
		}
		if (!this.wantedThreads.has(threadId)) {
			throw new ParadisCodexControlError('not-loaded', 'このCodexセッションを確認できません');
		}
		void this.ensureConnected();
		void this.refreshLoadedThreads();
		const deadline = Date.now() + REQUEST_TIMEOUT_MS;
		while (!this.isThreadReady(threadId) && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		if (!this.isThreadReady(threadId)) {
			throw new ParadisCodexControlError('not-loaded', 'このセッションのCodex app-serverへ接続できません。Para CodeのターミナルでCodexを起動し直してください');
		}
	}

	private request(method: string, params?: Record<string, unknown>, allowBeforeInitialized: boolean = false): Promise<unknown> {
		if (this.socket?.readyState !== WebSocket.OPEN || (!allowBeforeInitialized && !this.initialized)) {
			return Promise.reject(new ParadisCodexControlError('unavailable', 'Codex app-serverへ接続していません'));
		}
		const id = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new ParadisCodexControlError('timeout', `${method}がタイムアウトしました`));
			}, REQUEST_TIMEOUT_MS);
			this.pendingRequests.set(id, { method, resolve, reject, timer });
			this.socket?.send(JSON.stringify({ method, id, ...(params !== undefined ? { params } : {}) }));
		});
	}

	private sendNotification(method: string): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify({ method }));
		}
	}

	private rejectSettingsWaiter(threadId: string, error: Error): void {
		const waiter = this.settingsWaiters.get(threadId);
		if (waiter !== undefined) {
			this.settingsWaiters.delete(threadId);
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
	}

	private scheduleLoadedPoll(): void {
		if (!this.enabled || this.loadedPollTimer !== undefined) {
			return;
		}
		this.loadedPollTimer = setTimeout(() => {
			this.loadedPollTimer = undefined;
			void this.refreshLoadedThreads();
		}, LOADED_POLL_INTERVAL_MS);
	}

	private scheduleRetry(): void {
		if (!this.enabled || this.retryTimer !== undefined) {
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.ensureConnected();
		}, RETRY_INTERVAL_MS);
	}

	private resetConnection(error: Error): void {
		this.connectionGeneration++;
		this.socket = undefined;
		this.initialized = false;
		this.loadedRefreshInFlight = false;
		this.catalogCache = undefined;
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
		for (const threadId of [...this.settingsWaiters.keys()]) {
			this.rejectSettingsWaiter(threadId, error);
		}
		for (const approval of this.pendingApprovals.values()) {
			if (this.wantedThreads.has(approval.threadId)) {
				this.onEvent({
					threadId: approval.threadId, method: 'serverRequest/resolved',
					params: { threadId: approval.threadId, requestId: approval.requestId },
					requestId: approval.requestId, approval: approval.interaction,
				});
			}
		}
		this.pendingApprovals.clear();
		this.resolvingApprovals.clear();
		this.loadedThreads.clear();
		this.pendingThreads.clear();
		this.subscribedThreads.clear();
		this.threadSettings.clear();
	}

	private stop(): void {
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		if (this.loadedPollTimer !== undefined) {
			clearTimeout(this.loadedPollTimer);
			this.loadedPollTimer = undefined;
		}
		const socket = this.socket;
		this.resetConnection(new ParadisCodexControlError('disabled', 'Codex app-server連携が停止しました'));
		if (socket !== undefined) {
			socket.removeAllListeners();
			try {
				socket.close();
			} catch {
				socket.terminate();
			}
		}
	}

	private async pathExists(path: string): Promise<boolean> {
		return pathExists(path);
	}

	private clearThreadApprovals(threadId: string): void {
		for (const [key, approval] of this.pendingApprovals) {
			if (approval.threadId !== threadId) { continue; }
			this.pendingApprovals.delete(key);
			this.resolvingApprovals.delete(key);
			this.onEvent({
				threadId, method: 'serverRequest/resolved',
				params: { threadId, requestId: approval.requestId }, requestId: approval.requestId, approval: approval.interaction,
			});
		}
	}
}

/**
 * Mobileで追跡するCodex threadと、そのpane専用app-serverへの接続先。
 * `socketPath` はmacOS/LinuxではUnix socketパス、Windowsではランチャーが書く
 * endpointファイル（`pcx/<token>.endpoint.json`）のパス。
 */
export interface IParadisCodexThreadTarget {
	readonly threadId: string;
	readonly socketPath: string;
}

/**
 * pane socket単位で必要な接続だけを保持し、thread操作を所有socketへルーティングする。
 * app-serverプロセスは起動せず、ターミナルでCodexが動作している間だけ再接続する。
 */
export class ParadisCodexLiveClient extends Disposable {
	private enabled = false;
	private readonly connections = new Map<string, ParadisCodexServerConnection>();
	private readonly threadConnections = new Map<string, ParadisCodexServerConnection>();

	constructor(
		private readonly onEvent: (event: IParadisCodexDaemonEvent) => void,
		private readonly logService: ILogService,
	) {
		super();
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		for (const connection of this.connections.values()) {
			connection.setEnabled(enabled);
		}
	}

	setThreads(targets: readonly IParadisCodexThreadTarget[]): void {
		const targetByThread = new Map<string, string>();
		for (const target of targets) {
			if (target.threadId.length > 0 && target.socketPath.length > 0) {
				targetByThread.set(target.threadId, target.socketPath);
			}
		}

		const threadsBySocket = new Map<string, string[]>();
		for (const [threadId, socketPath] of targetByThread) {
			const threads = threadsBySocket.get(socketPath) ?? [];
			threads.push(threadId);
			threadsBySocket.set(socketPath, threads);
		}

		for (const socketPath of threadsBySocket.keys()) {
			if (this.connections.has(socketPath)) {
				continue;
			}
			const connection = new ParadisCodexServerConnection(event => {
				const currentConnection = this.connections.get(socketPath);
				if (currentConnection !== undefined && this.threadConnections.get(event.threadId) === currentConnection) {
					this.onEvent(event);
				}
			}, this.logService, socketPath);
			this.connections.set(socketPath, connection);
		}

		this.threadConnections.clear();
		for (const [threadId, socketPath] of targetByThread) {
			const connection = this.connections.get(socketPath);
			if (connection !== undefined) {
				this.threadConnections.set(threadId, connection);
			}
		}

		for (const [socketPath, connection] of [...this.connections]) {
			const threads = threadsBySocket.get(socketPath);
			if (threads === undefined) {
				connection.dispose();
				this.connections.delete(socketPath);
				continue;
			}
			connection.setThreads(threads);
			connection.setEnabled(this.enabled);
		}
	}

	isThreadReady(threadId: string): boolean {
		return this.threadConnections.get(threadId)?.isThreadReady(threadId) === true;
	}

	hasPendingApproval(threadId: string, interactionId: string): boolean {
		return this.threadConnections.get(threadId)?.hasPendingApproval(threadId, interactionId) === true;
	}

	answerApproval(threadId: string, interactionId: string, choiceId: string): Promise<void> {
		return this.connectionFor(threadId).answerApproval(threadId, interactionId, choiceId);
	}

	listModels(threadId: string): Promise<readonly IParadisCodexModelOption[]> {
		return this.connectionFor(threadId).listModels(threadId);
	}

	updateThreadSettings(threadId: string, model: string, effort: string): Promise<IParadisCodexThreadSettings> {
		return this.connectionFor(threadId).updateThreadSettings(threadId, model, effort);
	}

	readThreadMessages(threadId: string, ownerThreadId: string = threadId): Promise<readonly IParadisCodexThreadMessage[]> {
		return this.connectionFor(ownerThreadId).readThreadMessages(threadId);
	}

	override dispose(): void {
		this.enabled = false;
		this.threadConnections.clear();
		for (const connection of this.connections.values()) {
			connection.dispose();
		}
		this.connections.clear();
		super.dispose();
	}

	private connectionFor(threadId: string): ParadisCodexServerConnection {
		const connection = this.threadConnections.get(threadId);
		if (connection === undefined) {
			throw new ParadisCodexControlError('not-loaded', 'このCodexセッションを確認できません');
		}
		return connection;
	}
}

/** daemon deltaの内部バッファ上限を共有する。 */
export function truncateCodexLiveText(text: string): string {
	return text.length > MAX_LIVE_TEXT_LENGTH ? `…${text.slice(-(MAX_LIVE_TEXT_LENGTH - 1))}` : text;
}
