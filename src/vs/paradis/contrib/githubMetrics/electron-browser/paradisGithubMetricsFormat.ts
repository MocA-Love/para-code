/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポップオーバー(案A)とダッシュボード(案B)で共有する表示用フォーマッタ。
// 同じ数値が2つの画面で違う丸め方をされないよう、整形は必ずここを通す。

import { localize } from '../../../../nls.js';

/**
 * GitHub のレート枠資源名を表示名にする。
 * `core` は GitHub の内部名で、ユーザーが見るドキュメント上は REST なので置き換える。
 */
export function paradisGithubResourceLabel(resource: string): string {
	switch (resource) {
		case 'core': return 'REST';
		case 'graphql': return 'GraphQL';
		case 'search': return localize('paradis.githubMetrics.resource.search', "Search");
		case 'code_search': return localize('paradis.githubMetrics.resource.codeSearch', "Code Search");
		case 'integration_manifest': return localize('paradis.githubMetrics.resource.integrationManifest', "App Manifest");
		default: return resource;
	}
}

/** 0〜1 の割合を整数%にする（表示のみ、計算には使わない）。 */
export function paradisGithubRoundedPercent(ratio: number): number {
	return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

/** 所要時間を `184ms` / `1.2s` にする。 */
export function paradisGithubFormatDuration(durationMs: number): string {
	if (durationMs >= 1000) {
		return `${(durationMs / 1000).toFixed(1)}s`;
	}
	return `${Math.round(durationMs)}ms`;
}
