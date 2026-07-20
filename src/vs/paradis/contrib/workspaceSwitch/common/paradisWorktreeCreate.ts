/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「自然言語から worktree を作成してエージェントを実行」機能の共通型定義。
// shared process 側の git 実行チャネル (paradisWorktreeGitChannel.ts) と
// workbench 側のダイアログ (paradisCreateWorktreeDialog.ts) の間で共有する。

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { isLinux } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { GeneralShellType, TerminalShellType, WindowsShellType } from '../../../../platform/terminal/common/terminal.js';
import { ParadisWorkspaceLifecycleKind } from './paradisWorkspaceLifecycle.js';

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

/** 作業ツリーの未コミット差分の統計 (git diff HEAD --numstat の合算)。 */
export interface IParadisDiffStat {
	readonly insertions: number;
	readonly deletions: number;
}

/** GitHub PR の状態。GitHub の表示色に対応する4値。 */
export type ParadisPrState = 'open' | 'draft' | 'merged' | 'closed';

/** 作業ツリーの現在ブランチに紐づく GitHub PR の要約 (gh pr view の抜粋)。 */
export interface IParadisPrStatus {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly state: ParadisPrState;
}

/**
 * `gh pr view --json number,title,url,state,isDraft,headRefName` の stdout を IParadisPrStatus へ変換する。
 * `gh pr view` (引数なし) は過去の `gh pr checkout` が残した stale な tracking ref (refs/pull/N/head)
 * 経由で無関係な PR に一致することがある (Superset で実測) ため、PR の headRefName が現在の
 * ブランチ名と一致することを検証する。fork PR ではローカルブランチに fork owner の接頭辞が
 * 付くことがある ("owner/feature" と headRefName "feature") ので後方一致も許す。
 * 解釈できない・一致しない場合は undefined を返す (チップ非表示)。
 */
export function paradisParseGhPrStatus(stdout: string, currentBranch: string): IParadisPrStatus | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const pr = raw as { number?: unknown; title?: unknown; url?: unknown; state?: unknown; isDraft?: unknown; headRefName?: unknown };
	if (typeof pr.number !== 'number' || typeof pr.url !== 'string' || typeof pr.state !== 'string' || typeof pr.headRefName !== 'string') {
		return undefined;
	}
	// url は gh (GitHub API) の応答由来でクリック時に openerService へ渡すため、プロトコル
	// ハンドラ系スキーム (file:/vscode: 等) が紛れ込まないよう https/http に限定する
	if (!/^https?:\/\//.test(pr.url)) {
		return undefined;
	}
	if (currentBranch !== pr.headRefName && !currentBranch.endsWith(`/${pr.headRefName}`)) {
		return undefined;
	}
	let state: ParadisPrState;
	switch (pr.state) {
		case 'OPEN': state = pr.isDraft === true ? 'draft' : 'open'; break;
		case 'MERGED': state = 'merged'; break;
		case 'CLOSED': state = 'closed'; break;
		default: return undefined;
	}
	return { number: pr.number, title: typeof pr.title === 'string' ? pr.title : '', url: pr.url, state };
}

