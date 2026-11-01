/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * タスクボードの SSH 中継（q.html Q472 = A、Q525）のうち、接続先（REH）で掛ける検査の純関数。
 *
 * ボード（app/taskboard/server）は信用しない側に置く。ボードから届くのは「どの操作を・どの値で」だけで、git の argv・
 * 絶対パス・環境変数は送れない。ここでは操作ごとに argv を組み立て、値（ブランチ名・相対パス・コミットのメッセージ）の
 * 形を確かめる。許すかどうか（コマンドの承認、push の確認）は手元のウィンドウで決め、ここでは扱わない。
 * 設計書は taskboard-ssh-relay-design.html（リポジトリ直下、git の管理外）。
 */

import { paradisRestrictedGitArgsError } from '../../workspaceSwitch/common/paradisGitRestrictedArgs.js';

/** REH のチャネル名。 */
export const PARADIS_TASK_BOARD_REMOTE_CHANNEL = 'paradisTaskBoardRemote';

/** 上限と時間（設計書 4 節「同時実行・タイムアウト・切断」）。 */
export const PARADIS_TASK_BOARD_REMOTE_LIMITS = {
	/** 1 セッションで同時に走らせる工程のコマンド。3 本目は待たせず断る。 */
	maxConcurrentCommands: 2,
	/** 1 セッションで同時に動かす操作（git とコマンドの合計）。 */
	maxInFlight: 8,
	/** git の待ち行列（リポジトリごとに 1 列）の長さ。 */
	maxQueued: 32,
	/** 工程のコマンドの打ち切り（ボードの MAX_RUN_MS と同じ 60 分）。 */
	commandTimeoutMs: 60 * 60 * 1000,
	/** SIGTERM から SIGKILL までの猶予。 */
	killGraceMs: 5000,
	/** 終わった後、出力をつかんだまま残った孫を待たずに切り上げるまで。 */
	closeGraceMs: 2000,
	/** 出力をまとめて流す間隔。 */
	outputFlushMs: 250,
	/** 1 回に流す行数（超えた分は古い方を省く）。 */
	outputLinesPerFlush: 200,
	/** 改行が来ないまま溜まった出力を 1 行として流す長さ。 */
	outputMaxPendingChars: 16 * 1024,
	/** 結果として返す stdout。 */
	maxKeptStdoutChars: 1024 * 1024,
	/** 1 回の実行で流す出力の合計。超えたら捨てて省略と出す。 */
	maxOutputChars: 16 * 1024 * 1024,
	/** git の出力（stdout と stderr それぞれ）。 */
	maxGitOutputChars: 4 * 1024 * 1024,
	/** 工程のコマンドの本文の長さ。 */
	maxCommandChars: 16 * 1024,
	/** 読むファイル（成果物）の大きさ。 */
	maxReadBytes: 4 * 1024 * 1024,
	/** 書くファイル（フローの定義、`.para/` の中）の大きさ。 */
	maxWriteBytes: 1024 * 1024,
	/** この間ウィンドウから心拍が来なければ、そのセッションの実行をすべて止める。 */
	heartbeatExpiryMs: 120 * 1000,
} as const;

/** 断った理由の種類。IPC では message の先頭の `[code]` で伝わる。 */
export type ParadisTaskBoardRemoteErrorCode = 'invalid' | 'denied' | 'busy' | 'unknown-session' | 'unsupported';

export class ParadisTaskBoardRemoteError extends Error {
	constructor(readonly code: ParadisTaskBoardRemoteErrorCode, message: string) {
		super(`[${code}] ${message}`);
		this.name = 'ParadisTaskBoardRemoteError';
	}
}

function invalid(message: string): never {
	throw new ParadisTaskBoardRemoteError('invalid', message);
}

function denied(message: string): never {
	throw new ParadisTaskBoardRemoteError('denied', message);
}

