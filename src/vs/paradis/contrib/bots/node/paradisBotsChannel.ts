/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のサービスを、ウィンドウ（renderer）へ出すチャネル。
//
// 通すのは、読むこと、持ち主の操作（Bot の作成・変更・削除、項目へのコメント・状態・後回し、専用フォルダの
// ファイル）、起動の依頼と報告だけ。Bot の名義の書き込み（項目の追加・書き換え）はここに無く、para-browser MCP の
// 道具（ペイントークンで Bot を見分ける）からしか呼べない。ペインと Bot の結び付けも、サービスが発行した
// 起動の番号を付けた報告でしか作れない。引数は別のプロセスから届くので、形を確かめてからサービスへ渡す。

import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ParadisChannelArgs } from '../../../common/paradisChannelArgs.js';
import { asRecord, isRecord } from '../../../common/paradisGuards.js';
import { PARADIS_BOT_TASK_TOOLS } from '../../scheduledRuns/common/paradisScheduledRuns.js';
import { PARADIS_BOT_ITEM_STATUSES } from '../common/paradisBotItems.js';
import { PARADIS_BOT_PANE_PURPOSES, ParadisBotsServiceResult } from '../common/paradisBotsApi.js';
import { ParadisBotsService } from './paradisBotsService.js';

const INVALID: ParadisBotsServiceResult<never> = { ok: false, code: 'invalid_argument', message: 'The arguments are not valid.' };

