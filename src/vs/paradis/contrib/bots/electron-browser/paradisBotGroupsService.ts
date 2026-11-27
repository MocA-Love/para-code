/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot グループのサービスの、ウィンドウ側の窓口（shared process の ParadisBotGroupsService を呼ぶ）。
// paradisBotGroups.contribution.ts から読み込む。使う側が現れるまで実体は作られない（Delayed）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisBotGroup, IParadisBotGroupRecord, ParadisBotGroupReplyMode } from '../common/paradisBotGroups.js';
import { EMPTY_PARADIS_BOT_GROUPS_SNAPSHOT, IParadisBotGroupsService, IParadisBotGroupsSnapshot, PARADIS_BOT_GROUPS_CHANNEL } from '../common/paradisBotGroupsApi.js';
import { ParadisBotsServiceResult } from '../common/paradisBotsApi.js';

const UNAVAILABLE: ParadisBotsServiceResult<never> = { ok: false, code: 'unavailable', message: 'Para Code could not reach the bot group service.' };

export class ParadisBotGroupsClient extends Disposable implements IParadisBotGroupsService {

	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private _snapshot: IParadisBotGroupsSnapshot = EMPTY_PARADIS_BOT_GROUPS_SNAPSHOT;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = sharedProcessService.getChannel(PARADIS_BOT_GROUPS_CHANNEL);
		this._register(this.channel.listen<IParadisBotGroupsSnapshot>('onDidChange')(snapshot => this.apply(snapshot)));
		this.channel.call<IParadisBotGroupsSnapshot>('getSnapshot').then(
			snapshot => this.apply(snapshot),
			error => this.logService.trace('[paradisBotGroups] getSnapshot failed', String(error)),
		);
	}

	get snapshot(): IParadisBotGroupsSnapshot {
		return this._snapshot;
	}

	createGroup(input: { readonly name: string; readonly members: readonly string[]; readonly replyMode: ParadisBotGroupReplyMode }): Promise<ParadisBotsServiceResult<IParadisBotGroup>> {
		return this.result('createGroup', [input]);
	}

	updateGroup(groupId: string, patch: { readonly name?: string; readonly members?: readonly string[]; readonly replyMode?: ParadisBotGroupReplyMode }): Promise<ParadisBotsServiceResult<IParadisBotGroup>> {
		return this.result('updateGroup', [groupId, patch]);
	}

	removeGroup(groupId: string): Promise<ParadisBotsServiceResult<IParadisBotGroup>> {
		return this.result('removeGroup', [groupId]);
	}

	recordSent(groupId: string, to: readonly string[], text: string): Promise<ParadisBotsServiceResult<IParadisBotGroupRecord>> {
		return this.result('recordSent', [groupId, to, text]);
	}

	private async result<T>(command: string, args: unknown[]): Promise<ParadisBotsServiceResult<T>> {
		try {
			return await this.channel.call<ParadisBotsServiceResult<T>>(command, args);
		} catch (error) {
			this.logService.trace(`[paradisBotGroups] ${command} failed`, String(error));
			return UNAVAILABLE;
		}
	}

	/** 番号の戻ったもの（知らせより前に頼んだ取得の結果）では上書きしない。 */
	private apply(snapshot: IParadisBotGroupsSnapshot): void {
		if (snapshot.revision < this._snapshot.revision) {
			return;
		}
		this._snapshot = snapshot;
		this._onDidChange.fire();
	}
}

registerSingleton(IParadisBotGroupsService, ParadisBotGroupsClient, InstantiationType.Delayed);