/** 制御文字（タブを除く C0、DEL、C1）。 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

/**
 * ブランチの名前として受けるか。git の規則（check-ref-format）より狭く、英数字と `._/-` だけにする。
 * `-` で始まるもの（オプションに読める）、`..`・`//`・`@{`、`.` で始まる段、`.lock` で終わる段、`HEAD` は断る。
 */
export function paradisTaskBoardRemoteBranchError(branch: unknown): string | undefined {
	if (typeof branch !== 'string' || branch.length === 0 || branch.length > 200) {
		return 'branch must be 1-200 characters';
	}
	if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
		return `branch has characters that are not allowed: ${branch}`;
	}
	if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('..') || branch.includes('//') || branch === 'HEAD') {
		return `branch is not allowed: ${branch}`;
	}
	if (branch.split('/').some(segment => segment.startsWith('.') || segment.endsWith('.lock'))) {
		return `branch is not allowed: ${branch}`;
	}
	return undefined;
}

function checkBranch(branch: unknown): string {
	const error = paradisTaskBoardRemoteBranchError(branch);
	if (error !== undefined) {
		invalid(error);
	}
	return branch as string;
}

/**
 * 作業場所の root からの相対パスとして受けるか。絶対パス、`..`・`.`・空の段、NUL、`\`（接続先は POSIX）を断る。
 * symlink かどうかは node 側で 1 段ずつ確かめる（ここは文字列の形だけ）。
 */
export function paradisTaskBoardRemoteRelativePathError(relativePath: unknown): string | undefined {
	if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 1024) {
		return 'path must be 1-1024 characters';
	}
	if (relativePath.includes('\0') || relativePath.includes('\\') || relativePath.startsWith('/')) {
		return `path is not a relative POSIX path: ${relativePath}`;
	}
	for (const segment of relativePath.split('/')) {
		if (segment === '' || segment === '.' || segment === '..' || segment.length > 255) {
			return `path is not allowed: ${relativePath}`;
		}
	}
	return undefined;
}

/** 相対パスを段に分ける（形を確かめてから）。 */
export function paradisTaskBoardRemoteSegments(relativePath: unknown): string[] {
	const error = paradisTaskBoardRemoteRelativePathError(relativePath);
	if (error !== undefined) {
		invalid(error);
	}
	return (relativePath as string).split('/');
}

/** 接続先の絶対パスとして受けるか（形だけ。持ち主と置き場は node 側で確かめる）。 */
export function paradisTaskBoardRemoteAbsolutePathError(absolutePath: unknown): string | undefined {
	if (typeof absolutePath !== 'string' || absolutePath.length < 2 || absolutePath.length > 4096 || !absolutePath.startsWith('/')) {
		return 'path must be an absolute POSIX path';
	}
	if (absolutePath.includes('\0') || absolutePath.includes('\\') || absolutePath.endsWith('/')) {
		return `path is not allowed: ${absolutePath}`;
	}
	if (absolutePath.slice(1).split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
		return `path is not normalized: ${absolutePath}`;
	}
	return undefined;
}

/** ボードのフロー定義のファイル（読み書きしてよいのはこの 3 つだけ）。login は flows.ts と同じ形。 */
export function paradisTaskBoardRemoteFlowFile(scope: unknown, login?: unknown): string {
	switch (scope) {
		case 'team': return '.para-code/paracode.json';
		case 'legacy': return '.paracode.json';
		case 'personal':
			if (typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
				invalid('login is not a GitHub login');
			}
			return `.para-code/${login}/workflows.json`;
		default:
			return invalid('unknown flow file scope');
	}
}

/** ボードが作業場所に置くフォルダ（`.git/info/exclude` で除外する）。 */
export const PARADIS_TASK_BOARD_REMOTE_BOARD_DIR = '.para';

/**
 * 書いてよい相対パスか。フローの定義の 3 ファイルと、`.para/` の中だけ。
 */
