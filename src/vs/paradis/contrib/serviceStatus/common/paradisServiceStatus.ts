/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーの Claude / Codex(OpenAI) / GitHub サービスステータス表示の共有型と純粋ロジック
// (環境非依存)。各サービスは statuspage.io 系のパブリック API を持ち、レスポンス形状は共通
// (`status.indicator` が "none" | "minor" | "major" | "critical"、`status.description` が
// 人間可読の説明文)なので、パース・重大度マッピングをここへ集約する。
// 取得(electron-browser/paradisServiceStatusClient.ts)とUI(electron-browser/*)は
// このファイルの型だけに依存する。

import { localize } from '../../../../nls.js';

export type ParadisServiceStatusProvider = 'claude' | 'codex' | 'github';

export const PARADIS_SERVICE_STATUS_PROVIDERS: readonly ParadisServiceStatusProvider[] = ['claude', 'codex', 'github'];

export class ParadisServiceStatusFailureEpisodeTracker {
	private readonly failingProviders = new Set<ParadisServiceStatusProvider>();

	recordFailure(provider: ParadisServiceStatusProvider): boolean {
		if (this.failingProviders.has(provider)) {
			return false;
		}
		this.failingProviders.add(provider);
		return true;
	}

	recordSuccess(provider: ParadisServiceStatusProvider): void {
		this.failingProviders.delete(provider);
	}
}

/** 表示用に丸めた重大度。`unknown` は取得失敗・未取得、`maintenance` は計画メンテナンス中を表す。 */
export type ParadisServiceStatusSeverity = 'ok' | 'minor' | 'major' | 'maintenance' | 'unknown';

/** CSSクラスの付け外し(`classList.remove(...)`)で全パターンを列挙する側で使う。 */
export const PARADIS_SERVICE_STATUS_SEVERITIES: readonly ParadisServiceStatusSeverity[] = ['ok', 'minor', 'major', 'maintenance', 'unknown'];

export const PARADIS_SERVICE_STATUS_SETTING_ENABLED = 'paradis.serviceStatus.enabled';

export interface IParadisServiceStatusSource {
	readonly label: string;
	/** statuspage.io API v2 summary エンドポイント。 */
	readonly apiUrl: string;
	/** 人間が見るステータスページ(ポップオーバーのリンク先)。 */
	readonly statusPageUrl: string;
}

/** プロバイダーごとの取得元。表示名・URLはここだけを直す。 */
export const PARADIS_SERVICE_STATUS_SOURCES: Readonly<Record<ParadisServiceStatusProvider, IParadisServiceStatusSource>> = {
	claude: {
		label: 'Claude',
		// status.anthropic.com は status.claude.com へ301リダイレクトするが、そのリダイレクト応答に
		// Access-Control-Allow-Origin が無いため、renderer からの fetch (CORS mode) は
		// リダイレクトを辿れず失敗する(ヘッドレスChromeで実測確認)。直接 status.claude.com を叩く。
		apiUrl: 'https://status.claude.com/api/v2/summary.json',
		statusPageUrl: 'https://status.claude.com',
	},
	codex: {
		label: 'OpenAI',
		apiUrl: 'https://status.openai.com/api/v2/summary.json',
		statusPageUrl: 'https://status.openai.com',
	},
	github: {
		label: 'GitHub',
		apiUrl: 'https://www.githubstatus.com/api/v2/summary.json',
		statusPageUrl: 'https://www.githubstatus.com',
	},
};

/** 1サービス分の表示用スナップショット。 */
export interface IParadisServiceStatusEntry {
	readonly provider: ParadisServiceStatusProvider;
	readonly severity: ParadisServiceStatusSeverity;
	/** API の `status.description`。取得失敗時は undefined。 */
	readonly description: string | undefined;
	readonly fetchedAt: number;
	/** 取得に失敗した理由(タイムアウト・ネットワークエラー等)。UIの補足表示用。 */
	readonly error: string | undefined;
}

export interface IParadisServiceStatusSnapshot {
	readonly generatedAt: number;
	readonly entries: Readonly<Record<ParadisServiceStatusProvider, IParadisServiceStatusEntry>>;
}

/** statuspage.io API v2 summary.json の `status` 部分だけを最小限パースする。 */
export function paradisParseServiceStatusIndicator(json: unknown): { indicator: string; description: string | undefined } | undefined {
	if (typeof json !== 'object' || json === null) {
		return undefined;
	}
	const status = (json as { status?: unknown }).status;
	if (typeof status !== 'object' || status === null) {
		return undefined;
	}
	const indicator = (status as { indicator?: unknown }).indicator;
	if (typeof indicator !== 'string') {
		return undefined;
	}
	const description = (status as { description?: unknown }).description;
	return { indicator, description: typeof description === 'string' ? description : undefined };
}

/** `status.indicator` を表示用の3段階(+メンテナンス中/不明)へ丸める。 */
export function paradisServiceStatusSeverity(indicator: string | undefined): ParadisServiceStatusSeverity {
	switch (indicator) {
		case 'none':
			return 'ok';
		case 'minor':
			return 'minor';
		case 'major':
		case 'critical':
			return 'major';
		case 'maintenance':
			return 'maintenance';
		default:
			return 'unknown';
	}
}

/** 重大度の表示ラベル。トリガーの `aria-label` とポップオーバーのバッジで共有する。 */
export function paradisServiceStatusSeverityLabel(severity: ParadisServiceStatusSeverity): string {
	switch (severity) {
		case 'ok':
			return localize('paradis.serviceStatus.severity.ok', "正常");
		case 'minor':
			return localize('paradis.serviceStatus.severity.minor', "軽微な障害");
		case 'major':
			return localize('paradis.serviceStatus.severity.major', "大規模な障害");
		case 'maintenance':
			return localize('paradis.serviceStatus.severity.maintenance', "メンテナンス中");
		default:
			return localize('paradis.serviceStatus.severity.unknown', "不明");
	}
}
