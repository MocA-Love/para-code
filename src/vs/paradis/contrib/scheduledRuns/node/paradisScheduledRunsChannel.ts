/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期実行のチャネルと保存先（shared process）。登録は `paradis.sharedProcess.contribution.ts` の
// 副作用 import で行う。
//
// 保存先は `<userData>/paradis/scheduledRuns.json`（フォルダ 0700、ファイル 0600）。エージェントへの
// 指示の本文が入るため、本人だけが読める権限で書く。

import { promises as fs } from 'fs';
import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import {
	IParadisScheduledRunDefinition,
	IParadisScheduledRunRecord,
	PARADIS_SCHEDULED_RUNS_CHANNEL,
} from '../common/paradisScheduledRuns.js';
import { paradisSanitizeScheduledRunDraft } from '../common/paradisScheduledRunsSanitize.js';
import { IParadisScheduledRunsStore, IParadisScheduledRunsStoredState, ParadisScheduledRunsService } from './paradisScheduledRunsService.js';

export class ParadisScheduledRunsChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisScheduledRunsService) { }

	listen<T>(ctx: string, event: string): Event<T> {
		switch (event) {
			case 'onDidChange': return this.service.onDidChange as Event<T>;
			case 'onDidRequestRun': return this.service.onDidRequestRun as Event<T>;
			// 停止の依頼は受け持っているウィンドウにだけ流す
			case 'onDidRequestStop': return Event.map(Event.filter(this.service.onDidRequestStop, request => request.claimedBy === ctx), request => request.runId) as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const text = (index: number) => {
			const value = args[index];
			if (typeof value !== 'string' || value.length > 200) {
				throw new Error(`Invalid argument for ${command}`);
			}
			return value;
		};
		switch (command) {
			case 'getState': await this.service.whenReady(); return this.service.getState() as T;
			case 'save': return this.service.save(args[0]) as Promise<T>;
			case 'setEnabled': {
				if (typeof args[1] !== 'boolean') {
					throw new Error('Invalid argument for setEnabled');
				}
				return this.service.setEnabled(text(0), args[1]) as Promise<T>;
			}
			case 'delete': return this.service.delete(text(0)) as Promise<T>;
			case 'runNow': return this.service.runNow(text(0)) as Promise<T>;
			case 'stop': return this.service.stop(text(0)) as Promise<T>;
			case 'forgetSpace': return this.service.forgetSpace(text(0)) as Promise<T>;
			case 'claim': return this.service.claim(ctx, text(0)) as Promise<T>;
			case 'report': return this.service.report(ctx, args[0]) as Promise<T>;
			case 'heartbeat': {
				const ids = Array.isArray(args[0]) ? args[0].filter((id): id is string => typeof id === 'string').slice(0, 100) : [];
				return this.service.heartbeat(ctx, ids) as Promise<T>;
			}
			case 'getPendingRequests': return this.service.getPendingRequests() as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}
}

// ---------- 保存先 ----------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredDefinition(value: unknown): value is IParadisScheduledRunDefinition {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& typeof value.enabled === 'boolean'
		&& typeof value.createdAt === 'number'
		&& typeof value.updatedAt === 'number'
		&& paradisSanitizeScheduledRunDraft(value) !== undefined;
}

function isStoredRun(value: unknown): value is IParadisScheduledRunRecord {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& typeof value.definitionId === 'string'
		&& typeof value.status === 'string'
		&& typeof value.trigger === 'string'
		&& typeof value.createdAt === 'number';
}

/** 読んだ JSON を保存の形へ直す。形の違う項目は捨てる（1 件の破損で全部を失わない）。 */
export function paradisParseScheduledRunsState(raw: string): IParadisScheduledRunsStoredState | undefined {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed) || parsed.version !== 1) {
		return undefined;
	}
	const definitions = Array.isArray(parsed.definitions) ? parsed.definitions.filter(isStoredDefinition) : [];
	const ids = new Set(definitions.map(definition => definition.id));
	const runs = Array.isArray(parsed.runs) ? parsed.runs.filter(isStoredRun).filter(run => ids.has(run.definitionId)) : [];
	const lastEvaluatedAt: Record<string, number> = {};
	if (isRecord(parsed.lastEvaluatedAt)) {
		for (const [id, value] of Object.entries(parsed.lastEvaluatedAt)) {
			if (ids.has(id) && typeof value === 'number' && Number.isFinite(value)) {
				lastEvaluatedAt[id] = value;
			}
		}
	}
	return { version: 1, definitions, runs, lastEvaluatedAt };
}

export function createParadisScheduledRunsFileStore(userDataPath: string): IParadisScheduledRunsStore {
	const directory = join(userDataPath, 'paradis');
	const file = join(directory, 'scheduledRuns.json');
	return {
		async read() {
			let raw: string;
			try {
				raw = await fs.readFile(file, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return undefined;
				}
				throw error;
			}
			return paradisParseScheduledRunsState(raw);
		},
		async write(state) {
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			await paradisWriteFileAtomic(file, Buffer.from(JSON.stringify(state, undefined, '\t')));
		},
	};
}

ParadisSharedProcessContributions.register('scheduledRuns', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const service = new ParadisScheduledRunsService(createParadisScheduledRunsFileStore(environmentService.userDataPath), { now: () => Date.now() }, logService, { hookEvents: onParadisAgentHookEvent });
	server.registerChannel(PARADIS_SCHEDULED_RUNS_CHANNEL, new ParadisScheduledRunsChannel(service));
	return service;
});