export function paradisTaskBoardRemoteIsWritablePath(relativePath: string): boolean {
	if (relativePath === '.para-code/paracode.json' || relativePath === '.paracode.json' || /^\.para-code\/[A-Za-z0-9-]{1,39}\/workflows\.json$/.test(relativePath)) {
		return true;
	}
	return relativePath.startsWith(`${PARADIS_TASK_BOARD_REMOTE_BOARD_DIR}/`);
}

/**
 * ボードへ渡してよい（読んでよい）相対パスか。`.para/` の中と、フローの定義の 3 ファイルだけ。どの段にも `.git` を含むものは断る。
 * 作業場所のほかのファイル（`.env`、`.git/config` のトークン、鍵など）は、信用しない側のボードへ渡さない（設計書 I2）。
 */
export function paradisTaskBoardRemoteIsReadablePath(relativePath: string): boolean {
	if (relativePath.split('/').some(segment => segment.toLowerCase() === '.git')) {
		return false;
	}
	return paradisTaskBoardRemoteIsWritablePath(relativePath);
}

/**
 * `git remote get-url` の出力から、URL の利用者の部分（`https://user:token@host/...` の `user:token@`）を取り除く。
 * パスワードに `@` を含む形（`user:p@ss@host`）も外せるよう、authority の中の最後の `@` までを外す。
 * scp の形（`git@host:owner/repo`）は認証情報を含まないので、そのまま返す。
 */
export function paradisTaskBoardRemoteStripUrlCredentials(output: string): string {
	return output.split('\n').map(line => line.replace(/^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, '$<scheme>')).join('\n');
}

/** 履歴の位置。文字列で受けず、形を決めて ref の完全な名前に直す（オプションや範囲の式に読ませない）。 */
export type ParadisTaskBoardRemoteRev =
	| { readonly kind: 'head' }
	| { readonly kind: 'local'; readonly branch: string }
	| { readonly kind: 'remote'; readonly branch: string };

function revArg(rev: unknown): string {
	if (!rev || typeof rev !== 'object') {
		return invalid('rev must be an object');
	}
	const value = rev as { kind?: unknown; branch?: unknown };
	switch (value.kind) {
		case 'head': return 'HEAD';
		case 'local': return `refs/heads/${checkBranch(value.branch)}`;
		case 'remote': return `refs/remotes/origin/${checkBranch(value.branch)}`;
		default: return invalid('unknown rev kind');
	}
}

/** ブランチの作り方（ボードの workspaces.ts と同じ 3 通り）。 */
export type ParadisTaskBoardRemoteBranchMode = 'existing' | 'track' | 'new';

/**
 * 接続先で打つ git の操作。ボードが今打っている git（workspaces.ts・runner.ts・main.ts）を意味の単位にまとめたもの。
 * 任意の引数は受けない。
 */
export type ParadisTaskBoardRemoteGitOp =
	| { readonly kind: 'toplevel' }
	| { readonly kind: 'commonDir' }
	| { readonly kind: 'excludePath' }
	| { readonly kind: 'remoteUrl'; readonly push: boolean }
	| { readonly kind: 'defaultBranch' }
	| { readonly kind: 'status' }
	| { readonly kind: 'currentBranch' }
	| { readonly kind: 'refExists'; readonly rev: ParadisTaskBoardRemoteRev }
	| { readonly kind: 'aheadCount'; readonly base: ParadisTaskBoardRemoteRev; readonly head: ParadisTaskBoardRemoteRev }
	| { readonly kind: 'boardDirTracked' }
	| { readonly kind: 'fetch'; readonly prune: boolean }
	| { readonly kind: 'worktreeList' }
	| { readonly kind: 'worktreeAdd'; readonly dir: string; readonly branch: string; readonly mode: ParadisTaskBoardRemoteBranchMode; readonly base?: ParadisTaskBoardRemoteRev }
	| { readonly kind: 'worktreeRemove'; readonly dir: string }
	| { readonly kind: 'switch'; readonly branch: string; readonly mode: ParadisTaskBoardRemoteBranchMode; readonly base?: ParadisTaskBoardRemoteRev }
	| { readonly kind: 'mergeFfOnly'; readonly branch: string }
	| { readonly kind: 'detach'; readonly base: ParadisTaskBoardRemoteRev }
	| { readonly kind: 'addTracked' }
	| { readonly kind: 'commit'; readonly message: string }
	| { readonly kind: 'push'; readonly branch: string; readonly setUpstream: boolean; readonly defaultBranch: string | undefined };

