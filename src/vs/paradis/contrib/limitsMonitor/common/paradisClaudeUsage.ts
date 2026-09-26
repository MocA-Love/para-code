/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT): src/main/rate-limits/claude-oauth-usage-request.ts, src/main/rate-limits/claude-usage-window.ts, src/main/claude-accounts/oauth-refresh.ts
// Portions adapted from claude-swap (MIT, Copyright (c) 2026 Onur Cetinkol): claude_swap/oauth.py

// Claude の使用量 API の応答と、Claude Code の認証情報（credentials JSON / `~/.claude.json` の
// oauthAccount）を扱う純関数。秘密の値を含む文字列を受け取るが、ここでは記録も出力もしない。
//
// 使用量 API（Orca・claude-swap・Claude Code 自身が使っているもの。推測で作った URL ではない）:
//   GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <accessToken>, anthropic-beta: oauth-2025-04-20
// 応答（抜粋）:
//   { five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at },
//     limits: [{ kind: 'weekly_scoped', percent, resets_at, scope: { model: { display_name } } }] }

import { IParadisLimitsWindow } from './paradisLimitsMonitor.js';

export const PARADIS_CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const PARADIS_CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Claude Code の公開 OAuth クライアント ID（インストール済みの claude 2.1.283 と Orca・claude-swap で確認）。 */
export const PARADIS_CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const PARADIS_CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** 期限の 5 分前から「切れかけ」とみなす（Claude Code と同じ余裕）。 */
export const PARADIS_CLAUDE_OAUTH_EXPIRY_BUFFER_MS = 5 * 60_000;

/** 使用量 API の窓 1 つ。 */
interface IParadisClaudeUsageWindowJson {
	readonly utilization?: unknown;
	readonly used_percentage?: unknown;
	readonly resets_at?: unknown;
}

interface IParadisClaudeUsageLimitJson {
	readonly kind?: unknown;
	readonly percent?: unknown;
	readonly resets_at?: unknown;
	readonly scope?: { readonly model?: { readonly display_name?: unknown } | null } | null;
}

export interface IParadisClaudeUsageWindows {
	readonly fiveHour?: IParadisLimitsWindow;
	readonly sevenDay?: IParadisLimitsWindow;
	/** モデル別の週枠（例: Fable）。 */
	readonly scoped?: readonly IParadisLimitsWindow[];
}

/** `resets_at` を epoch ms にする。ISO 文字列・epoch 秒・epoch ms のどれでも受ける。 */
export function paradisParseClaudeResetAt(value: unknown): number | undefined {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			return undefined;
		}
		// 1e10 は現実的な epoch 秒（2286 年まで）と epoch ms（2001 年以降）の間にある。
		return value > 10_000_000_000 ? value : value * 1000;
	}
	if (typeof value !== 'string' || value.trim() === '') {
		return undefined;
	}
	const numeric = Number(value);
	if (Number.isFinite(numeric)) {
		return numeric > 10_000_000_000 ? numeric : numeric * 1000;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function paradisMapClaudeUsageWindow(raw: IParadisClaudeUsageWindowJson | null | undefined, label?: string): IParadisLimitsWindow | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const used = typeof raw.utilization === 'number' ? raw.utilization : typeof raw.used_percentage === 'number' ? raw.used_percentage : undefined;
	if (used === undefined || !Number.isFinite(used)) {
		return undefined;
	}
	return {
		usedPercent: Math.min(100, Math.max(0, used)),
		resetsAt: paradisParseClaudeResetAt(raw.resets_at),
		label,
	};
}

/** 使用量 API の応答を窓の一覧にする。形が崩れていても投げずに取れた分だけ返す。 */
export function paradisParseClaudeUsage(data: unknown): IParadisClaudeUsageWindows {
	if (!data || typeof data !== 'object') {
		return {};
	}
	const json = data as { five_hour?: IParadisClaudeUsageWindowJson | null; seven_day?: IParadisClaudeUsageWindowJson | null; limits?: unknown };
	const scoped: IParadisLimitsWindow[] = [];
	if (Array.isArray(json.limits)) {
		for (const entry of json.limits as IParadisClaudeUsageLimitJson[]) {
			if (!entry || typeof entry !== 'object' || entry.kind !== 'weekly_scoped') {
				continue;
			}
			const name = entry.scope?.model?.display_name;
			if (typeof name !== 'string' || name.trim() === '') {
				continue;
			}
			const window = paradisMapClaudeUsageWindow({ utilization: entry.percent, resets_at: entry.resets_at }, name.trim());
			if (window) {
				scoped.push(window);
			}
		}
	}
	return {
		fiveHour: paradisMapClaudeUsageWindow(json.five_hour),
		sevenDay: paradisMapClaudeUsageWindow(json.seven_day),
		scoped: scoped.length > 0 ? scoped : undefined,
	};
}

/**
 * `Retry-After` を秒にする。秒数と HTTP 日付の両方を受ける。壊れた値や過去の日付は undefined。
 */
export function paradisParseRetryAfterS(header: string | null | undefined, now: number): number | undefined {
	if (!header) {
		return undefined;
	}
	const seconds = Number(header.trim());
	if (Number.isFinite(seconds)) {
		return seconds >= 0 ? seconds : undefined;
	}
	const date = Date.parse(header);
	if (!Number.isFinite(date)) {
		return undefined;
	}
	const delta = (date - now) / 1000;
	return delta >= 0 ? delta : undefined;
}

// ---------- Claude Code の credentials JSON ----------

/** credentials JSON の `claudeAiOauth`。 */
export interface IParadisClaudeOAuthBlob {
	readonly accessToken?: unknown;
	readonly refreshToken?: unknown;
	readonly expiresAt?: unknown;
	readonly scopes?: unknown;
	readonly [key: string]: unknown;
}

