/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 側で Copilot の小型モデル（CAPI の utility chat completion）を呼ぶチャネル。
// 生成そのものは upstream の CopilotApiService に丸ごと任せる（コミットメッセージや PR タイトルの
// 生成と同じ経路）。ここが持つのは「shared process で組み立てて IPC に出す」ところだけ。

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { deriveGitHubEndpoints, gitHubCopilotResource, gitHubRepoResource, IGitHubEndpoints } from '../../../../platform/agentHost/common/githubEndpoints.js';
import { IAgentHostGitHubEndpointService } from '../../../../platform/agentHost/node/agentHostGitHubEndpointService.js';
import { CopilotApiService, ICopilotApiService } from '../../../../platform/agentHost/node/shared/copilotApiService.js';
import { ProtectedResourceMetadata } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import {
	IParadisCopilotUtilityRequest,
	IParadisCopilotUtilityResult,
	PARADIS_COPILOT_UTILITY_CHANNEL,
} from '../common/paradisCopilotUtility.js';

/** 1回の生成に許す時間。数十文字を作らせるだけなので、待たせるくらいなら諦める。 */
const UTILITY_TIMEOUT_MS = 10_000;
/** 呼び出し側が壊れていても shared process が長文を組み立てさせられないようにする上限。 */
const MAX_PROMPT_CHARS = 8_000;

/**
 * GitHub Enterprise を考慮しない、github.com 固定のエンドポイント提供。
 *
 * 本来の実装（AgentHostGitHubEndpointService）はエージェントホストのルート設定を読むが、その状態は
 * shared process には無い。GHE を使う場合はエージェントホスト側の経路（コミットメッセージ生成など）
 * が正しく効くので、ここは既定値のみを提供し、GHE 環境ではこの経路が使えないことを許容する。
 */
class ParadisGitHubComEndpointService implements IAgentHostGitHubEndpointService {

	declare readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void> = Event.None;

	private readonly endpoints: IGitHubEndpoints = deriveGitHubEndpoints(undefined);

	getCopilotResource(): ProtectedResourceMetadata { return gitHubCopilotResource(this.endpoints); }
	getRepoResource(): ProtectedResourceMetadata { return gitHubRepoResource(this.endpoints); }
	getApiBaseUri(): string { return this.endpoints.apiBaseUri; }
	getGraphQlUri(): string { return this.endpoints.graphQlUri; }
	getEnterpriseHost(): string | undefined { return this.endpoints.enterpriseHost; }
	getEnterpriseUri(): string | undefined { return undefined; }
}

export class ParadisCopilotUtilityService {

	private readonly copilotApiService: ICopilotApiService;

	constructor(
		private readonly logService: ILogService,
		productService: IProductService,
		copilotApiService?: ICopilotApiService,
	) {
		this.copilotApiService = copilotApiService
			?? new CopilotApiService(undefined, logService, productService, new ParadisGitHubComEndpointService());
	}

	async complete(request: IParadisCopilotUtilityRequest): Promise<IParadisCopilotUtilityResult> {
		const messages = (request?.messages ?? [])
			.filter(message => message && typeof message.content === 'string' && message.content.length > 0)
			.map(message => ({ role: message.role === 'system' ? 'system' as const : 'user' as const, content: message.content }));
		const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
		if (!request?.githubToken || messages.length === 0 || totalChars > MAX_PROMPT_CHARS) {
			return { error: 'invalid request' };
		}

		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), UTILITY_TIMEOUT_MS);
		try {
			const text = await this.copilotApiService.utilityChatCompletion(
				request.githubToken,
				{ messages, ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}) },
				{ signal: abort.signal },
			);
			return { text };
		} catch (error) {
			// 呼び出し側は必ず自前のフォールバックを持つので、ここでは記録して静かに諦める。
			this.logService.info('[ParadisCopilotUtility] utility completion failed', error);
			return { error: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	}
}

class ParadisCopilotUtilityChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisCopilotUtilityService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		if (command !== 'complete') {
			throw new Error(`Method not found: ${command}`);
		}
		const args = Array.isArray(arg) ? arg : [];
		return this.service.complete(args[0] as IParadisCopilotUtilityRequest) as Promise<T>;
	}
}

/** Registers the Copilot utility completion channel in the shared process. */
export function registerParadisCopilotUtility(server: IPCServer<string>, logService: ILogService, productService: IProductService): IDisposable {
	server.registerChannel(PARADIS_COPILOT_UTILITY_CHANNEL, new ParadisCopilotUtilityChannel(new ParadisCopilotUtilityService(logService, productService)));
	return { dispose: () => { } };
}
