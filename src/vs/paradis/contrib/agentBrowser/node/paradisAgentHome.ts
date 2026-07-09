/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントCLIの設定ホームディレクトリ解決 (shared process側)。
// Codex は $CODEX_HOME (既定 ~/.codex)、Claude Code は $CLAUDE_CONFIG_DIR (既定 ~/.claude) に
// 設定・hook・transcript (rollout) を保存する (両CLIの公式仕様)。hook設置・セッション探索・
// transcript許可rootの全経路がこの2関数を通ることで、home override環境でも検知が一貫する。
// 注意: shared process の process.env はGUI起動時に必ずしもログインシェルのexportを含まない
// (シェルrcでのみ設定している場合は拾えない)。その場合は既定パスへフォールバックするため、
// 従来 (ハードコード) と同じ挙動になる。

import { homedir } from 'os';
import { isAbsolute, join } from '../../../../base/common/path.js';

function resolveAgentHome(envVarName: string, fallbackDirName: string): string {
	const value = process.env[envVarName]?.trim();
	if (value !== undefined && value.length > 0 && isAbsolute(value)) {
		return value;
	}
	return join(homedir(), fallbackDirName);
}

/** Codex CLI の状態ディレクトリ ($CODEX_HOME、既定 ~/.codex)。hooks.json / sessions/ / config.toml の親。 */
export function paradisCodexHome(): string {
	return resolveAgentHome('CODEX_HOME', '.codex');
}

/** Claude Code の設定ディレクトリ ($CLAUDE_CONFIG_DIR、既定 ~/.claude)。settings.json / projects/ の親。 */
export function paradisClaudeConfigDir(): string {
	return resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude');
}
