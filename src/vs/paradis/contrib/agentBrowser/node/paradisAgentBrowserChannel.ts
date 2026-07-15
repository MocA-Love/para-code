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

export class ParadisAgentBrowserChannel implements IServerChannel<string> {

	constructor(
		private readonly service: ParadisAgentBrowserService,
		private readonly rendererConnection?: object,
	) { }

	listen<T>(_ctx: string, event: string): Event<T> {
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
			case 'listSeenTokens':
				requireArgs(arg, 0);
				return this.service.listSeenTokens(this.rendererConnection) as Promise<T>;
			case 'listPaneStatuses':
				requireArgs(arg, 0);
				return this.service.listPaneStatuses(this.rendererConnection) as Promise<T>;
			case 'listAgentHookTokens':
				requireArgs(arg, 0);
				return this.service.listAgentHookTokens(this.rendererConnection) as Promise<T>;
			case 'notifyTerminalExit': {
				const args = requireArgs(arg, 1);
				return this.service.notifyTerminalExit(this.rendererConnection, requireToken(args[0])) as Promise<T>;
			}
			case 'acknowledgePaneStatus': {
				const args = requireArgs(arg, 1);
				return this.service.acknowledgePaneStatus(this.rendererConnection, requireToken(args[0])) as Promise<T>;
			}
			case 'getGatewayEndpoint':
				requireArgs(arg, 0);
				return this.service.getGatewayEndpoint() as Promise<T>;
			case 'setupMcp': {
				const args = requireArgs(arg, 1);
				return this.service.setupMcp(requireMcpSetupRequest(args[0])) as Promise<T>;
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
): ParadisAgentBrowserService {
	const service = new ParadisAgentBrowserService(userDataPath, playwrightInvoker, server, mainProcessService, logService, configurationService, args);
	server.registerChannel(PARADIS_AGENT_BROWSER_CHANNEL, new ParadisAgentBrowserChannel(service));
	service.installRendererConnectionChannels(connection => new ParadisAgentBrowserChannel(service, connection));
	return service;
}
