/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// リポジトリの .paracode.json に定義する setupScript / teardownScript の読み書き。
// 既存の presets フィールドや未知のフィールドを保持したまま、setupScript / teardownScript だけを更新する。

import { parse as parseJsonc } from '../../../../base/common/jsonc.js';
import { localize } from '../../../../nls.js';

export type ParadisWorkspaceLifecycleKind = 'setup' | 'teardown';

/** setup/teardown スクリプトの最長実行時間（分）の既定値。実行側とUI文言の両方から参照する。 */
export const PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES = 10;

/**
 * .paracode.json で指定できる実行時間の範囲（分）。
 * 上限を設けるのは、この値が「終わらないスクリプトで削除フローが永久に固まる」ことへの
 * 最後の防波堤だから。無制限を許すと防波堤そのものを外せてしまう。
 */
export const PARADIS_LIFECYCLE_TIMEOUT_MINUTES_MIN = 1;
export const PARADIS_LIFECYCLE_TIMEOUT_MINUTES_MAX = 120;

export interface IParadisWorkspaceLifecycleConfig {
	readonly setupScript?: string;
	readonly teardownScript?: string;
	/** setup スクリプトの最長実行時間（分）。未指定は {@link PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES}。 */
	readonly setupTimeoutMinutes?: number;
	/** teardown スクリプトの最長実行時間（分）。未指定は {@link PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES}。 */
	readonly teardownTimeoutMinutes?: number;
}

type ParadisWorkspaceConfigFile = {
	setupScript?: unknown;
	teardownScript?: unknown;
	setupTimeoutMinutes?: unknown;
	teardownTimeoutMinutes?: unknown;
	[key: string]: unknown;
};

function paradisInvalidConfigMessage(): string {
	// allow-any-unicode-next-line
	return localize('paradis.workspaceLifecycle.invalidConfig', ".paracode.json の内容が不正です（JSONC として解析できません）。");
}

function normalizeScript(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 設定値を実際に使う分数へ解決する。範囲外・数値以外・未指定はすべて既定値または境界へ丸める。
 *
 * 解決を1か所に集めるのは、この値が IPC 境界（shared process の runLifecycleScript）を越えて
 * 子プロセスの timeout になるため。読み取り側でしか検証しないと、チャネルを直接叩かれたときに
 * 上限のない timeout がそのまま渡る。
 */
export function paradisResolveLifecycleTimeoutMinutes(value: unknown): number {
	if (typeof value !== 'number' || !isFinite(value)) {
		return PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES;
	}
	// 分単位で丸めるのは、この値がそのままユーザーへの文言（「{n} 分以内に終了しなかった」）に
	// 出るため。小数を通すと「2.5 分」のような読みにくい表示になる。
	return Math.min(Math.max(Math.round(value), PARADIS_LIFECYCLE_TIMEOUT_MINUTES_MIN), PARADIS_LIFECYCLE_TIMEOUT_MINUTES_MAX);
}

function normalizeTimeoutMinutes(value: unknown): number | undefined {
	return typeof value === 'number' && isFinite(value) ? paradisResolveLifecycleTimeoutMinutes(value) : undefined;
}

function parseConfigFile(content: string): ParadisWorkspaceConfigFile {
	let parsed: unknown;
	try {
		parsed = parseJsonc<unknown>(content);
	} catch {
		throw new Error(paradisInvalidConfigMessage());
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(paradisInvalidConfigMessage());
	}
	return parsed as ParadisWorkspaceConfigFile;
}

/** .paracode.json の内容から setupScript / teardownScript とその実行時間上限を読み取る（前後空白除去、文字列以外は無視）。 */
export function paradisParseWorkspaceLifecycleConfig(content: string): IParadisWorkspaceLifecycleConfig {
	const parsed = parseConfigFile(content);
	const setupScript = normalizeScript(parsed.setupScript);
	const teardownScript = normalizeScript(parsed.teardownScript);
	const setupTimeoutMinutes = normalizeTimeoutMinutes(parsed.setupTimeoutMinutes);
	const teardownTimeoutMinutes = normalizeTimeoutMinutes(parsed.teardownTimeoutMinutes);
	return {
		...(setupScript ? { setupScript } : {}),
		...(teardownScript ? { teardownScript } : {}),
		...(setupTimeoutMinutes !== undefined ? { setupTimeoutMinutes } : {}),
		...(teardownTimeoutMinutes !== undefined ? { teardownTimeoutMinutes } : {}),
	};
}

/**
 * setupScript / teardownScript を更新した .paracode.json の内容を返す。presets 等の既存フィールドは保持する。
 * 実行時間の上限（setupTimeoutMinutes / teardownTimeoutMinutes）は GUI から編集しないため、
 * 既存の値をそのまま残す（未知フィールドと同じ扱い）。
 */
export function paradisUpdateWorkspaceLifecycleConfig(content: string | undefined, config: IParadisWorkspaceLifecycleConfig): string {
	const parsed = content === undefined ? {} : parseConfigFile(content);
	const setupScript = normalizeScript(config.setupScript);
	const teardownScript = normalizeScript(config.teardownScript);
	if (setupScript) { parsed.setupScript = setupScript; } else { delete parsed.setupScript; }
	if (teardownScript) { parsed.teardownScript = teardownScript; } else { delete parsed.teardownScript; }
	return `${JSON.stringify(parsed, undefined, '\t')}\n`;
}
