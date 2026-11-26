/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot グループのサービスが画面へ見せる形と、ウィンドウ側のサービスの口。

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisBotGroup, IParadisBotGroupRecord, ParadisBotGroupReplyMode } from './paradisBotGroups.js';
import { ParadisBotsServiceResult } from './paradisBotsApi.js';

/** グループを開く（引数はグループの id）。登録は paradisBotGroups.contribution.ts。 */
export const PARADIS_BOTS_OPEN_GROUP_COMMAND = 'paradis.bots.openGroup';

export const PARADIS_BOT_GROUPS_CHANNEL = 'paradisBotGroups';

/**
 * ウィンドウが shared process へ登録する窓口（Bot 同士の伝言の道具が `callOwningWindow` で呼ぶ）。
 * `deliver` の引数は `[呼び出し元のペイントークン, グループの id, 宛先の Bot の id, 種類（asked・told）, 文]`。
 */
export const PARADIS_BOT_GROUPS_WINDOW_CHANNEL = 'paradisBotGroupsWindow';

export interface IParadisBotGroupsSnapshot {
	readonly revision: number;
	readonly readOnly: boolean;
	readonly groups: readonly IParadisBotGroup[];
	/** 記録（古い順）。 */
	readonly records: readonly IParadisBotGroupRecord[];
}

export const EMPTY_PARADIS_BOT_GROUPS_SNAPSHOT: IParadisBotGroupsSnapshot = Object.freeze({ revision: 0, readOnly: false, groups: Object.freeze([]), records: Object.freeze([]) });

export const IParadisBotGroupsService = createDecorator<IParadisBotGroupsService>('paradisBotGroupsService');

/**
 * ウィンドウから見た Bot グループのサービス。実体は shared process。ここから書ける記録は、あなたが送った分（`sent`）
 * だけ。Bot 同士の記録（`asked`・`told`）は、伝言の道具が shared process の中で書く。
 */
export interface IParadisBotGroupsService {
	readonly _serviceBrand: undefined;
	readonly snapshot: IParadisBotGroupsSnapshot;
	readonly onDidChange: Event<void>;

	createGroup(input: { readonly name: string; readonly members: readonly string[]; readonly replyMode: ParadisBotGroupReplyMode }): Promise<ParadisBotsServiceResult<IParadisBotGroup>>;
	updateGroup(groupId: string, patch: { readonly name?: string; readonly members?: readonly string[]; readonly replyMode?: ParadisBotGroupReplyMode }): Promise<ParadisBotsServiceResult<IParadisBotGroup>>;
	removeGroup(groupId: string): Promise<ParadisBotsServiceResult<IParadisBotGroup>>;
	/** あなたがグループの入力欄から送った（`to` は実際に届いた Bot だけ）。 */
	recordSent(groupId: string, to: readonly string[], text: string): Promise<ParadisBotsServiceResult<IParadisBotGroupRecord>>;
}