function paradisParseJsonObject(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/** `claudeAiOauth` を取り出す。JSON でない・OAuth で無いときは undefined。 */
export function paradisParseClaudeOAuthBlob(credentialsJson: string | undefined): IParadisClaudeOAuthBlob | undefined {
	if (!credentialsJson) {
		return undefined;
	}
	const oauth = paradisParseJsonObject(credentialsJson)?.claudeAiOauth;
	return oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? oauth as IParadisClaudeOAuthBlob : undefined;
}

function paradisNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function paradisClaudeAccessToken(credentialsJson: string | undefined): string | undefined {
	return paradisNonEmptyString(paradisParseClaudeOAuthBlob(credentialsJson)?.accessToken);
}

export function paradisClaudeRefreshToken(credentialsJson: string | undefined): string | undefined {
	return paradisNonEmptyString(paradisParseClaudeOAuthBlob(credentialsJson)?.refreshToken);
}

/**
 * 切り替えに使える OAuth の認証情報か（アクセストークンとリフレッシュトークンの両方がある）。
 *
 * Claude Code は更新を拒否されると、その場でトークンの欄を空にする。空になった認証情報を
 * 保存すると、そのアカウントの唯一のリフレッシュトークンを空文字で上書きしてしまう。
 */
export function paradisIsUsableClaudeCredentials(credentialsJson: string | undefined): boolean {
	return paradisClaudeAccessToken(credentialsJson) !== undefined && paradisClaudeRefreshToken(credentialsJson) !== undefined;
}

/** アクセストークンが切れている、または切れかけているか。期限が分からないものも「切れかけ」とみなす。 */
export function paradisIsClaudeTokenExpiring(credentialsJson: string | undefined, now: number): boolean {
	const oauth = paradisParseClaudeOAuthBlob(credentialsJson);
	if (!oauth) {
		return false;
	}
	const expiresAt = oauth.expiresAt;
	if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
		return true;
	}
	return now + PARADIS_CLAUDE_OAUTH_EXPIRY_BUFFER_MS >= expiresAt;
}

/** トークンエンドポイントの応答。 */
export interface IParadisClaudeTokenResponse {
	readonly access_token?: unknown;
	readonly refresh_token?: unknown;
	readonly expires_in?: unknown;
	readonly scope?: unknown;
}

/**
 * 更新後のトークンを credentials JSON へ反映する。ほかの欄はそのまま残し、応答に無いものは
 * 上書きしない（サーバーがリフレッシュトークンを回さなかった場合は今のものを残す）。
 */
export function paradisApplyRefreshedClaudeToken(credentialsJson: string, response: IParadisClaudeTokenResponse, now: number): string | undefined {
	const parsed = paradisParseJsonObject(credentialsJson);
	const accessToken = paradisNonEmptyString(response.access_token);
	if (!parsed || !accessToken) {
		return undefined;
	}
	const oauth: Record<string, unknown> = { ...(parsed.claudeAiOauth as Record<string, unknown> | undefined) };
	oauth.accessToken = accessToken;
	if (typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)) {
		oauth.expiresAt = now + response.expires_in * 1000;
	}
	const refreshToken = paradisNonEmptyString(response.refresh_token);
	if (refreshToken) {
		oauth.refreshToken = refreshToken;
	}
	const scope = paradisNonEmptyString(response.scope);
	if (scope) {
		oauth.scopes = scope.split(' ');
	}
	return JSON.stringify({ ...parsed, claudeAiOauth: oauth });
}

// ---------- アカウントの身元（`~/.claude.json` の oauthAccount） ----------

/** アカウントの身元。どれも表示と照合にだけ使い、秘密の値は含まない。 */
export interface IParadisClaudeIdentity {
	readonly accountUuid?: string;
	readonly email?: string;
	readonly organizationUuid?: string;
	readonly organizationName?: string;
}

/** `oauthAccount`（Claude Code が `~/.claude.json` に書くもの）から身元を取り出す。 */
export function paradisClaudeIdentityFromOauthAccount(oauthAccount: unknown): IParadisClaudeIdentity | undefined {
	if (!oauthAccount || typeof oauthAccount !== 'object' || Array.isArray(oauthAccount)) {
		return undefined;
	}
	const record = oauthAccount as Record<string, unknown>;
	const identity: IParadisClaudeIdentity = {
		accountUuid: paradisNonEmptyString(record.accountUuid)?.trim(),
		email: (paradisNonEmptyString(record.emailAddress) ?? paradisNonEmptyString(record.email))?.trim(),
		organizationUuid: (paradisNonEmptyString(record.organizationUuid) ?? paradisNonEmptyString(record.organizationId))?.trim(),
		organizationName: paradisNonEmptyString(record.organizationName)?.trim(),
	};
	return identity.accountUuid || identity.email ? identity : undefined;
}

/**
 * 2 つの身元が同じアカウントを指すか。
 *
 * accountUuid が両方にあればそれで決める。無ければメールアドレス（大文字小文字は無視）で決める。
 * どちらの場合も、組織が両方に分かっていて食い違うなら別アカウントとみなす（同じメールで
 * 個人と組織の 2 つを持てるため）。
 */
export function paradisClaudeIdentitiesMatch(left: IParadisClaudeIdentity | undefined, right: IParadisClaudeIdentity | undefined): boolean {
	if (!left || !right) {
		return false;
	}
	if (left.organizationUuid && right.organizationUuid && left.organizationUuid !== right.organizationUuid) {
		return false;
	}
	if (left.accountUuid && right.accountUuid) {
		return left.accountUuid === right.accountUuid;
	}
	return !!left.email && !!right.email && left.email.toLowerCase() === right.email.toLowerCase();
}
