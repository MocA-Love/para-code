/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期実行の shared process チャネルを画面から使うための薄い窓口。

import { Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IParadisScheduledRunDraft,
	IParadisScheduledRunReport,
	IParadisScheduledRunRequest,
	IParadisScheduledRunsResult,
	IParadisScheduledRunsState,
	PARADIS_SCHEDULED_RUNS_CHANNEL,
} from '../common/paradisScheduledRuns.js';

export const IParadisScheduledRunsClient = createDecorator<IParadisScheduledRunsClient>('paradisScheduledRunsClient');

export interface IParadisScheduledRunsClient {
	readonly _serviceBrand: undefined;
	/** 定義・記録が変わった。 */
	readonly onDidChange: Event<void>;
	/** 開始待ちの実行（どのウィンドウにも届く）。 */
	readonly onDidRequestRun: Event<IParadisScheduledRunRequest>;
	/** このウィンドウが受け持つ実行の停止依頼（実行の id）。 */
	readonly onDidRequestStop: Event<string>;
	getState(): Promise<IParadisScheduledRunsState>;
	save(draft: IParadisScheduledRunDraft): Promise<IParadisScheduledRunsResult>;
	setEnabled(id: string, enabled: boolean): Promise<IParadisScheduledRunsResult>;
	delete(id: string): Promise<IParadisScheduledRunsResult>;
	runNow(id: string): Promise<IParadisScheduledRunsResult>;
	stop(runId: string): Promise<IParadisScheduledRunsResult>;
	forgetSpace(runId: string): Promise<IParadisScheduledRunsResult>;
	getPendingRequests(): Promise<IParadisScheduledRunRequest[]>;
	claim(runId: string): Promise<IParadisScheduledRunRequest | undefined>;
	report(report: IParadisScheduledRunReport): Promise<boolean>;
	heartbeat(runIds: readonly string[]): Promise<void>;
}

class ParadisScheduledRunsClient implements IParadisScheduledRunsClient {

	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;
	readonly onDidChange: Event<void>;
	readonly onDidRequestRun: Event<IParadisScheduledRunRequest>;
	readonly onDidRequestStop: Event<string>;

	constructor(@ISharedProcessService sharedProcessService: ISharedProcessService) {
		this.channel = sharedProcessService.getChannel(PARADIS_SCHEDULED_RUNS_CHANNEL);
		this.onDidChange = this.channel.listen<void>('onDidChange');
		this.onDidRequestRun = this.channel.listen<IParadisScheduledRunRequest>('onDidRequestRun');
		this.onDidRequestStop = this.channel.listen<string>('onDidRequestStop');
	}

	getState(): Promise<IParadisScheduledRunsState> { return this.channel.call('getState'); }
	save(draft: IParadisScheduledRunDraft): Promise<IParadisScheduledRunsResult> { return this.channel.call('save', [draft]); }
	setEnabled(id: string, enabled: boolean): Promise<IParadisScheduledRunsResult> { return this.channel.call('setEnabled', [id, enabled]); }
	delete(id: string): Promise<IParadisScheduledRunsResult> { return this.channel.call('delete', [id]); }
	runNow(id: string): Promise<IParadisScheduledRunsResult> { return this.channel.call('runNow', [id]); }
	stop(runId: string): Promise<IParadisScheduledRunsResult> { return this.channel.call('stop', [runId]); }
	forgetSpace(runId: string): Promise<IParadisScheduledRunsResult> { return this.channel.call('forgetSpace', [runId]); }
	getPendingRequests(): Promise<IParadisScheduledRunRequest[]> { return this.channel.call('getPendingRequests'); }
	claim(runId: string): Promise<IParadisScheduledRunRequest | undefined> { return this.channel.call('claim', [runId]); }
	report(report: IParadisScheduledRunReport): Promise<boolean> { return this.channel.call('report', [report]); }
	heartbeat(runIds: readonly string[]): Promise<void> { return this.channel.call('heartbeat', [runIds]); }
}

registerSingleton(IParadisScheduledRunsClient, ParadisScheduledRunsClient, InstantiationType.Delayed);
