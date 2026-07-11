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

export interface IParadisWorkspaceLifecycleConfig {
	readonly setupScript?: string;
	readonly teardownScript?: string;
}

type ParadisWorkspaceConfigFile = {
	setupScript?: unknown;
	teardownScript?: unknown;
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

/** .paracode.json の内容から setupScript / teardownScript を読み取る（前後空白除去、文字列以外は無視）。 */
export function paradisParseWorkspaceLifecycleConfig(content: string): IParadisWorkspaceLifecycleConfig {
	const parsed = parseConfigFile(content);
	const setupScript = normalizeScript(parsed.setupScript);
	const teardownScript = normalizeScript(parsed.teardownScript);
	return {
		...(setupScript ? { setupScript } : {}),
		...(teardownScript ? { teardownScript } : {}),
	};
}

/** setupScript / teardownScript を更新した .paracode.json の内容を返す。presets 等の既存フィールドは保持する。 */
export function paradisUpdateWorkspaceLifecycleConfig(content: string | undefined, config: IParadisWorkspaceLifecycleConfig): string {
	const parsed = content === undefined ? {} : parseConfigFile(content);
	const setupScript = normalizeScript(config.setupScript);
	const teardownScript = normalizeScript(config.teardownScript);
	if (setupScript) { parsed.setupScript = setupScript; } else { delete parsed.setupScript; }
	if (teardownScript) { parsed.teardownScript = teardownScript; } else { delete parsed.teardownScript; }
	return `${JSON.stringify(parsed, undefined, '\t')}\n`;
}
