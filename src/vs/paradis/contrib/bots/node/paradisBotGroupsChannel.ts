/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot グループのサービスをウィンドウへ出すチャネル。ウィンドウから書ける記録は、あなたが送った分（`sent`）だけ。
// Bot 同士の記録（`asked`・`told`）は、伝言の道具が shared process の中から書く（ここには口が無い）。

import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ParadisChannelArgs } from '../../../common/paradisChannelArgs.js';
import { asRecord } from '../../../common/paradisGuards.js';
import { PARADIS_BOT_GROUP_OWNER } from '../common/paradisBotGroups.js';
import { ParadisBotsServiceResult } from '../common/paradisBotsApi.js';
import { ParadisBotGroupsService } from './paradisBotGroupsService.js';

const INVALID: ParadisBotsServiceResult<never> = { ok: false, code: 'invalid_argument', message: 'The arguments are not valid.' };

export class ParadisBotGroupsChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisBotGroupsService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		if (event === 'onDidChange') {
			return this.service.onDidChange as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
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
			case 'createGroup': {
				const input = asRecord(args.at(0));
				return input ? service.createGroup({ name: input.name, members: input.members, replyMode: input.replyMode }) : INVALID;
			}
			case 'updateGroup': {
				const patch = asRecord(args.at(1));
				return id !== undefined && patch ? service.updateGroup(id, { name: patch.name, members: patch.members, replyMode: patch.replyMode }) : INVALID;
			}
			case 'removeGroup': return id !== undefined ? service.removeGroup(id) : INVALID;
			case 'recordSent': {
				const text = args.string(2);
				const to = args.strings(1);
				return id !== undefined && text !== undefined ? service.appendRecord(id, { kind: 'sent', from: PARADIS_BOT_GROUP_OWNER, to, text }) : INVALID;
			}
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}
