/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process の Bot グループのサービス。台帳は `<userData>/paradis/bots/groups.json`（0600、一時ファイル＋rename）。
// 壊れたファイルは `groups.json.broken-<時刻>` へ退避して空で始める（Bot の台帳と同じ扱い）。
//
// Bot 同士の伝言の道具（本体の担当が作る MCP の道具）は、`groupsOf` で呼び出し元の Bot のグループを引き、届けた後に
// `appendRecord` で「聞きました・伝えました」を残す。

import { promises as fs } from 'fs';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisJsonStateWriter } from '../../../node/paradisJsonStateWriter.js';
import {
	EMPTY_PARADIS_BOT_GROUPS_STATE, IParadisBotGroup, IParadisBotGroupInput, IParadisBotGroupRecord, IParadisBotGroupRecordInput, IParadisBotGroupsState,
	PARADIS_BOT_GROUPS_VERSION, ParadisBotGroupsResult, paradisBotGroupAppendRecord, paradisBotGroupCreate, paradisBotGroupRemove, paradisBotGroupUpdate, paradisParseBotGroupsState,
} from '../common/paradisBotGroups.js';
import { IParadisBotGroupsSnapshot } from '../common/paradisBotGroupsApi.js';
import { ParadisBotsServiceResult } from '../common/paradisBotsApi.js';
import { paradisBotsDataFolder } from './paradisBotsStore.js';

/** 台帳の保存先（テストではメモリに置き換える）。 */
export interface IParadisBotGroupsFile {
	read(): Promise<{ readonly state: IParadisBotGroupsState; readonly quarantined?: string }>;
	write(state: IParadisBotGroupsState): Promise<void>;
}

export function createParadisBotGroupsFile(userDataPath: string, now: () => number = Date.now): IParadisBotGroupsFile {
	const path = join(paradisBotsDataFolder(userDataPath), 'groups.json');
	const writer = new ParadisJsonStateWriter(path);
	return {
		async read() {
			let raw: string;
			try {
				raw = await fs.readFile(path, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return { state: EMPTY_PARADIS_BOT_GROUPS_STATE };
				}
				throw error;
			}
			let state: IParadisBotGroupsState | undefined;
			try {
				state = paradisParseBotGroupsState(JSON.parse(raw));
			} catch {
				state = undefined;
			}
			if (state !== undefined) {
				return { state };
			}
			const quarantined = `${path}.broken-${now()}`;
			await fs.rename(path, quarantined);
			return { state: EMPTY_PARADIS_BOT_GROUPS_STATE, quarantined };
		},
		async write(state) {
			if (state.version !== PARADIS_BOT_GROUPS_VERSION) {
				throw new Error(`refusing to write ${path}: it was written by a newer Para Code (version ${state.version})`);
			}
			await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writer.write(JSON.stringify(state, undefined, '\t'));
		},
	};
}

/** 知らせをまとめる間隔（記録が続けて足されても、ウィンドウへ送るのは 1 回）。 */
const CHANGE_DELAY = 50;

export class ParadisBotGroupsService extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<IParadisBotGroupsSnapshot>());
	readonly onDidChange: Event<IParadisBotGroupsSnapshot> = this._onDidChange.event;

	private state: IParadisBotGroupsState = EMPTY_PARADIS_BOT_GROUPS_STATE;
	private revision = 0;
	private readonly changeScheduler = this._register(new RunOnceScheduler(() => this._onDidChange.fire(this.getSnapshot()), CHANGE_DELAY));
	readonly ready: Promise<void>;

	constructor(
		private readonly file: IParadisBotGroupsFile,
		private readonly logService: ILogService,
		private readonly now: () => number = Date.now,
		private readonly uuid: () => string = generateUuid,
	) {
		super();
		this.ready = this.load();
	}

	private async load(): Promise<void> {
		try {
			const loaded = await this.file.read();
			if (loaded.quarantined !== undefined) {
				this.logService.error(`[ParadisBotGroups] the saved groups could not be read; they were moved to ${loaded.quarantined} and the list starts empty`);
			}
			this.state = loaded.state;
		} catch (error) {
			// 読めなかったときは空で動かすが、上書きはしない（次の起動で読めるかもしれない）
			this.logService.error('[ParadisBotGroups] could not read the saved groups; they are read-only until the next start', error);
			this.state = { ...EMPTY_PARADIS_BOT_GROUPS_STATE, version: PARADIS_BOT_GROUPS_VERSION + 1 };
		}
		this.revision++;
		this.changeScheduler.schedule();
	}

	getSnapshot(): IParadisBotGroupsSnapshot {
		return { revision: this.revision, readOnly: this.state.version !== PARADIS_BOT_GROUPS_VERSION, groups: this.state.groups, records: this.state.records };
	}

	getGroup(groupId: string): IParadisBotGroup | undefined {
		return this.state.groups.find(group => group.id === groupId);
	}

	/** その Bot が入っているグループ（Bot 同士の伝言の道具が、呼び出し元の Bot から引く）。 */
	groupsOf(botId: string): IParadisBotGroup[] {
		return this.state.groups.filter(group => group.members.includes(botId));
	}

	async createGroup(input: IParadisBotGroupInput): Promise<ParadisBotsServiceResult<IParadisBotGroup>> {
		await this.ready;
		return this.apply(paradisBotGroupCreate(this.state, this.uuid(), input, this.now()));
	}

	async updateGroup(groupId: string, patch: Partial<IParadisBotGroupInput>): Promise<ParadisBotsServiceResult<IParadisBotGroup>> {
		await this.ready;
		return this.apply(paradisBotGroupUpdate(this.state, groupId, patch, this.now()));
	}

	async removeGroup(groupId: string): Promise<ParadisBotsServiceResult<IParadisBotGroup>> {
		await this.ready;
		return this.apply(paradisBotGroupRemove(this.state, groupId));
	}

	/** 記録を 1 件足す（送り手と宛先がメンバーでなければ断る）。 */
	async appendRecord(groupId: string, input: IParadisBotGroupRecordInput): Promise<ParadisBotsServiceResult<IParadisBotGroupRecord>> {
		await this.ready;
		return this.apply(paradisBotGroupAppendRecord(this.state, groupId, input, this.now()));
	}

	private async apply<T>(result: ParadisBotGroupsResult<T>): Promise<ParadisBotsServiceResult<T>> {
		if (!result.ok) {
			return result;
		}
		const previous = this.state;
		this.state = result.state;
		try {
			await this.file.write(result.state);
		} catch (error) {
			// 書けなかった変更は取り消す（画面と保存がずれたまま再起動で消えないように）
			if (this.state === result.state) {
				this.state = previous;
			}
			this.logService.error('[ParadisBotGroups] could not save the groups', error);
			return { ok: false, code: 'storage', message: 'Para Code could not save the bot groups.' };
		}
		this.revision++;
		this.changeScheduler.schedule();
		return { ok: true, value: result.value };
	}
}
