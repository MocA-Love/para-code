/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench ⇔ shared process 間のバインディング操作用IPCチャネル。
// ctx（`window:<windowId>`）は接続ごとにIPC層が付与するため、workbench側から
// ウィンドウ識別子を明示的に送る必要はない（PlaywrightChannelと同じctx空間を共有する）。

import { Event } from '../../../../base/common/event.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisBindingTicketRequest, IParadisMcpSetupRequest, IParadisPrepareBindRequest, PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisPlaywrightInvoker, ParadisAgentBrowserService } from './paradisAgentBrowserService.js';
import { IParadisLocalVoiceOutput } from '../../notifications/common/paradisVoiceIngest.js';
import { ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';

export class ParadisAgentBrowserChannel implements IServerChannel<string> {

	constructor(
		private readonly service: ParadisAgentBrowserService,
		private readonly rendererConnection?: object,
	) { }

	listen<T>(ctx: string, event: string, arg?: unknown): Event<T> {
		// 接続先の戻りトンネルの番号は張り直しのたびに変わる。定期の見直しで気付くのを待つと、
		// その間の通知が届く先を失うので、変わった時点でウィンドウ側へ知らせる
		if (event === 'remoteAgentTunnelPort') {
			// ここで投げてはいけない。ChannelServer の購読受付（onEventListen）は call と違って
			// try/catch されておらず、例外はメッセージ処理ループを抜けて onUnexpectedError 送りになる。
			// reload 直後など、まだ現行の接続として認められていない間に購読が来ることは普通にあるので、
			// 何も流れない Event を返して黙って空振りさせる（次の購読でやり直せる）
			if (this.rendererConnection === undefined
				|| !this.service.isCurrentRendererConnection(ctx, this.rendererConnection)
				|| !Array.isArray(arg) || arg.length !== 1 || typeof arg[0] !== 'string') {
				return Event.None;
			}
			return this.service.onDidChangeRemoteAgentTunnelPort(arg[0]) as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
		if (this.rendererConnection === undefined) {
			if (command !== 'getGatewayEndpoint') {
				throw protocolError();
			}
			requireArgs(arg, 0);
			return this.service.getGatewayEndpoint() as Promise<T>;
		}
		if (!this.service.isCurrentRendererConnection(ctx, this.rendererConnection)) {
			throw protocolError();
		}
		switch (command) {
			case 'syncBindingAuthority': {
				const args = requireArgs(arg, 1);
				return this.service.syncBindingAuthority(this.rendererConnection, args[0]) as Promise<T>;
			}
			case 'prepareBind': {
				const args = requireArgs(arg, 1);
				return this.service.prepareBind(this.rendererConnection, requirePrepareBindRequest(args[0])) as Promise<T>;
			}
			case 'commitBind': {
				const args = requireArgs(arg, 1);
				return this.service.commitBind(this.rendererConnection, requireBindingTicketRequest(args[0])) as Promise<T>;
			}
			case 'abortBind': {
				const args = requireArgs(arg, 1);
				return this.service.abortBind(this.rendererConnection, requireBindingTicketRequest(args[0])) as Promise<T>;
			}
			case 'unbind': {
				const args = requireArgs(arg, 1);
				return this.service.unbind(this.rendererConnection, requireToken(args[0])) as Promise<T>;
			}
			case 'unbindIfCurrent': {
				const args = requireArgs(arg, 2);
				return this.service.unbindIfCurrent(
					this.rendererConnection,
					requireToken(args[0]),
					requirePositiveSafeInteger(args[1]),
				) as Promise<T>;
			}
			case 'listBindings':
				requireArgs(arg, 0);
				return this.service.listBindings(this.rendererConnection) as Promise<T>;
			// エージェントが開いたタブを、共有を付け替えずに tab_id で使う許可
			case 'grantAgentTab': {
				const args = requireArgs(arg, 1);
				return this.service.grantAgentTab(this.rendererConnection, requirePrepareBindRequest(args[0])) as Promise<T>;
			}
			case 'revokeAgentTab': {
				const args = requireArgs(arg, 2);
				return this.service.revokeAgentTab(this.rendererConnection, requireToken(args[0]), requireToken(args[1])) as Promise<T>;
			}
			case 'listAgentTabGrants':
				requireArgs(arg, 0);
				return this.service.listAgentTabGrants(this.rendererConnection) as Promise<T>;
			case 'listSeenTokens':
				requireArgs(arg, 0);
				return this.service.listSeenTokens(this.rendererConnection) as Promise<T>;
			case 'listPaneStatuses':
				requireArgs(arg, 0);
				return this.service.listPaneStatuses(this.rendererConnection) as Promise<T>;
			case 'listAgentHookTokens':
				requireArgs(arg, 0);
				return this.service.listAgentHookTokens(this.rendererConnection) as Promise<T>;
			case 'listAgentStatusSnapshot':
				requireArgs(arg, 0);
				return this.service.listAgentStatusSnapshot(this.rendererConnection) as Promise<T>;
			case 'notifyTerminalExit': {
				const args = requireArgs(arg, 1);
				return this.service.notifyTerminalExit(this.rendererConnection, requireToken(args[0])) as Promise<T>;
			}
			case 'acknowledgePaneStatus': {
				const args = requireArgs(arg, 1);
				return this.service.acknowledgePaneStatus(this.rendererConnection, requireToken(args[0])) as Promise<T>;
			}
			// 控えから流し直した許可要求・質問が、画面に今も出ていると確かめた（W2-20）
			case 'confirmReplayedPrompt': {
				const args = requireArgs(arg, 1);
				return this.service.confirmReplayedPrompt(this.rendererConnection, requireToken(args[0])) as Promise<T>;
			}
			// ペインの Claude Code が OSC 7501 で知らせた状態（hook の届かないペインの補助）
			case 'notePaneProgramStatus': {
				const args = requireArgs(arg, 2);
				return this.service.notePaneProgramStatus(this.rendererConnection, requireToken(args[0]), args[1]) as Promise<T>;
			}
			// Claude Code の設定フォルダ（CLAUDE_CONFIG_DIR）。renderer の Claude Code の mod が managed 設定を探すのに使う
			case 'getClaudeConfigDir':
				requireArgs(arg, 0);
				return this.service.getClaudeConfigDir() as Promise<T>;
			case 'getVoiceIngressToken':
				requireArgs(arg, 0);
				return this.service.getVoiceIngressToken() as Promise<T>;
			case 'getGatewayEndpoint':
				requireArgs(arg, 0);
				return this.service.getGatewayEndpoint() as Promise<T>;
			// どのウィンドウの求めかは ctx で決める。同じ接続先へ何枚でも開けるので、1枚が
			// 閉じただけで畳んでしまうと、残ったウィンドウの hook が黙って死ぬ
			case 'ensureRemoteAgentTunnel': {
				const args = requireArgs(arg, 1);
				return this.service.ensureRemoteAgentTunnel(String(args[0]), ctx) as Promise<T>;
			}
			case 'getRemoteAgentTunnelPort': {
				const args = requireArgs(arg, 1);
				return this.service.getRemoteAgentTunnelPort(String(args[0])) as Promise<T>;
			}
			case 'closeRemoteAgentTunnel': {
				const args = requireArgs(arg, 1);
				return this.service.closeRemoteAgentTunnel(String(args[0]), ctx) as Promise<T>;
			}
			// 接続先を第2引数で受け、そのスクリプトへ「接続先から届いた hook」の印を焼き込ませる
			case 'getNotifyScriptContent': {
				const args = requireArgs(arg, 2);
				const remoteAuthority = typeof args[1] === 'string' ? args[1] : undefined;
				return this.service.getNotifyScriptContent(String(args[0]), remoteAuthority) as Promise<T>;
			}
			case 'markRemoteHookExecutable': {
				const args = requireArgs(arg, 2);
				return this.service.markRemoteHookExecutable(String(args[0]), String(args[1])) as Promise<T>;
			}
			case 'buildRemoteAgentHooksJson': {
				const args = requireArgs(arg, 3);
				const existingRaw = typeof args[2] === 'string' ? args[2] : undefined;
				return this.service.buildRemoteAgentHooksJson(String(args[0]), String(args[1]), existingRaw) as Promise<T>;
			}
			case 'buildRemoteAgentHooksRemovalJson': {
				const args = requireArgs(arg, 1);
				const existingRaw = typeof args[0] === 'string' ? args[0] : undefined;
				return this.service.buildRemoteAgentHooksRemovalJson(existingRaw) as Promise<T>;
			}
			case 'setupMcp': {
				const args = requireArgs(arg, 1);
				return this.service.setupMcp(requireMcpSetupRequest(args[0])) as Promise<T>;
			}
			case 'getMcpConfigStatus':
				requireArgs(arg, 0);
				return this.service.getMcpConfigStatus() as Promise<T>;
			case 'fixMcp': {
				const args = requireArgs(arg, 1);
				return this.service.fixMcp(requireMcpSetupRequest(args[0])) as Promise<T>;
			}
			case 'bind':
			case 'syncPaneShells':
			default:
				throw protocolError();
		}
	}
}

function protocolError(): Error {
	return new Error('Para Browser protocol rejected');
}

function requireArgs(value: unknown, expectedLength: number): readonly unknown[] {
	try {
		if (value === undefined && expectedLength === 0) {
			return [];
		}
		if (!Array.isArray(value) || value.length !== expectedLength) {
			throw protocolError();
		}
		const expectedKeys = new Set<PropertyKey>(['length']);
		for (let index = 0; index < expectedLength; index++) {
			expectedKeys.add(String(index));
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== expectedKeys.size || !keys.every(key => expectedKeys.has(key))) {
			throw protocolError();
		}
		const args: unknown[] = [];
		for (let index = 0; index < expectedLength; index++) {
			args.push(value[index]);
		}
		return args;
	} catch {
		throw protocolError();
	}
}

function requireToken(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
		throw protocolError();
	}
	return value;
}

function requirePositiveSafeInteger(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw protocolError();
	}
	return value;
}