export type ParadisTaskBoardRemoteGitOpKind = ParadisTaskBoardRemoteGitOp['kind'];

/** 組み立てた git。 */
export interface IParadisTaskBoardRemoteGitPlan {
	/** `git` の後ろに付ける引数（`-C` と `-c` を含む）。 */
	readonly args: readonly string[];
	/** 作業ツリーも参照も変えない操作（fsmonitor を止めて読む）。 */
	readonly readOnly: boolean;
	/** リモートとやり取りする（長い打ち切り時間を使う）。 */
	readonly network: boolean;
	/** フックを走らせうる（commit・push。長い打ち切り時間を使う）。 */
	readonly hooks: boolean;
}

const READ_ONLY_KINDS: ReadonlySet<string> = new Set(['toplevel', 'commonDir', 'excludePath', 'remoteUrl', 'defaultBranch', 'status', 'currentBranch', 'refExists', 'aheadCount', 'boardDirTracked', 'worktreeList']);

/** ここで組み立てた argv にも重ねて掛ける、外部コマンドの実行やリポジトリの差し替えにつながるオプション（runGit と同じ）。 */
const FORBIDDEN_ARGUMENT = /^--(upload-pack|receive-pack|exec|git-dir|work-tree|config-env|output|force|mirror|delete|all|tags)\b|^-[A-Za-z]*f[A-Za-z]*$/;

/** 既定のブランチとして必ず断る名前（`origin/HEAD` が分からないときの守り）。 */
const ALWAYS_PROTECTED_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

/**
 * 既定のブランチへの push か。`paradisRestrictedGitArgsError` は強制だけを止め、既定のブランチへの早送りは通すので、
 * 中継ではこれを足す（設計書 4 節「push は『ボードが作ったブランチへの早送り』だけ」）。
 */
export function paradisTaskBoardRemoteIsProtectedBranch(branch: string, defaultBranch: string | undefined): boolean {
	return ALWAYS_PROTECTED_BRANCHES.has(branch) || (defaultBranch !== undefined && branch === defaultBranch);
}

function commitMessage(message: unknown): string {
	if (typeof message !== 'string' || message.trim().length === 0 || message.length > 500) {
		return invalid('commit message must be 1-500 characters');
	}
	if (CONTROL_CHARACTERS.test(message)) {
		return invalid('commit message must be a single line without control characters');
	}
	return message;
}

function absoluteDir(dir: unknown): string {
	const error = paradisTaskBoardRemoteAbsolutePathError(dir);
	if (error !== undefined) {
		invalid(error);
	}
	return dir as string;
}

function branchMode(mode: unknown): ParadisTaskBoardRemoteBranchMode {
	if (mode !== 'existing' && mode !== 'track' && mode !== 'new') {
		return invalid('unknown branch mode');
	}
	return mode;
}

/**
 * `worktree add`（dir あり）と `switch`（dir なし）の、ブランチの作り方ごとの引数。
 * existing は既にあるローカルのブランチ、track は origin の同名のブランチを追う新しいブランチ、new は base から作る。
 */
function branchArgs(op: Record<string, unknown>, dir: string | undefined): string[] {
	const branch = checkBranch(op.branch);
	const at = dir !== undefined ? [dir] : [];
	const create = dir !== undefined ? '-b' : '-c';
	switch (branchMode(op.mode)) {
		case 'existing': return [...at, branch];
		case 'track': return ['--track', create, branch, ...at, `refs/remotes/origin/${branch}`];
		case 'new': return ['--no-track', create, branch, ...at, revArg(op.base)];
	}
}

