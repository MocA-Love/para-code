/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// getResolvedShellEnv() は解決に失敗すると reject する低レベル API。fork内の複数サービス
// (ccusage 実行、worktree の git 実行など) はいずれも「process.env とマージしてキャッシュし、
// 失敗時は process.env のみへフォールバックしてログを出す」という同じラッパーを個別実装して
// いたため、ここに共通化する。

import { IConfigurationService } from '../../configuration/common/configuration.js';
import { NativeParsedArgs } from '../../environment/common/argv.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from './shellEnv.js';

export type ParadisRawShellEnvResolver = () => Promise<NodeJS.ProcessEnv>;

/** 失敗後、同じ操作内で高コストなシェル解決を繰り返さないための待機時間。 */
const SHELL_ENV_FAILURE_RETRY_DELAY_MS = 5_000;

/**
 * ログインシェル由来の環境変数(PATH等)を process.env にマージした結果をキャッシュして返す。
 * 解決に失敗した場合は process.env のみへフォールバックする。失敗結果は短時間だけ保持し、
 * 1操作内の連続呼び出しでは再解決せず、待機時間後の呼び出しで再試行する。
 */
export class ParadisCachedShellEnv {

	private mergedEnvPromise: Promise<NodeJS.ProcessEnv> | undefined;
	private retryAfter = 0;

	constructor(
		private readonly logService: ILogService,
		private readonly logPrefix: string,
		private readonly resolveRawEnv: ParadisRawShellEnvResolver,
		private readonly now: () => number = Date.now,
	) { }

	getEnv(): Promise<NodeJS.ProcessEnv> {
		if (this.mergedEnvPromise && this.retryAfter > 0 && this.now() >= this.retryAfter) {
			this.mergedEnvPromise = undefined;
			this.retryAfter = 0;
		}
		if (!this.mergedEnvPromise) {
			const promise = this.resolveRawEnv()
				.then(shellEnv => {
					this.retryAfter = 0;
					return { ...process.env, ...shellEnv };
				})
				.catch(error => {
					this.logService.warn(`[${this.logPrefix}] failed to resolve shell environment, falling back to inherited PATH: ${error instanceof Error ? error.message : error}`);
					this.retryAfter = this.now() + SHELL_ENV_FAILURE_RETRY_DELAY_MS;
					return { ...process.env };
				});
			this.mergedEnvPromise = promise;
		}
		return this.mergedEnvPromise;
	}
}

/** configurationService/args が揃っていれば getResolvedShellEnv() を、なければ空環境を返す resolver を作る。 */
export function createParadisShellEnvResolver(logService: ILogService, configurationService?: IConfigurationService, args?: NativeParsedArgs): ParadisRawShellEnvResolver {
	return () => {
		if (configurationService && args) {
			return getResolvedShellEnv(configurationService, logService, args, process.env);
		}
		return Promise.resolve({});
	};
}
