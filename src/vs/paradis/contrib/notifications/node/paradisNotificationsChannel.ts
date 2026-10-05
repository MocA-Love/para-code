/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench ⇔ shared process 間の通知サウンド操作用IPCチャネル。paradisAgentBrowserChannel.ts と
// 同じ薄いディスパッチャ方式（switch文でサービスメソッドへ委譲するだけ）。

import { Event } from '../../../../base/common/event.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import { paradisNormalizeElevenLabsRules } from '../common/paradisElevenLabs.js';
import { ParadisNotificationsService } from './paradisNotificationsService.js';

export class ParadisNotificationsChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisNotificationsService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		switch (event) {
			case 'onAivisPaused': return this.service.onAivisPaused as Event<T>;
			// 音声クリップは同一 shared process のモバイルリレーが直接購読する。
			// renderer へ最大8MiBのMP3をIPCで流す口はここでは開けない。
			default:
				throw new Error(`Event not found: ${event}`);
		}
	}

	call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
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
			case 'fetchAudio': return this.service.fetchAudio(String(args[0])) as Promise<T>;
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
			case 'playElevenLabs': return this.service.playElevenLabs(args[0] as Parameters<ParadisNotificationsService['playElevenLabs']>[0]) as Promise<T>;
			case 'listElevenLabsVoices': return this.service.elevenLabs.listVoices(String(args[0])) as Promise<T>;
			case 'listElevenLabsModels': return this.service.elevenLabs.listModels(String(args[0])) as Promise<T>;
			// args[2]（任意）: 直近だけの内訳を作る日数（モバイルの 7 日）
			case 'getElevenLabsUsage': return this.service.elevenLabs.getUsage(String(args[0]), Number(args[1]) || 30, typeof args[2] === 'number' && Number.isFinite(args[2]) ? args[2] : undefined) as Promise<T>;
			case 'getElevenLabsSubscription': return this.service.elevenLabs.getSubscription(String(args[0])) as Promise<T>;
			case 'listElevenLabsDictionaries': return this.service.elevenLabs.listDictionaries(String(args[0])) as Promise<T>;
			case 'getElevenLabsDictionary': return this.service.elevenLabs.getDictionary(String(args[0]), String(args[1])) as Promise<T>;
			case 'createElevenLabsDictionary': return this.service.elevenLabs.createDictionary(String(args[0]), String(args[1]), String(args[2] ?? ''), paradisNormalizeElevenLabsRules(args[3])) as Promise<T>;
			case 'setElevenLabsDictionaryRules': return this.service.elevenLabs.setDictionaryRules(String(args[0]), String(args[1]), paradisNormalizeElevenLabsRules(args[2])) as Promise<T>;
			case 'archiveElevenLabsDictionary': return this.service.elevenLabs.archiveDictionary(String(args[0]), String(args[1])) as Promise<T>;
			case 'downloadElevenLabsDictionary': return this.service.elevenLabs.downloadDictionary(String(args[0]), String(args[1])) as Promise<T>;
			case 'notifyAudio': { this.service.notifyAudio(args[0] as Parameters<ParadisNotificationsService['notifyAudio']>[0]); return Promise.resolve(undefined as T); }
			case 'resumeAivis': { this.service.resumeAivis(); return Promise.resolve(undefined as T); }
			// 音声入力中は読み上げを止める。止めるかどうかはウィンドウ（接続）ごとに持つ。
			case 'setDictationActive': { this.service.setDictationActive(ctx, args[0] === true); return Promise.resolve(undefined as T); }

			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisNotifications(server: IPCServer<string>, logService: ILogService, configurationService?: IConfigurationService, args?: NativeParsedArgs): ParadisNotificationsService {
	// 手元の aivis-mcp（`--ingest`）・ssh はログインシェル由来の環境で起こす。agentBrowser とこの 1 本を共有する
	const cachedShellEnv = configurationService && args
		? new ParadisCachedShellEnv(logService, 'ParadisVoice', createParadisShellEnvResolver(logService, configurationService, args), Date.now, reportParadisShellEnvDiagnosticError)
		: undefined;
	const service = new ParadisNotificationsService(logService, cachedShellEnv);
	server.registerChannel(PARADIS_NOTIFICATIONS_CHANNEL, new ParadisNotificationsChannel(service));
	service.trackClientDisconnects(
		Event.map(server.onDidRemoveConnection, connection => connection.ctx),
		client => server.connections.some(connection => connection.ctx === client),
	);
	return service;
}