/** リポジトリ定義の setup/teardown スクリプトを worktree 上で実行する要求。 */
export interface IParadisRunLifecycleScriptRequest {
	/** 実行するスクリプトの種別。 */
	readonly kind: ParadisWorkspaceLifecycleKind;
	/** 親リポジトリのルートパス（PARACODE_PROJECT_ROOT_PATH に渡す）。 */
	readonly repoPath: string;
	/** スクリプトを実行する worktree のディレクトリパス（cwd になる）。 */
	readonly worktreePath: string;
	/** シェル経由で実行するスクリプト本文。 */
	readonly script: string;
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

/** エージェントのモデル選択肢1件分。 */
export interface IParadisAgentModelOption {
	readonly id: string;
	/** 選択肢として表示する名前。無ければ id を表示する。 */
	readonly label?: string;
	/** 選択時にコマンドへ付与するフラグ（例: --model opus）。 */
	readonly flag: string;
	/**
	 * このモデルで選べるエフォート id の一覧。空配列 = エフォート非対応（選択UIを無効化）。
	 * 未定義 = エージェント共通の全エフォート語彙（efforts）をそのまま許可する。
	 */
	readonly efforts?: readonly string[];
	/** 「既定」選択時に表示へ添える、そのモデルの実際の既定エフォート。 */
	readonly defaultEffort?: string;
}

/** エージェントのエフォート語彙1件分（id とフラグの組み立て方）。 */
export interface IParadisAgentEffortOption {
	readonly id: string;
	readonly flag: string;
}

/** エージェントの権限モード選択肢1件分。先頭要素を既定（通常はフラグなし）とする。 */
export interface IParadisAgentPermissionOption {
	readonly id: string;
	readonly label: string;
	readonly flag: string;
	/** true なら危険な選択肢として赤系ハイライト＋警告表示にする。 */
	readonly danger?: boolean;
	/** 選択時に表示する補足説明。 */
	readonly hint?: string;
}

/**
 * エージェント CLI の起動コマンドテンプレート。
 * `{prompt}` プレースホルダがシェルエスケープ済みのプロンプトに置換される。
 * プレースホルダが無い場合は末尾にエスケープ済みプロンプトを追加する。
 * `{model}` / `{effort}` / `{permission}` プレースホルダには選択したオプションのフラグが
 * 入る（未選択なら空文字）。これらのプレースホルダが無いテンプレートでは、選択された
 * フラグ一式をプロンプトの直前（プロンプトも無ければ末尾）へ挿入する。
 */
export interface IParadisAgentCommandTemplate {
	readonly id: string;
	readonly label: string;
	readonly command: string;
	/** モデル選択肢。未定義ならモデル選択UI自体を出さない。 */
	readonly models?: readonly IParadisAgentModelOption[];
	/** エフォート語彙。未定義ならエフォート選択UI自体を出さない。 */
	readonly efforts?: readonly IParadisAgentEffortOption[];
	/** 権限モード選択肢。未定義なら権限選択UI自体を出さない。 */
	readonly permissions?: readonly IParadisAgentPermissionOption[];
}

/** エージェント起動時のオプション選択（いずれも undefined = 既定 = フラグを付けない）。 */
export interface IParadisAgentLaunchOptions {
	readonly modelId?: string;
	readonly effortId?: string;
	readonly permissionId?: string;
}

/** Claude Code のエフォート語彙（2026-07時点の公式ドキュメント準拠）。 */
const CLAUDE_EFFORT_IDS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Codex GPT-5.6 系のエフォート語彙。旧世代モデルは ultra 非対応。 */
const CODEX_EFFORT_IDS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CODEX_LEGACY_EFFORT_IDS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// allow-any-unicode-next-line
const STR_PERMISSION_DEFAULT = localize('paradis.agentPermission.default', "通常（確認あり）");
// allow-any-unicode-next-line
const STR_PERMISSION_SKIP_ALL = localize('paradis.agentPermission.skipAll', "全許可");
// allow-any-unicode-next-line
const STR_PERMISSION_SKIP_ALL_HINT = localize('paradis.agentPermission.skipAllHint', "確認なしでコマンド実行・ファイル編集を行います");

/** 既定のエージェント定義。設定 paradis.workspaceSwitch.agents で上書き・追加できる。 */
export const PARADIS_DEFAULT_AGENT_COMMANDS: readonly IParadisAgentCommandTemplate[] = [
	{
		id: 'claude', label: 'Claude Code', command: 'claude {prompt}',
		models: [
			{ id: 'fable', label: 'fable (Fable 5)', flag: '--model fable', efforts: CLAUDE_EFFORT_IDS, defaultEffort: 'high' },
			{ id: 'opus', label: 'opus (Opus 4.8)', flag: '--model opus', efforts: CLAUDE_EFFORT_IDS, defaultEffort: 'high' },
			{ id: 'sonnet', label: 'sonnet (Sonnet 5)', flag: '--model sonnet', efforts: CLAUDE_EFFORT_IDS, defaultEffort: 'high' },
			// Haiku 4.5 はエフォート非対応（efforts: [] でエフォート欄を無効化する）
			{ id: 'haiku', label: 'haiku (Haiku 4.5)', flag: '--model haiku', efforts: [] },
			{ id: 'opusplan', label: 'opusplan', flag: '--model opusplan', efforts: CLAUDE_EFFORT_IDS, defaultEffort: 'high' },
		],
		efforts: CLAUDE_EFFORT_IDS.map(id => ({ id, flag: `--effort ${id}` })),
		permissions: [
			{ id: 'default', label: STR_PERMISSION_DEFAULT, flag: '' },
			{ id: 'skip-permissions', label: STR_PERMISSION_SKIP_ALL, flag: '--dangerously-skip-permissions', danger: true, hint: STR_PERMISSION_SKIP_ALL_HINT },
		],
	},
	{
		id: 'codex', label: 'Codex', command: 'codex {prompt}',
		models: [
			{ id: 'gpt-5.6-sol', flag: '--model gpt-5.6-sol', efforts: CODEX_EFFORT_IDS, defaultEffort: 'medium' },
			{ id: 'gpt-5.6-terra', flag: '--model gpt-5.6-terra', efforts: CODEX_EFFORT_IDS, defaultEffort: 'medium' },
			{ id: 'gpt-5.6-luna', flag: '--model gpt-5.6-luna', efforts: CODEX_EFFORT_IDS, defaultEffort: 'medium' },
			{ id: 'gpt-5.5', flag: '--model gpt-5.5', efforts: CODEX_LEGACY_EFFORT_IDS, defaultEffort: 'medium' },
			{ id: 'gpt-5.4', flag: '--model gpt-5.4', efforts: CODEX_LEGACY_EFFORT_IDS, defaultEffort: 'medium' },
		],
		efforts: CODEX_EFFORT_IDS.map(id => ({ id, flag: `--effort ${id}` })),
		permissions: [
			{ id: 'default', label: STR_PERMISSION_DEFAULT, flag: '' },
			{
				id: 'full-auto', label: 'full-auto', flag: '--full-auto',
				// allow-any-unicode-next-line
				hint: localize('paradis.agentPermission.fullAutoHint', "sandbox内で自動実行し、失敗時のみ確認します")
			},
			{
				// allow-any-unicode-next-line
				id: 'bypass', label: localize('paradis.agentPermission.bypass', "全バイパス"), flag: '--dangerously-bypass-approvals-and-sandbox', danger: true,
				// allow-any-unicode-next-line
				hint: localize('paradis.agentPermission.bypassHint', "承認もsandboxもすべて無効化します")
			},
		],
	},
	{
		id: 'gemini', label: 'Gemini CLI', command: 'gemini -i {prompt}',
		permissions: [
			{ id: 'default', label: STR_PERMISSION_DEFAULT, flag: '' },
			{ id: 'yolo', label: STR_PERMISSION_SKIP_ALL, flag: '--yolo', danger: true, hint: STR_PERMISSION_SKIP_ALL_HINT },
		],
	},
];

/**
 * 選択されたモデル/エフォート/権限をテンプレート定義に照らしてフラグ文字列へ解決する。
 * 選択されたエフォートが選択中モデルの対応外（model.efforts に無い）の場合は付与しない。
 */
export function paradisResolveAgentLaunchFlags(template: IParadisAgentCommandTemplate, options: IParadisAgentLaunchOptions | undefined): { model: string; effort: string; permission: string } {
	const modelOption = options?.modelId ? template.models?.find(model => model.id === options.modelId) : undefined;
	const model = modelOption?.flag ?? '';
	let effort = '';
	if (options?.effortId) {
		const allowedEfforts = modelOption?.efforts;
		if (allowedEfforts === undefined || allowedEfforts.includes(options.effortId)) {
			effort = template.efforts?.find(candidate => candidate.id === options.effortId)?.flag ?? '';
		}
	}
	const permission = options?.permissionId ? (template.permissions?.find(candidate => candidate.id === options.permissionId)?.flag ?? '') : '';
	return { model, effort, permission };
}

function paradisQuotePosixShellArg(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function paradisQuotePowerShellArg(value: string): string {
	return `'${value.replace(/'/g, '$&$&')}'`;
}

function paradisEncodeUtf16LeBase64(value: string): string {
	const bytes = new Uint8Array(value.length * 2);
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		bytes[index * 2] = codeUnit & 0xff;
		bytes[index * 2 + 1] = codeUnit >>> 8;
	}
	return encodeBase64(VSBuffer.wrap(bytes));
}

function paradisApplyPromptToTemplate(template: IParadisAgentCommandTemplate, promptExpression: string, options: IParadisAgentLaunchOptions | undefined): string {
	const flags = paradisResolveAgentLaunchFlags(template, options);
	let command = template.command;
	// プレースホルダがあるフラグはその位置へ置換し、無いフラグはプロンプトの直前
	// （プロンプトも無ければ末尾）へまとめて挿入する。プレースホルダを一部だけ書いた
	// カスタムテンプレートでも、選択されたフラグが黙って消えないようにする
	const leftoverFlags: string[] = [];
	for (const [placeholder, flag] of [['{model}', flags.model], ['{effort}', flags.effort], ['{permission}', flags.permission]] as const) {
		if (command.includes(placeholder)) {
			command = command.replace(placeholder, flag);
		} else if (flag.length > 0) {
			leftoverFlags.push(flag);
		}
	}
	if (leftoverFlags.length > 0) {
		const combined = leftoverFlags.join(' ');
		command = command.includes('{prompt}')
			? command.replace('{prompt}', `${combined} {prompt}`)
			: `${command} ${combined}`;
	}
	// 未選択プレースホルダの空置換で残る連続スペースを、プロンプト挿入前に正規化する
	// （プロンプト本文内の空白を巻き込まないよう、必ず置換前に行う）
	command = command.replace(/ {2,}/g, ' ').trim();
	if (command.includes('{prompt}')) {
		return command.replace('{prompt}', promptExpression);
	}
	return `${command} ${promptExpression}`;
}

/** cmd.exeでは任意文字列の安全な引数化が困難なため、Base64化したPowerShellスクリプトへ委譲する。 */
function paradisBuildCommandPromptAgentCommand(template: IParadisAgentCommandTemplate, prompt: string, options: IParadisAgentLaunchOptions | undefined): string {
	const promptBase64 = encodeBase64(VSBuffer.fromString(prompt));
	const command = paradisApplyPromptToTemplate(template, '$paradisPrompt', options);
	const script = `$paradisPrompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${promptBase64}')); ${command}`;
	return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${paradisEncodeUtf16LeBase64(script)}`;
}

/**
 * 実際のターミナルシェルに合わせ、テンプレートの {prompt} を安全な単一引数へ置換する。
 * プロンプトが空の場合は引数自体を付けない（`claude ''` のような空引数はTUIの初回入力を
 * 汚すため。{prompt} プレースホルダは空置換して連続スペースを正規化する）。
 */
export function paradisBuildAgentCommand(template: IParadisAgentCommandTemplate, prompt: string, shellType: TerminalShellType, options?: IParadisAgentLaunchOptions): string {
	if (prompt.trim().length === 0) {
		return paradisApplyPromptToTemplate(template, '', options).replace(/ {2,}/g, ' ').trim();
	}
	if (shellType === WindowsShellType.CommandPrompt) {
		return paradisBuildCommandPromptAgentCommand(template, prompt, options);
	}
	const quoted = shellType === GeneralShellType.PowerShell
		? paradisQuotePowerShellArg(prompt)
		: paradisQuotePosixShellArg(prompt);
	return paradisApplyPromptToTemplate(template, quoted, options);
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

/**
 * エージェント用ターミナルが作られない作成では、空の通常ターミナルを表示する。
 * （旧仕様ではプロンプト未入力でもtrueだったが、エージェント選択時はプロンプト無しでも
 * エージェントCLIを対話モードで起動するよう変更した。モバイルの起動シートと挙動を揃えるため）
 */
export function paradisShouldCreateDefaultTerminal(agentId: string, _prompt: string): boolean {
	return agentId === 'none';
}

// --- バックグラウンド作成の進行状況ストア -------------------------------------------------------

/** バックグラウンド作成中のジョブ1件分のスナップショット（Workspaces ビューの「作成中」行の材料）。 */
export interface IParadisWorktreeCreateJobSnapshot {
	readonly id: number;
	readonly repositoryId: string;
	/** 表示名。ブランチ名のLLM生成中でまだ確定していない間は undefined。 */
	readonly name?: string;
	/** 現在の工程の短い表示ラベル（例: setup スクリプトを実行中…）。 */
	readonly stageLabel: string;
}

export const IParadisWorktreeCreateProgressStore = createDecorator<IParadisWorktreeCreateProgressStore>('paradisWorktreeCreateProgressStore');

/**
 * バックグラウンド作成ジョブの進行状況ストア。
 * 書き込みは electron-browser のキューサービス (paradisWorktreeCreateQueue.ts) が行い、
 * Workspaces ビュー (browser 層) はここから読むだけ。Web ビルドでは常に空
 * （IParadisAgentStatusStore と同じ構成）。
 */
export interface IParadisWorktreeCreateProgressStore {
	readonly _serviceBrand: undefined;
	readonly onDidChangeJobs: Event<void>;
	readonly jobs: readonly IParadisWorktreeCreateJobSnapshot[];
	/** キューサービス専用の書き込み口。 */
	setJobs(jobs: readonly IParadisWorktreeCreateJobSnapshot[]): void;
}