export class ParadisBotsChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisBotsService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		switch (event) {
			case 'onDidChange': return this.service.onDidChange as Event<T>;
			case 'onDidRequestStop': return this.service.onDidRequestStop as Event<T>;
			case 'onDidRequestReveal': return this.service.onDidRequestReveal as Event<T>;
			default: throw new Error(`Event not found: ${event}`);
		}
	}

	async call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		return await this.dispatch(command, ParadisChannelArgs.from(arg)) as T;
	}

	private async dispatch(command: string, args: ParadisChannelArgs): Promise<unknown> {
		const service = this.service;
		await service.ready;
		const id = args.string(0);
		switch (command) {
			case 'getSnapshot': return service.getSnapshot();

			case 'createBot': {
				const input = asRecord(args.at(0));
				const soul = args.string(1);
				return input ? service.createBot({ name: input.name, agent: input.agent, modelId: input.modelId, effortId: input.effortId, permissionId: input.permissionId, faceColor: input.faceColor, faceShape: input.faceShape }, soul) : INVALID;
			}
			case 'updateBot': {
				const patch = asRecord(args.at(1));
				return id !== undefined && patch ? service.updateBot(id, { name: patch.name, agent: patch.agent, modelId: patch.modelId, effortId: patch.effortId, permissionId: patch.permissionId, paused: patch.paused, pinned: patch.pinned, faceColor: patch.faceColor, faceShape: patch.faceShape, watchGithub: patch.watchGithub }) : INVALID;
			}
			case 'removeBot': return id !== undefined ? service.removeBot(id) : INVALID;

			case 'listItems': {
				const filter = asRecord(args.at(0));
				return service.listItems({ ...(typeof filter?.botId === 'string' ? { botId: filter.botId } : {}), ...(typeof filter?.open === 'boolean' ? { open: filter.open } : {}) });
			}
			case 'getItem': return id !== undefined ? service.getItem(id) : undefined;
			case 'ownerComment': {
				const input = asRecord(args.at(1));
				if (id === undefined || !input || typeof input.text !== 'string') {
					return INVALID;
				}
				return service.ownerComment(id, {
					text: input.text,
					...(typeof input.askEventId === 'number' && Number.isSafeInteger(input.askEventId) ? { askEventId: input.askEventId } : {}),
					...(input.plain === true ? { plain: true } : {}),
					...(input.skipped === true ? { skipped: true } : {}),
				});
			}
			case 'ownerSetStatus': {
				const to = PARADIS_BOT_ITEM_STATUSES.find(status => status === args.at(1));
				const note = args.at(2);
				return id !== undefined && to !== undefined && (note === undefined || note === null || typeof note === 'string') ? service.ownerSetStatus(id, to, typeof note === 'string' ? note : undefined) : INVALID;
			}
			case 'ownerSnooze': {
				const until = args.at(1);
				return id !== undefined && (until === undefined || until === null || typeof until === 'number') ? service.ownerSnooze(id, typeof until === 'number' ? until : undefined) : INVALID;
			}

			case 'requestLaunch': {
				const purpose = PARADIS_BOT_PANE_PURPOSES.find(candidate => candidate === (args.at(1) ?? 'chat'));
				// 定期実行の段（`{ task }`）。読めない値は断る
				const options = args.at(2);
				if (options !== undefined && options !== null) {
					const task = isRecord(options) ? PARADIS_BOT_TASK_TOOLS.find(candidate => candidate === options.task) : undefined;
					return id !== undefined && purpose === 'task' && task !== undefined ? service.requestLaunch(id, purpose, { task }) : INVALID;
				}
				return id !== undefined && purpose !== undefined ? service.requestLaunch(id, purpose) : INVALID;
			}
			case 'reportLaunch': {
				const paneToken = args.string(1);
				return id !== undefined && paneToken !== undefined && service.reportLaunch(id, paneToken);
			}
			case 'paneFolderRoots': return service.paneFolderRoots();
			case 'boundPaneHashes': return service.boundPaneHashes();
			case 'notePaneCommand': {
				const paneToken = args.string(0);
				const exitCode = args.at(1);
				if (paneToken !== undefined && (exitCode === undefined || exitCode === null || (typeof exitCode === 'number' && Number.isSafeInteger(exitCode))) && typeof args.at(2) === 'boolean') {
					service.notePaneCommand(paneToken, typeof exitCode === 'number' ? exitCode : undefined, args.at(2) === true);
				}
				return undefined;
			}
			case 'reclaimPane': {
				const paneToken = args.string(0);
				if (paneToken !== undefined) {
					service.reclaimPane(paneToken);
				}
				return undefined;
			}
			case 'restartChat': return id !== undefined ? service.restartChat(id) : false;
			case 'releasePane': {
				const paneToken = args.string(0);
				if (paneToken !== undefined) {
					service.releasePane(paneToken);
				}
				return undefined;
			}
			case 'notePaneActive': {
				const paneToken = args.string(0);
				if (paneToken !== undefined) {
					service.notePaneActive(paneToken);
				}
				return undefined;
			}
			case 'cancelLaunch': {
				if (id !== undefined) {
					service.cancelLaunch(id);
				}
				return undefined;
			}
			case 'requestStop': return id !== undefined && service.requestStop(id);
			case 'requestReveal': return id !== undefined && service.requestReveal(id);
			case 'ackReveal': {
				if (id !== undefined) {
					service.ackReveal(id);
				}
				return undefined;
			}
			case 'paneHashesOf': {
				const purpose = args.at(1) === undefined ? undefined : PARADIS_BOT_PANE_PURPOSES.find(candidate => candidate === args.at(1));
				return id !== undefined && (args.at(1) === undefined || purpose !== undefined) ? service.paneHashesOf(id, purpose) : [];
			}
			case 'sleepingChat': return id !== undefined ? service.sleepingChat(id) : undefined;
			case 'allPaneHashes': return service.allPaneHashes();
			case 'listSuggestions': return id !== undefined ? service.listSuggestions(id) : [];
			case 'startSuggestion': return id !== undefined ? service.startSuggestion(id) : INVALID;
			case 'markSuggestionStarted': return id !== undefined ? service.markSuggestionStarted(id) : INVALID;
			case 'dismissSuggestion': return id !== undefined ? service.dismissSuggestion(id) : INVALID;
			case 'snapshotMemory': return id !== undefined ? service.snapshotMemory(id) : INVALID;
			case 'listMemorySnapshots': return id !== undefined ? service.listMemorySnapshots(id) : INVALID;
			case 'undoMemoryTidy': {
				const takenAt = args.at(1);
				return id !== undefined && typeof takenAt === 'number' && Number.isSafeInteger(takenAt) ? service.undoMemoryTidy(id, takenAt) : INVALID;
			}

			case 'readHomeFile': return id !== undefined ? service.readHomeFile(id, args.at(1)) : INVALID;
			case 'writeHomeFile': {
				const text = args.string(2);
				return id !== undefined && text !== undefined ? service.writeHomeFile(id, args.at(1), text) : INVALID;
			}
			case 'installTemplateSkill': {
				const templateId = args.string(1);
				return id !== undefined && templateId !== undefined ? service.installTemplateSkill(id, templateId) : INVALID;
			}
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}
