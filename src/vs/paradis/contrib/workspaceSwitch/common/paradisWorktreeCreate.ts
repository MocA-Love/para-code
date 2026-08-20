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
import { ParadisHostPath } from '../../../common/paradisHostPath.js';
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

/**
 * git worktree add の要求。パスはすべて「git を動かすマシン」から見たパス。
 *
 * 既定の `TPath` は {@link ParadisHostPath}。**送る側（renderer）は何も書き足さなくてよく**、
 * パスを `IParadisWorktreeGitHost.path()` 経由で作らない限り型エラーになる。
 * 電文を受け取る側（node）だけが `IParadisAddWorktreeRequest<string>` と明示して素の文字列を扱う。
 */
export interface IParadisAddWorktreeRequest<TPath extends string = ParadisHostPath> {
	/** 親リポジトリのルートパス。 */
	readonly repoPath: TPath;
	/** 作成する worktree のディレクトリパス（未存在であること）。 */
	readonly worktreePath: TPath;
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

/** 許可リストに載ったサブコマンドの、任意 git 実行の生の結果。呼び出し側が exit code で成否を判定する。 */
export interface IParadisWorktreeGitCommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
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

/** リポジトリ定義の setup/teardown スクリプトを worktree 上で実行する要求。`TPath` は {@link IParadisAddWorktreeRequest} と同じ意味。 */
export interface IParadisRunLifecycleScriptRequest<TPath extends string = ParadisHostPath> {
	/** 実行するスクリプトの種別。 */
	readonly kind: ParadisWorkspaceLifecycleKind;
	/** 親リポジトリのルートパス（PARACODE_PROJECT_ROOT_PATH に渡す）。 */
	readonly repoPath: TPath;
	/** スクリプトを実行する worktree のディレクトリパス（cwd になる）。 */
	readonly worktreePath: TPath;
	/** シェル経由で実行するスクリプト本文。 */
	readonly script: string;
	/**
	 * 最長実行時間（分）。リポジトリの .paracode.json が指定していれば渡す。未指定・範囲外は
	 * 実行側が既定値へ丸める（paradisResolveLifecycleTimeoutMinutes）。
	 */
	readonly timeoutMinutes?: number;
}

/** git worktree remove の要求。`TPath` は {@link IParadisAddWorktreeRequest} と同じ意味。 */
export interface IParadisRemoveWorktreeRequest<TPath extends string = ParadisHostPath> {
	/** 親リポジトリのルートパス。 */
	readonly repoPath: TPath;
	/** 削除対象の worktree のディレクトリパス。 */
	readonly worktreePath: TPath;
	/** true の場合 `git worktree remove --force`（未コミット変更や未追跡ファイルがあっても強制削除）。 */
	readonly force: boolean;
	/**
	 * true の場合、削除の前に `git worktree unlock` を試みる。
	 *
	 * ロック済みの worktree は `--force` を1つ付けただけでは消えない（git は `-f -f` を要求する。
	 * 1つ目は未コミット変更の上書き、2つ目がロックの上書きで意味が別）。ロックは「いま誰かが
	 * この作業ツリーを使っている」という主張なので、黙って2段目を付けるのではなく、呼び出し側が
	 * ロック理由をユーザーに見せて同意を取ったうえでこれを立てる。
	 */
	readonly unlock?: boolean;
}

/** `git worktree list --porcelain` の1エントリ（ロック判定に要るものだけ）。 */
export interface IParadisWorktreeListEntry {
	/** git が報告する作業ツリーのパス（macOS では実体解決済みで返る）。 */
	readonly path: string;
	readonly locked: boolean;
	/** ロック理由。理由なしでロックされている場合は空文字。 */
	readonly lockReason: string;
}

/** 1つの worktree のロック状態。 */
export interface IParadisWorktreeLockInfo {
	readonly locked: boolean;
	/**
	 * ロック理由の生の値。理由なし、または非ロック時は空文字。
	 * 表示に使うときは必ず {@link paradisFormatWorktreeLockReason} を通すこと
	 * （任意長・改行込みの文字列で、ダイアログのボタンを画面外へ押し出せる）。
	 */
	readonly reason: string;
}

/** ロック状態を問い合わせる要求（読み取り専用なので削除要求とは別の型にする）。 */
export interface IParadisWorktreeLockQuery<TPath extends string = ParadisHostPath> {
	readonly repoPath: TPath;
	readonly worktreePath: TPath;
}

/** ロック理由を確認ダイアログに載せる上限。これを超えたぶんは切る。 */
const PARADIS_LOCK_REASON_MAX_LENGTH = 200;

/**
 * ロック理由を1行に均して切り詰める。
 *
 * 理由はリポジトリ内の `.git/worktrees/<name>/locked` に誰でも書ける任意の文字列で、
 * clone してきたリポジトリにも付いてくる。長大な理由や大量の改行をそのままダイアログへ
 * 流すと、確認ボタンが画面の外へ出て「消せないし閉じられない」状態になりうる。
 */
export function paradisFormatWorktreeLockReason(reason: string): string {
	const flattened = reason.replace(/\s+/g, ' ').trim();
	// コードポイント単位で切る。`slice` だと絵文字の途中で割れて孤立サロゲートが残る。
	const points = Array.from(flattened);
	return points.length > PARADIS_LOCK_REASON_MAX_LENGTH
		? `${points.slice(0, PARADIS_LOCK_REASON_MAX_LENGTH).join('')}…`
		: flattened;
}

/** パスの突き合わせ方（プラットフォームで変わるので呼び出し側から渡す）。 */
export interface IParadisWorktreePathComparison {
	/** 大文字小文字を無視するか（Windows / macOS の既定のファイルシステム）。 */
	readonly ignoreCase: boolean;
	/** バックスラッシュを区切りとみなすか（Windows のみ）。 */
	readonly backslashIsSeparator: boolean;
}

/**
 * `git worktree list` の結果から、対象パスのロック状態を引く。
 *
 * パスを素の `===` で比べないのは、git が返す形と手元の形が揃わないため:
 *  - Windows では git はフォワードスラッシュで返す（`C:/Users/foo/wt`）が、`URI.fsPath` は
 *    バックスラッシュ（`C:\Users\foo\wt`）。ドライブレターの大小も揃わない
 *  - 末尾の区切りの有無も揃わない
 * ここが外れると「ロックされていない」と誤判定し、修正前とまったく同じ詰み（強制削除が
 * ロックで失敗する）に戻る。例外は出ないので、効いていないことに気づけない。
 *
 * 同じパスのエントリが複数あった場合はロックを OR で畳む。`.git/worktrees/<name>/locked` へ
 * 直接 NUL を書くと偽のエントリを注入でき、先頭一致だけを見ていると
 * 「ロックされていない」側の偽エントリでロックを隠せてしまうため。
 */
export function paradisFindWorktreeLock(
	entries: readonly IParadisWorktreeListEntry[],
	worktreePath: string,
	options: IParadisWorktreePathComparison,
): IParadisWorktreeLockInfo {
	let locked = false;
	let reason = '';
	for (const entry of entries) {
		if (!paradisSameWorktreePath(entry.path, worktreePath, options)) {
			continue;
		}
		if (entry.locked) {
			locked = true;
			reason ||= entry.lockReason;
		}
	}
	return { locked, reason };
}

/** 区切りと末尾スラッシュ、必要なら大文字小文字を無視してパスを比べる。 */
function paradisSameWorktreePath(a: string, b: string, options: IParadisWorktreePathComparison): boolean {
	const normalize = (value: string) => {
		// バックスラッシュを区切りとして潰すのは Windows だけ。Linux / macOS ではバックスラッシュは
		// 正当なファイル名文字なので、無条件に潰すと別々の作業ツリーを同一視してしまう。
		const separated = options.backslashIsSeparator ? value.replace(/\\/g, '/') : value;
		const trimmed = separated.replace(/\/+$/, '');
		return options.ignoreCase ? trimmed.toLowerCase() : trimmed;
	};
	const left = normalize(a);
	return left.length > 0 && left === normalize(b);
}

/**
 * `git worktree list --porcelain -z` の出力を解析する。
 *
 * `-z` を使うのは、ロック理由が任意のユーザー文字列で改行を含み得るため
 * （改行区切りの porcelain だと理由の2行目がそのまま次の属性行に見えてしまう）。
 * `-z` では各属性が NUL 終端で、エントリの区切りは空レコード（NUL の連続）になる。
 */
export function paradisParseWorktreeListPorcelain(output: string): IParadisWorktreeListEntry[] {
	const entries: IParadisWorktreeListEntry[] = [];
	let path: string | undefined;
	let locked = false;
	let lockReason = '';
	const flush = () => {
		if (path !== undefined) {
			entries.push({ path, locked, lockReason });
		}
		path = undefined;
		locked = false;
		lockReason = '';
	};
	for (const record of output.split('\0')) {
		if (record === '') {
			// 空レコード＝エントリの切れ目。末尾の余分な空レコードは flush が握り潰す。
			flush();
			continue;
		}
		if (record.startsWith('worktree ')) {
			// 区切りの空レコードが無い実装差に備えて、次の worktree 行でも確定させる。
			flush();
			path = record.slice('worktree '.length);
			continue;
		}
		if (record === 'locked') {
			locked = true;
			continue;
		}
		if (record.startsWith('locked ')) {
			locked = true;
			lockReason = record.slice('locked '.length);
		}
	}
	flush();
	return entries;
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
			{ id: 'opus', label: 'opus (Opus 5)', flag: '--model opus', efforts: CLAUDE_EFFORT_IDS, defaultEffort: 'high' },
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

/** 一覧に出す見出しの上限。長いと行が窮屈になり、ブランチ名や差分の表示を押し出す。 */
const PARADIS_WORKTREE_TITLE_MAX_CHARS = 24;

/** git のブランチ名として通す文字。ディレクトリ名も兼ねるので ASCII に限る。 */
const PARADIS_ASCII_BRANCH_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;

/** Windows が予約しているデバイス名。大小を問わず、`con.txt` のように拡張子が付いても使えない。 */
const PARADIS_WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 見出しから、表示を壊す文字を落とす。
 *
 * 入力は命名モデルの応答か利用者の依頼文なので、何が来てもおかしくない。textContent へ入れるので
 * スクリプトにはならないが、双方向制御文字が残ると**行全体の文字順が反転**し、ゼロ幅文字が残ると
 * 見えない字で幅だけ食う。Markdown の強調記号はモデルが好んで付けるので、引用符と同じ扱いで剥がす。
 */
function stripUnsafeTitleCharacters(text: string): string {
	let cleaned = '';
	for (const character of text) {
		const codePoint = character.codePointAt(0)!;
		// 制御文字・ゼロ幅・双方向制御（LRM/RLM/LRE..RLO/PDF/isolate 系）を落とす。
		if (codePoint <= 0x1f || codePoint === 0x7f
			|| codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d
			|| (codePoint >= 0x200e && codePoint <= 0x200f)
			|| (codePoint >= 0x202a && codePoint <= 0x202e)
			|| (codePoint >= 0x2066 && codePoint <= 0x2069)
			|| codePoint === 0xfeff) {
			cleaned += ' ';
			continue;
		}
		cleaned += character;
	}
	return cleaned;
}

/**
 * 自動生成された見出しを、一覧にそのまま出せる1行へ整える。使えなければ undefined。
 *
 * ブランチ名と違い、これは表示専用なので日本語をそのまま通す。ディレクトリ名にもブランチ名にも
 * 使われないため、ファイルシステムや git の制約は関係ない（paradisBuildWorktreeNames 参照）。
 */
export function paradisToWorktreeTitle(text: string | undefined): string | undefined {
	const firstLine = text?.split('\n')[0];
	if (firstLine === undefined) {
		return undefined;
	}
	// 引用符と Markdown の強調は、モデルが勝手に付けるだけで見出しの一部ではない。
	// allow-any-unicode-next-line
	const undecorated = stripUnsafeTitleCharacters(firstLine).replace(/^[\s"'`*_#「『]+|[\s"'`*_」』]+$/g, '');
	const collapsed = undecorated.replace(/\s+/g, ' ').trim();
	if (!collapsed) {
		return undefined;
	}
	// 日本語は1文字の情報量が大きいので、コードポイント単位で数える（サロゲートペアも壊さない）。
	const points = Array.from(collapsed);
	if (points.length <= PARADIS_WORKTREE_TITLE_MAX_CHARS) {
		return collapsed;
	}
	// 切ったことが分かるように省略記号を足す。CSS 側の省略とは別に、保存される値自体を短くする。
	return `${points.slice(0, PARADIS_WORKTREE_TITLE_MAX_CHARS).join('').trim()}\u2026`;
}

/**
 * 応答をブランチ名として使える形に整える。使えなければ undefined。
 *
 * 最後に ASCII を強制するのが要点。`paradisSanitizeBranchName` は git が禁じる記号しか落とさず
 * 日本語を素通しするため、これが無いと**日本語のブランチ名＝日本語の worktree ディレクトリ**が
 * できてしまう（Windows やツールチェーンで事故る）。見出し側で日本語を保持できるようになった以上、
 * ここは落として日付フォールバックに回しても情報は失われない。
 */
export function paradisToBranchName(text: string | undefined): string | undefined {
	const candidate = text?.trim().split('\n')[0].replace(/^["\'`]+|["\'`]+$/g, '').toLowerCase();
	if (!candidate) {
		return undefined;
	}
	// git が許す文字でも Windows のファイル名に使えない文字が混ざると作成そのものが失敗する。
	// 空文字ではなく `-` に置換するのは、`a<b` が `ab` と繋がって読めなくなるのを避けるため。
	const portable = paradisSanitizeBranchName(candidate.replace(/[<>|"]/g, '-'));
	// 40文字カットで末尾に - や . が残ると git が拒否するため、カット後にもう一度トリムする。
	const sliced = portable ? Array.from(portable).slice(0, 40).join('').replace(/[-./]+$/, '') : undefined;
	if (!sliced || PARADIS_WINDOWS_RESERVED_NAME_PATTERN.test(sliced)) {
		return undefined;
	}
	return PARADIS_ASCII_BRANCH_PATTERN.test(sliced) ? sliced : undefined;
}

/**
 * 命名モデルの応答から「見出し」と「ブランチ名」を取り出す。
 *
 * モデルは書式を守らない。太字(`**Title:**`)・箇条書き(`- Title:`)・番号(`1. Title:`)・
 * 日本語ラベルは実際に出てくるので、行頭の装飾を許して拾う。
 *
 * ラベルが1つも無い場合に「1行目＝ブランチ名」と決め打つのは危険で、指示が見出しを先に出させる以上、
 * 1行目は見出しであることが多い。ASCII のブランチ名として通る行を探し、無ければブランチ名は諦める
 * （日付フォールバックが必ず作れる）。ここを緩めると日本語がディレクトリ名になる。
 */
export function paradisParseWorktreeNaming(raw: string | undefined): { readonly title?: string; readonly branch?: string } {
	const text = raw?.trim();
	if (!text) {
		return { title: undefined, branch: undefined };
	}
	const lines = text.split('\n');
	let title: string | undefined;
	let branch: string | undefined;
	for (const line of lines) {
		// allow-any-unicode-next-line
		const matched = /^[\s>*\-#\d.)\]]*\**\s*(title|branch|\u30bf\u30a4\u30c8\u30eb|\u30d6\u30e9\u30f3\u30c1)\s*\**\s*[:\uff1a]\s*(.+?)\s*\**$/i.exec(line);
		if (!matched) {
			continue;
		}
		const value = matched[2].trim();
		// allow-any-unicode-next-line
		if (/^(title|\u30bf\u30a4\u30c8\u30eb)$/i.test(matched[1])) {
			title ??= value;
		} else {
			branch ??= value;
		}
	}
	if (title !== undefined || branch !== undefined) {
		return { title, branch };
	}
	// ラベル皆無: ブランチ名として通る行だけを候補にする。見出しは決められないので付けない。
	const branchLine = lines
		.map(line => line.trim().replace(/^["\'`]+|["\'`]+$/g, ''))
		.find(line => line.length > 0 && PARADIS_ASCII_BRANCH_PATTERN.test(line.toLowerCase()));
	return { title: undefined, branch: branchLine };
}

/**
 * worktree 作成時の表示名とディレクトリ名を決める。スペース名は表示専用。
 *
 * 手入力のスペース名が最優先。無ければ自動生成の見出しを使い、それも無ければディレクトリ名
 * （＝英字のブランチ名）へ落ちる。以前は常にこの最後の段だったため、名前を入れずに作ると
 * 一覧が英語のブランチ名で埋まっていた。
 */
export function paradisBuildWorktreeNames(spaceName: string, branchName: string, existingBranches: readonly string[] = [], existingDirNames: readonly string[] = [], suggestedTitle?: string): { displayName: string; dirName: string } {
	const dirName = paradisDeduplicateWorktreeDirName(branchName, existingBranches, existingDirNames);
	const displayName = spaceName.trim() || paradisToWorktreeTitle(suggestedTitle) || dirName;
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
	/**
	 * `git worktree add` が済んで実体ができた後の状態キー（それ以前は undefined）。
	 * これが付いたジョブは Workspaces ビューで専用の「作成中」行を出さず、実物の worktree 行の
	 * 2段目に工程ラベルを重ねる（同じ名前の行が2つ並ばないようにするため）。
	 */
	readonly stateKey?: string;
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
