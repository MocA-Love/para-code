/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench ⇔ shared process 間の通知サウンド操作用IPCチャネル。paradisAgentBrowserChannel.ts と
// 同じ薄いディスパッチャ方式（switch文でサービスメソッドへ委譲するだけ）。

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import { ParadisNotificationsService } from './paradisNotificationsService.js';

export class ParadisNotificationsChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisNotificationsService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'getCustomRingtoneInfo': return this.service.getCustomRingtoneInfo() as Promise<T>;
			case 'getCustomEditState': return this.service.getCustomEditState() as Promise<T>;
			case 'importCustomAudio': return this.service.importCustomAudio(String(args[0])) as Promise<T>;
			case 'deleteCustomAudio': return this.service.deleteCustomAudio() as Promise<T>;
			case 'renameCustomAudio': return this.service.renameCustomAudio(String(args[0])) as Promise<T>;
			case 'readCustomAudioFile': return this.service.readCustomAudioFile() as Promise<T>;

			case 'checkYtDlp': return this.service.checkYtDlp() as Promise<T>;
			case 'installYtDlp': return this.service.installYtDlp(String(args[0])) as Promise<T>;
			case 'getInstallLog': return this.service.getInstallLog(String(args[0]), Number(args[1]) || 0) as Promise<T>;
			case 'downloadYouTubeAudio': return this.service.downloadYouTubeAudio(String(args[0])) as Promise<T>;
			case 'readTempAudioFile': return this.service.readTempAudioFile(String(args[0])) as Promise<T>;
			case 'cleanupTempAudio': return this.service.cleanupTempAudio(String(args[0])) as Promise<T>;
			case 'renderClip': return this.service.renderClip(args[0] as Parameters<ParadisNotificationsService['renderClip']>[0]) as Promise<T>;

			case 'getAivisModel': return this.service.getAivisModel(String(args[0]), String(args[1])) as Promise<T>;
			case 'listAivisDictionaries': return this.service.listAivisDictionaries(String(args[0])) as Promise<T>;
			case 'getAivisDictionary': return this.service.getAivisDictionary(String(args[0]), String(args[1])) as Promise<T>;
			case 'createAivisDictionary': return this.service.createAivisDictionary(String(args[0]), String(args[1]), String(args[2])) as Promise<T>;
			case 'updateAivisDictionary': return this.service.updateAivisDictionary(String(args[0]), String(args[1]), String(args[2]), String(args[3]), args[4] as Parameters<ParadisNotificationsService['updateAivisDictionary']>[4]) as Promise<T>;
			case 'deleteAivisDictionary': return this.service.deleteAivisDictionary(String(args[0]), String(args[1])) as Promise<T>;
			case 'exportAivisDictionary': return this.service.exportAivisDictionary(String(args[0]), String(args[1])) as Promise<T>;
			case 'importAivisDictionary': return this.service.importAivisDictionary(String(args[0]), String(args[1]), args[2] as Record<string, unknown>, Boolean(args[3])) as Promise<T>;
			case 'getAivisUsageDaily': return this.service.getAivisUsageDaily(String(args[0]), String(args[1]), String(args[2])) as Promise<T>;
			case 'getAivisMe': return this.service.getAivisMe(String(args[0])) as Promise<T>;
			case 'playAivis': return this.service.playAivis(args[0] as Parameters<ParadisNotificationsService['playAivis']>[0]) as Promise<T>;

			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisNotifications(server: IPCServer<string>, logService: ILogService): IDisposable {
	const service = new ParadisNotificationsService(logService);
	server.registerChannel(PARADIS_NOTIFICATIONS_CHANNEL, new ParadisNotificationsChannel(service));
	return service;
}