function requireExactDataRecord(value: unknown, requiredKeys: readonly string[]): Readonly<Record<string, unknown>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw protocolError();
	}
	const keys = Reflect.ownKeys(value);
	if (keys.length !== requiredKeys.length
		|| !keys.every(key => typeof key === 'string' && requiredKeys.includes(key))) {
		throw protocolError();
	}
	const result: Record<string, unknown> = Object.create(null);
	for (const key of requiredKeys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined
			|| descriptor.enumerable !== true
			|| !Object.hasOwn(descriptor, 'value')
			|| descriptor.get !== undefined
			|| descriptor.set !== undefined) {
			throw protocolError();
		}
		result[key] = descriptor.value;
	}
	return result;
}

function requirePrepareBindRequest(value: unknown): IParadisPrepareBindRequest {
	try {
		const record = requireExactDataRecord(value, ['revision', 'token', 'viewId', 'pageInfo']);
		const revision = record.revision;
		const token = record.token;
		const viewId = record.viewId;
		const pageInfoRecord = requireExactDataRecord(record.pageInfo, ['url', 'title']);
		const url = pageInfoRecord.url;
		const title = pageInfoRecord.title;
		if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0
			|| typeof token !== 'string' || token.length === 0 || token.length > 200
			|| typeof viewId !== 'string' || viewId.length === 0 || viewId.length > 512
			|| typeof url !== 'string' || url.length > 16 * 1024
			|| typeof title !== 'string' || title.length > 4 * 1024) {
			throw protocolError();
		}
		return Object.freeze({
			revision,
			token,
			viewId,
			pageInfo: Object.freeze({ url, title }),
		});
	} catch {
		throw protocolError();
	}
}

