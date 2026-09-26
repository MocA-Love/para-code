/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT): src/main/rate-limits/claude-oauth-usage-request.ts, src/main/rate-limits/claude-oauth-usage-error.ts, src/main/claude-accounts/oauth-refresh.ts
// Portions adapted from claude-swap (MIT, Copyright (c) 2026 Onur Cetinkol): claude_swap/oauth.py

// Claude の使用量 API とトークン更新の HTTP 呼び出し。
//
// トークン・応答本文は結果にもログにも載せない（HTTP の状態コードだけを返す）。
// `fetch` は差し替えられるようにしてあり、テストでは本物の API を呼ばない。

import {
	IParadisClaudeTokenResponse,
	IParadisClaudeUsageWindows,
	PARADIS_CLAUDE_OAUTH_BETA,
	PARADIS_CLAUDE_OAUTH_CLIENT_ID,
	PARADIS_CLAUDE_OAUTH_TOKEN_URL,
	PARADIS_CLAUDE_USAGE_URL,
	paradisApplyRefreshedClaudeToken,
	paradisClaudeRefreshToken,
	paradisParseClaudeUsage,
	paradisParseRetryAfterS
} from '../common/paradisClaudeUsage.js';

const USAGE_TIMEOUT_MS = 10_000;
const REFRESH_TIMEOUT_MS = 10_000;
/**
 * 使用量 API の呼び出し回数の上限は「身元 × User-Agent の種類」ごとに数えられる（claude-swap の実測）。
 * Para Code 独自の名前にしておくと、同じアカウントを claude-swap や Claude Code 自身が見ていても
 * 回数を取り合わない。
 */
const USER_AGENT = 'ParaCode-LimitsMonitor/1.0';

export type ParadisClaudeUsageFetchResult =
	| { readonly kind: 'ok'; readonly usage: IParadisClaudeUsageWindows }
	| { readonly kind: 'http'; readonly status: number; readonly retryAfterS?: number }
	| { readonly kind: 'network' };

export type ParadisClaudeRefreshResult =
	| { readonly kind: 'ok'; readonly credentialsJson: string }
	/** サーバーがリフレッシュトークンを拒否した。再ログインでしか直らない。 */
	| { readonly kind: 'invalid_grant' }
	/** リフレッシュトークンを持っていない。 */
	| { readonly kind: 'no_refresh_token' }
	/** 通信の失敗など。次の機会にまた試す。 */
	| { readonly kind: 'transient'; readonly status?: number };

export interface IParadisClaudeOAuthClient {
	fetchUsage(accessToken: string): Promise<ParadisClaudeUsageFetchResult>;
	refresh(credentialsJson: string): Promise<ParadisClaudeRefreshResult>;
}

export class ParadisClaudeOAuthClient implements IParadisClaudeOAuthClient {

	constructor(
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) { }

	async fetchUsage(accessToken: string): Promise<ParadisClaudeUsageFetchResult> {
		let response: Response;
		try {
			response = await this.fetchImpl(PARADIS_CLAUDE_USAGE_URL, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${accessToken}`,
					'anthropic-beta': PARADIS_CLAUDE_OAUTH_BETA,
					'Accept': 'application/json',
					'User-Agent': USER_AGENT,
				},
				signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
			});
		} catch {
			return { kind: 'network' };
		}
		if (!response.ok) {
			return {
				kind: 'http',
				status: response.status,
				retryAfterS: response.status === 429 ? paradisParseRetryAfterS(response.headers.get('retry-after'), this.now()) : undefined,
			};
		}
		try {
			return { kind: 'ok', usage: paradisParseClaudeUsage(await response.json()) };
		} catch {
			return { kind: 'network' };
		}
	}

	/**
	 * リフレッシュトークンで新しいアクセストークンを取る。成功すれば回った後のリフレッシュトークンを
	 * 含む credentials JSON を返す。リフレッシュトークンは使い捨てなので、成功した結果は必ず保存すること
	 * （保存しないと、手元に残るのは使用済みのトークンだけになる）。
	 */
	async refresh(credentialsJson: string): Promise<ParadisClaudeRefreshResult> {
		const refreshToken = paradisClaudeRefreshToken(credentialsJson);
		if (!refreshToken) {
			return { kind: 'no_refresh_token' };
		}
		let response: Response;
		try {
			response = await this.fetchImpl(PARADIS_CLAUDE_OAUTH_TOKEN_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json',
					'User-Agent': USER_AGENT,
				},
				body: JSON.stringify({
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
					client_id: PARADIS_CLAUDE_OAUTH_CLIENT_ID,
				}),
				signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
			});
		} catch {
			return { kind: 'transient' };
		}
		if (!response.ok) {
			// 拒否と断定するのは、4xx で本文の `error` が invalid_grant のときだけ。曖昧なものを
			// 「再ログインが要る」に倒すと、生きているトークンを捨てさせてしまう。
			if (response.status === 400 || response.status === 401 || response.status === 403) {
				try {
					const body = await response.json() as { error?: unknown };
					if (body.error === 'invalid_grant') {
						return { kind: 'invalid_grant' };
					}
				} catch {
					// 本文が JSON でなければ一時的な失敗として扱う
				}
			}
			return { kind: 'transient', status: response.status };
		}
		try {
			const data = await response.json() as IParadisClaudeTokenResponse;
			const updated = paradisApplyRefreshedClaudeToken(credentialsJson, data, this.now());
			return updated ? { kind: 'ok', credentialsJson: updated } : { kind: 'transient' };
		} catch {
			return { kind: 'transient' };
		}
	}
}