/** 操作の本体の argv（`-C`・`-c` の前置きを除く）と、検査から外す値の位置。 */
function operationArgs(op: { readonly kind?: unknown } & Record<string, unknown>): { readonly args: string[]; readonly valueIndex?: number } {
	switch (op.kind) {
		case 'toplevel': return { args: ['rev-parse', '--show-toplevel'] };
		case 'commonDir': return { args: ['rev-parse', '--path-format=absolute', '--git-common-dir'] };
		case 'excludePath': return { args: ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'] };
		case 'remoteUrl': return { args: ['remote', 'get-url', ...(op.push === true ? ['--push'] : []), 'origin'] };
		case 'defaultBranch': return { args: ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'] };
		case 'status': return { args: ['--no-optional-locks', 'status', '--porcelain'] };
		case 'currentBranch': return { args: ['rev-parse', '--abbrev-ref', 'HEAD'] };
		case 'refExists': return { args: ['rev-parse', '--verify', '--quiet', revArg(op.rev)] };
		case 'aheadCount': return { args: ['rev-list', '--count', `${revArg(op.base)}..${revArg(op.head)}`] };
		case 'boardDirTracked': return { args: ['ls-files', '--', PARADIS_TASK_BOARD_REMOTE_BOARD_DIR] };
		case 'fetch': return { args: ['fetch', '--quiet', ...(op.prune === true ? ['--prune'] : []), 'origin'] };
		case 'worktreeList': return { args: ['worktree', 'list', '--porcelain'] };
		case 'worktreeAdd': return { args: ['worktree', 'add', ...branchArgs(op, absoluteDir(op.dir))] };
		case 'worktreeRemove': return { args: ['worktree', 'remove', absoluteDir(op.dir)] };
		case 'switch': return { args: ['switch', ...branchArgs(op, undefined)] };
		case 'mergeFfOnly': return { args: ['merge', '--ff-only', `refs/remotes/origin/${checkBranch(op.branch)}`] };
		case 'detach': return { args: ['switch', '--detach', revArg(op.base)] };
		case 'addTracked': return { args: ['add', '-u'] };
		case 'commit': return { args: ['commit', '--quiet', '-m', commitMessage(op.message)], valueIndex: 3 };
		case 'push': {
			const branch = checkBranch(op.branch);
			const defaultBranch = op.defaultBranch === undefined || op.defaultBranch === null ? undefined : checkBranch(op.defaultBranch);
			if (paradisTaskBoardRemoteIsProtectedBranch(branch, defaultBranch)) {
				denied(`push to the default branch is not allowed: ${branch}`);
			}
			return { args: ['push', ...(op.setUpstream === true ? ['--set-upstream'] : []), 'origin', `HEAD:refs/heads/${branch}`] };
		}
		default:
			return invalid('unknown git operation');
	}
}

/**
 * 操作を git の argv にする。値の形が違えば `invalid`、既定のブランチへの push は `denied` を投げる。
 * 組み立てた後にも、禁止のオプションと `paradisRestrictedGitArgsError`（強制 push・削除・URL の remote）を重ねて掛ける
 * （組み立ての間違いを見つけるため）。
 */
export function paradisTaskBoardRemoteGitPlan(root: string, op: unknown): IParadisTaskBoardRemoteGitPlan {
	if (!op || typeof op !== 'object') {
		invalid('operation must be an object');
	}
	const record = op as { readonly kind?: unknown } & Record<string, unknown>;
	const { args, valueIndex } = operationArgs(record);
	args.forEach((arg, index) => {
		if (index !== valueIndex && (FORBIDDEN_ARGUMENT.test(arg) || arg.includes('\0') || arg.includes('://') || arg.includes('::'))) {
			denied(`git argument not allowed: ${arg}`);
		}
	});
	const restricted = paradisRestrictedGitArgsError(args);
	if (restricted !== undefined) {
		denied(restricted);
	}
	const kind = record.kind as string;
	const readOnly = READ_ONLY_KINDS.has(kind);
	return {
		args: ['-C', absoluteDir(root), '-c', 'core.quotepath=false', ...(readOnly ? ['-c', 'core.fsmonitor=false'] : []), ...args],
		readOnly,
		network: kind === 'fetch' || kind === 'push',
		hooks: kind === 'commit' || kind === 'push',
	};
}

/** 工程のコマンドの本文として受けるか（中身の承認は手元のウィンドウで行う。ここは形と長さだけ）。 */
export function paradisTaskBoardRemoteCommandError(command: unknown): string | undefined {
	if (typeof command !== 'string' || command.trim().length === 0) {
		return 'command must not be empty';
	}
	if (command.length > PARADIS_TASK_BOARD_REMOTE_LIMITS.maxCommandChars || command.includes('\0')) {
		return 'command is too long or contains NUL';
	}
	return undefined;
}

/**
 * 接続先で起こすプロセスの環境変数から外す名前。REH の `VSCODE_*`（pty ホストや agent host の接続トークン、
 * CLI のソケットなどが入りうる）と、Para Code の内部の値（ペインのトークン、daemon の鍵など）。
 * 2026-11-01 の実測では REH のサーバーのプロセス自身には `SSH_*` しか無く、`VSCODE_AGENT_HOST_CONNECTION_TOKEN` などは
 * 子のプロセスにだけ入っていた。親のシェルの環境（ログインシェルで解決したもの）から紛れ込む場合に備えて外す。
 */
const STRIPPED_ENV_PREFIXES = ['VSCODE_', 'ELECTRON_', 'PARA_CODE_', 'PARADIS_', 'GIT_CONFIG'];

/**
 * git の操作先や設定を差し替える変数（`GIT_CONFIG*` は上の接頭辞）と、node の起動に口を挟む `NODE_OPTIONS`。
 * `-C` で決めた作業場所の外のリポジトリを触らせない・`core.sshCommand` などを env から足させないため、git の操作と
 * 工程のコマンドの両方で外す。
 *
 * `GIT_SSH_COMMAND`・`GIT_SSH` は残す。ここに来る env は REH 自身の環境とログインシェルの環境だけで、ボードからは
 * 送れない（依頼に env の欄が無い）。値を置けるのは接続先の利用者だけで、外すと、鍵をホストごとに env で選んでいる
 * 人の push とテストの clone が通らなくなる（`core.sshCommand` を git の設定に書いている人は、どちらでも変わらない）。
 */
const STRIPPED_ENV_NAMES: ReadonlySet<string> = new Set([
	'GIT_DIR', 'GIT_WORK_TREE', 'GIT_EXEC_PATH', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
	'NODE_OPTIONS',
]);

/** ボードのプロセスと同じく、端末の問い合わせや認証のウィンドウで待たせないための固定の値。 */
const FIXED_ENV: Readonly<Record<string, string>> = {
	GIT_TERMINAL_PROMPT: '0',
	GCM_INTERACTIVE: 'never',
	GH_PROMPT_DISABLED: '1',
};

/**
 * 接続先で git・工程のコマンドに渡す環境変数を組み立てる。元は REH 自身の環境（とログインシェルの環境）で、
 * 手元から送られた値は使わない（依頼の形に env の欄は無い）。`SSH_AUTH_SOCK` は git の push に要るので残す
 * （利用者のターミナルと同じ）。
 */
export function paradisTaskBoardRemoteEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value === undefined) {
			continue;
		}
		const upper = name.toUpperCase();
		if (STRIPPED_ENV_NAMES.has(upper) || STRIPPED_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))) {
			continue;
		}
		result[name] = value;
	}
	Object.assign(result, FIXED_ENV);
	result.CI ??= '1';
	return result;
}