function requireBindingTicketRequest(value: unknown): IParadisBindingTicketRequest {
	try {
		const record = requireExactDataRecord(value, ['ticketId']);
		const ticketId = record.ticketId;
		if (typeof ticketId !== 'string' || ticketId.length === 0 || ticketId.length > 200) {
			throw protocolError();
		}
		return Object.freeze({ ticketId });
	} catch {
		throw protocolError();
	}
}

function requireMcpSetupRequest(value: unknown): IParadisMcpSetupRequest {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw protocolError();
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 1 || keys[0] !== 'cli') {
			throw protocolError();
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, 'cli');
		if (descriptor === undefined
			|| descriptor.enumerable !== true
			|| !Object.hasOwn(descriptor, 'value')
			|| descriptor.get !== undefined
			|| descriptor.set !== undefined) {
			throw protocolError();
		}
		const cli = descriptor.value;
		if (cli !== 'claude' && cli !== 'codex') {
			throw protocolError();
		}
		return Object.freeze({ cli });
	} catch {
		throw protocolError();
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 * サービス生成・チャネル登録・ウィンドウ切断時のバインディング破棄の配線をまとめて行う。
 * 戻り値はサービス実体（IDisposable 兼 IParadisSharedPageBindings）。モバイルリレーの
 * 登録（registerParadisMobileRelay）へ共有ページバインディングとしてそのまま渡せる。
 */
export function registerParadisAgentBrowser(
	server: IPCServer<string>,
	playwrightInvoker: IParadisPlaywrightInvoker,
	userDataPath: string,
	mainProcessService: IMainProcessService,
	logService: ILogService,
	configurationService: IConfigurationService,
	args: NativeParsedArgs,
	publishMobileVoiceClip?: (audio: Uint8Array) => void,
	localVoiceOutput?: IParadisLocalVoiceOutput & { readonly shellEnv?: ParadisCachedShellEnv },
): ParadisAgentBrowserService {
	const service = new ParadisAgentBrowserService(userDataPath, playwrightInvoker, server, mainProcessService, logService, configurationService, args, publishMobileVoiceClip, localVoiceOutput);
	server.registerChannel(PARADIS_AGENT_BROWSER_CHANNEL, new ParadisAgentBrowserChannel(service));
	service.installRendererConnectionChannels(connection => new ParadisAgentBrowserChannel(service, connection));
	return service;
}
