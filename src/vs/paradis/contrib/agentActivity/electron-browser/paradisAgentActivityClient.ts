/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process の会話ログ集計チャネルを呼ぶ薄いクライアント。

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisSpaceUsageRequest, IParadisSpaceUsageResult, IParadisWorkStatsRequest, IParadisWorkStatsResult, PARADIS_AGENT_ACTIVITY_CHANNEL } from '../common/paradisAgentActivity.js';
import { IParadisSessionIndexStatus, IParadisSessionIndexUpdateRequest } from '../common/paradisSessionIndex.js';

export interface IParadisSessionIndexSearchMatch {
	readonly catalogId: string;
	readonly matchCount: number;
	readonly snippet: string;
}

export interface IParadisSessionIndexSearchResult {
	readonly covered: readonly string[];
	readonly matches: readonly IParadisSessionIndexSearchMatch[];
}

export class ParadisAgentActivityClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
	) { }

	private get channel(): IChannel {
		return this.sharedProcessService.getChannel(PARADIS_AGENT_ACTIVITY_CHANNEL);
	}

	spaceUsage(request: IParadisSpaceUsageRequest): Promise<IParadisSpaceUsageResult> {
		return this.channel.call('spaceUsage', [request]);
	}

	workStats(request: IParadisWorkStatsRequest): Promise<IParadisWorkStatsResult> {
		return this.channel.call('workStats', [request]);
	}

	indexUpdate(request: IParadisSessionIndexUpdateRequest): Promise<void> {
		return this.channel.call('indexUpdate', [request]);
	}

	indexSearch(query: string): Promise<IParadisSessionIndexSearchResult> {
		return this.channel.call('indexSearch', [query]);
	}

	indexStatus(): Promise<IParadisSessionIndexStatus> {
		return this.channel.call('indexStatus');
	}

	indexDelete(): Promise<void> {
		return this.channel.call('indexDelete');
	}
}
