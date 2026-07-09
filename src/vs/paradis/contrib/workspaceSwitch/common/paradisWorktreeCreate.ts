/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「自然言語から worktree を作成してエージェントを実行」機能の共通型定義。
// shared process 側の git 実行チャネル (paradisWorktreeGitChannel.ts) と
// workbench 側のダイアログ (paradisCreateWorktreeDialog.ts) の間で共有する。

import { isLinux } from '../../../../base/common/platform.js';

/** shared process 上で git worktree 操作を行う IPC チャネル名。 */
export const PARADIS_WORKTREE_GIT_CHANNEL = 'paradisWorktreeGit';

/** リポジトリのブランチ一覧の取得結果。 */
export interface IParadisGitBranches {
	/** ローカルブランチ名（コミット日時の新しい順）。 */
	readonly branches: string[];
	/** メインチェックアウトの現在ブランチ（detached HEAD なら undefined）。 */
	readonly head: string | undefined;
}

/** git worktree add の要求。パスはすべてネイティブファイルシステムパス。 */
export interface IParadisAddWorktreeRequest {
	/** 親リポジトリのルートパス。 */
	readonly repoPath: string;
	/** 作成する worktree のディレクトリパス（未存在であること）。 */
	readonly worktreePath: string;
	/** 新規作成するブランチ名。 */
	readonly newBranch: string;
	/** 分岐元 ref（ブランチ名・タグ・SHA）。 */
	readonly baseRef: string;
}

/** git worktree remove の要求。パスはすべてネイティブファイルシステムパス。 */
export interface IParadisRemoveWorktreeRequest {
	/** 親リポジトリのルートパス。 */
	readonly repoPath: string;
	/** 削除対象の worktree のディレクトリパス。 */
	readonly worktreePath: string;
	/** true の場合 `git worktree remove --force`（未コミット変更や未追跡ファイルがあっても強制削除）。 */
	readonly force: boolean;
}

/**
 * エージェント CLI の起動コマンドテンプレート。
 * `{prompt}` プレースホルダがシェルエスケープ済みのプロンプトに置換される。
 * プレースホルダが無い場合は末尾にエスケープ済みプロンプトを追加する。
 */
export interface IParadisAgentCommandTemplate {
	readonly id: string;
	readonly label: string;
	readonly command: string;
}

/** 既定のエージェント定義。設定 paradis.workspaceSwitch.agents で上書き・追加できる。 */
export const PARADIS_DEFAULT_AGENT_COMMANDS: readonly IParadisAgentCommandTemplate[] = [
	{ id: 'claude', label: 'Claude Code', command: 'claude {prompt}' },
	{ id: 'codex', label: 'Codex', command: 'codex {prompt}' },
	{ id: 'gemini', label: 'Gemini CLI', command: 'gemini -i {prompt}' },
];

/**
 * プロンプトを POSIX シェルのシングルクォート引数としてエスケープする。
 * （' を '\'' に置換して全体を ' で包む定番手法。）
 */
export function paradisQuoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** テンプレートの {prompt} を置換して実行コマンド文字列を組み立てる。 */
export function paradisBuildAgentCommand(template: IParadisAgentCommandTemplate, prompt: string): string {
	const quoted = paradisQuoteShellArg(prompt);
	if (template.command.includes('{prompt}')) {
		return template.command.replace('{prompt}', quoted);
	}
	return `${template.command} ${quoted}`;
}

/**
 * ブランチ名として安全な形へ正規化する（git check-ref-format のサブセット）。
 * 空になった場合は undefined を返す。
 */
export function paradisSanitizeBranchName(value: string): string | undefined {
	const sanitized = value.trim()
		.replace(/\s+/g, '-')
		.replace(/[~^:?*\[\]\\\x00-\x1f\x7f]/g, '')
		.replace(/\.{2,}/g, '.')
		.replace(/@\{/g, '')
		.replace(/\/{2,}/g, '/')
		.replace(/^[-./]+|[-./]+$/g, '')
		.replace(/\.lock$/i, '');
	return sanitized.length > 0 ? sanitized : undefined;
}

/** worktree のディレクトリ名として使える形へ正規化する（ブランチ名の / も潰す）。 */
export function paradisSanitizeWorktreeDirName(value: string): string | undefined {
	const sanitized = paradisSanitizeBranchName(value)?.replace(/\//g, '-');
	return sanitized && sanitized.length > 0 ? sanitized : undefined;
}

function paradisNameComparisonKey(value: string, ignoreCase: boolean): string {
	return ignoreCase ? value.toLowerCase() : value;
}

/** 既存ブランチとファイルシステム上で衝突しないブランチ名を返す。 */
export function paradisDeduplicateBranchName(branchName: string, existingBranches: readonly string[], ignoreCase: boolean = !isLinux): string {
	const occupiedBranchNames = new Set(existingBranches.map(name => paradisNameComparisonKey(name, ignoreCase)));
	if (!occupiedBranchNames.has(paradisNameComparisonKey(branchName, ignoreCase))) {
		return branchName;
	}
	for (let suffix = 2; ; suffix++) {
		const candidate = `${branchName}-${suffix}`;
		if (!occupiedBranchNames.has(paradisNameComparisonKey(candidate, ignoreCase))) {
			return candidate;
		}
	}
}

/** 既存ブランチ由来の名前や既存worktreeの実ディレクトリ名と衝突しない名前を返す。 */
export function paradisDeduplicateWorktreeDirName(branchName: string, existingBranches: readonly string[], existingDirNames: readonly string[] = [], ignoreCase: boolean = !isLinux): string {
	const baseDirName = paradisSanitizeWorktreeDirName(branchName)!;
	const occupiedDirNames = new Set(existingBranches
		.map(paradisSanitizeWorktreeDirName)
		.filter((name): name is string => typeof name === 'string')
		.map(name => paradisNameComparisonKey(name, ignoreCase)));
	for (const existingDirName of existingDirNames) {
		const sanitized = paradisSanitizeWorktreeDirName(existingDirName);
		if (sanitized) {
			occupiedDirNames.add(paradisNameComparisonKey(sanitized, ignoreCase));
		}
	}
	if (!occupiedDirNames.has(paradisNameComparisonKey(baseDirName, ignoreCase))) {
		return baseDirName;
	}
	for (let suffix = 2; ; suffix++) {
		const candidate = `${baseDirName}-${suffix}`;
		if (!occupiedDirNames.has(paradisNameComparisonKey(candidate, ignoreCase))) {
			return candidate;
		}
	}
}

/** worktree 作成時の表示名とディレクトリ名を決める。スペース名は表示専用。 */
export function paradisBuildWorktreeNames(spaceName: string, branchName: string, existingBranches: readonly string[] = [], existingDirNames: readonly string[] = []): { displayName: string; dirName: string } {
	const dirName = paradisDeduplicateWorktreeDirName(branchName, existingBranches, existingDirNames);
	const displayName = spaceName.trim() || dirName;
	return { displayName, dirName };
}

/** エージェント用ターミナルが作られない作成では、空の通常ターミナルを表示する。 */
export function paradisShouldCreateDefaultTerminal(agentId: string, prompt: string): boolean {
	return agentId === 'none' || prompt.trim().length === 0;
}
