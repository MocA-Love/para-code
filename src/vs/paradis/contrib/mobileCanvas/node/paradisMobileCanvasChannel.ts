/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench（アタッチUI）⇔ shared process（アタッチ台帳）間のIPCチャネルと、
// shared process への登録エントリ。

import { Event } from '../../../../base/common/event.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_MOBILE_CANVAS_CHANNEL } from '../common/paradisMobileCanvas.js';
import { ParadisMobileCanvasHostClient } from './paradisMobileCanvasHostClient.js';
import { ParadisMobileCanvasService } from './paradisMobileCanvasService.js';

export class ParadisMobileCanvasChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisMobileCanvasService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'getSnapshot':
				return this.service.getSnapshot() as Promise<T>;
			case 'attach': {
				const request = requireObject(arg);
				return this.service.attach(
					requireString(request, 'paneToken'),
					requireString(request, 'deviceId'),
					optionalString(request, 'stateKey'),
				) as Promise<T>;
			}
			case 'detach': {
				const request = requireObject(arg);
				this.service.detach(requireString(request, 'paneToken'));
				return Promise.resolve(undefined as T);
			}
			case 'releaseScope': {
				const request = requireObject(arg);
				this.service.releaseScope(requireString(request, 'stateKey'));
				return Promise.resolve(undefined as T);
			}
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}
}

/**
 * shared process で Mobile Canvas 連携を立ち上げる。
 *
 * `registerToolProvider` には ParadisAgentBrowserService の同名メソッドを渡す。こうすることで
 * モバイル用ツールが既存のMCPエンドポイント（エージェントCLIが既に登録している para-browser）へ
 * 相乗りし、ユーザー側のMCP設定追加が不要になる。
 */
export function registerParadisMobileCanvas(
	server: IPCServer<string>,
	builtinExtensionsPath: string,
	logService: ILogService,
	registerToolProvider: (provider: ParadisMobileCanvasService) => void,
): ParadisMobileCanvasService {
	const hostClient = new ParadisMobileCanvasHostClient(builtinExtensionsPath, logService);
	const service = new ParadisMobileCanvasService(hostClient, logService);
	server.registerChannel(PARADIS_MOBILE_CANVAS_CHANNEL, new ParadisMobileCanvasChannel(service));
	registerToolProvider(service);
	return service;
}

function requireObject(arg: unknown): Record<string, unknown> {
	if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
		throw new Error('Protocol error: expected an object argument.');
	}
	return arg as Record<string, unknown>;
}

function requireString(request: Record<string, unknown>, name: string): string {
	const value = request[name];
	if (typeof value !== 'string' || !value) {
		throw new Error(`Protocol error: "${name}" must be a non-empty string.`);
	}
	return value;
}

function optionalString(request: Record<string, unknown>, name: string): string | undefined {
	const value = request[name];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string' || !value) {
		throw new Error(`Protocol error: "${name}" must be a non-empty string when present.`);
	}
	return value;
}
