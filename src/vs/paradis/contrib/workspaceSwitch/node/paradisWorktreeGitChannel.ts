/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 上で git worktree 操作（worktree add / ブランチ列挙）を実行するサービスと
// IPC チャネル。workbench からは ISharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL)
// 経由で呼ぶ。実装方式は platform/git/node/localGitService.ts（upstream の低レベル git 実行）と
// 同じ execFile('git', ...) 直叩き。upstream サービスの改変を避けるため fork 側に独立させている。

import * as cp from 'child_process';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv, ParadisRawShellEnvResolver } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { localize } from '../../../../nls.js';
import { IParadisAddWorktreeRequest, IParadisGitBranches, IParadisRemoveWorktreeRequest, IParadisRunLifecycleScriptRequest, PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';
import { PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES } from '../common/paradisWorkspaceLifecycle.js';

/**
 * setup/teardown スクリプトの最長実行時間。スクリプトはユーザー任意のシェルコマンドのため、
 * 終了しないコマンド（対話待ち・フォアグラウンドの dev サーバー等の書き間違い）が混ざると
 * 呼び出し元の worktree 作成/削除フローが永久に完了しなくなる。上限で強制打ち切りする。
 */
const PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MS = PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES * 60_000;

/** setup/teardown スクリプトの stdout/stderr 上限。超過時は打ち切ってエラーにする。 */
const PARADIS_LIFECYCLE_SCRIPT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export class ParadisWorktreeGitService {

	private readonly cachedShellEnv: ParadisCachedShellEnv;

	constructor(
		private readonly logService: ILogService,
		configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
		private readonly execFile: typeof cp.execFile = cp.execFile,
		shellEnvResolver?: ParadisRawShellEnvResolver,
	) {
		this.cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisWorktreeGit',
			shellEnvResolver ?? createParadisShellEnvResolver(logService, configurationService, args),
		);
	}

	private async exec(args: string[], cwd?: string): Promise<string> {
		const env = await this.cachedShellEnv.getEnv();
		return new Promise<string>((resolve, reject) => {
			this.execFile('git', args, { cwd, encoding: 'utf8', env: { ...env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
				if (err) {
					this.logService.warn(`[ParadisWorktreeGit] git ${args.join(' ')} failed: ${stderr || err.message}`);
					reject(new Error(stderr?.trim() || err.message));
				} else {
					resolve(stdout);
				}
			});
		});
	}

	/** ローカルブランチ一覧（コミット日時の新しい順）と現在の HEAD ブランチを返す。 */
	async listBranches(repoPath: string): Promise<IParadisGitBranches> {
		const raw = await this.exec(['-C', repoPath, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/']);
		const branches = raw.split('\n').map(line => line.trim()).filter(line => line.length > 0);
		let head: string | undefined;
		try {
			const headRaw = (await this.exec(['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
			head = headRaw && headRaw !== 'HEAD' ? headRaw : undefined;
		} catch {
			head = undefined;
		}
		return { branches, head };
	}

	/** git worktree add --no-track -b <newBranch> <worktreePath> <baseRef> を実行する。 */
	async addWorktree(request: IParadisAddWorktreeRequest): Promise<void> {
		// IPC 境界の防御: 呼び出し側でサニタイズ済みだが、位置引数が git のオプションとして
		// 解釈されないことをここでも保証する（execFile なのでシェル注入は元々不可）
		for (const value of [request.newBranch, request.worktreePath, request.baseRef]) {
			if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
				throw new Error(`Invalid argument: ${String(value)}`);
			}
		}
		// stale なメタデータで add が失敗しないよう、先に prune しておく（Superset と同じ流儀）
		try {
			await this.exec(['-C', request.repoPath, 'worktree', 'prune']);
		} catch {
			// prune の失敗は致命的ではない
		}
		await this.exec(['-C', request.repoPath, 'worktree', 'add', '--no-track', '-b', request.newBranch, request.worktreePath, request.baseRef]);
	}

	/**
	 * git worktree remove [--force] <worktreePath> を実行する。
	 * 未コミット変更や未追跡ファイルがある場合、force なしだと git が失敗する（呼び出し側で
	 * force 付き再試行を確認する）。stale なメタデータで失敗しないよう先に prune する。
	 */
	async removeWorktree(request: IParadisRemoveWorktreeRequest): Promise<void> {
		// IPC 境界の防御: 位置引数が git のオプションとして解釈されないことを保証する
		if (typeof request.worktreePath !== 'string' || request.worktreePath.length === 0 || request.worktreePath.startsWith('-')) {
			throw new Error(`Invalid argument: ${String(request.worktreePath)}`);
		}
		try {
			await this.exec(['-C', request.repoPath, 'worktree', 'prune']);
		} catch {
			// prune の失敗は致命的ではない
		}
		const args = ['-C', request.repoPath, 'worktree', 'remove'];
		if (request.force) {
			args.push('--force');
		}
		args.push(request.worktreePath);
		await this.exec(args);
	}

	/**
	 * リポジトリ定義の setup/teardown スクリプトを、対象 worktree を cwd として解決済みシェルで実行する。
	 * 環境変数 PARACODE_PROJECT_ROOT_PATH に親リポジトリの絶対パスを渡す。
	 */
	async runLifecycleScript(request: IParadisRunLifecycleScriptRequest): Promise<void> {
		if (!request.script.trim() || !request.repoPath || !request.worktreePath) {
			throw new Error('Invalid lifecycle script request.');
		}
		const env = await this.cachedShellEnv.getEnv();
		// Windows では SHELL が設定されていても（Git Bash 等）引数形式が /c 系と食い違うため、
		// プラットフォームごとにシェルと引数形式を対で選ぶ
		const shell = isWindows ? (env.ComSpec || 'cmd.exe') : (env.SHELL || '/bin/sh');
		const args = isWindows ? ['/d', '/s', '/c', request.script] : ['-lc', request.script];
		// `detached` は execFile の型定義には無いが、ランタイムでは spawn へそのまま透過される。
		// POSIX ではスクリプトを独立したプロセスグループにし、タイムアウト時に
		// バックグラウンド化した孫プロセス（`some-daemon &` 等）ごと殺せるようにする
		const options: cp.ExecFileOptionsWithStringEncoding & { detached: boolean } = {
			cwd: request.worktreePath,
			encoding: 'utf8',
			timeout: PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MS,
			killSignal: 'SIGKILL',
			// bun install 等は 1MiB (Node 既定) を超える出力を吐き得る。上限は明示しつつ余裕を持たせる
			maxBuffer: PARADIS_LIFECYCLE_SCRIPT_MAX_BUFFER_BYTES,
			detached: !isWindows,
			env: { ...env, PARACODE_PROJECT_ROOT_PATH: request.repoPath }
		};
		await new Promise<void>((resolve, reject) => {
			// callback から child 自体を参照すると、テスト用モックの同期 callback 呼び出しで
			// 代入前参照 (TDZ) になるため、pid はホルダー経由で受け渡す
			const childRef: { pid?: number } = {};
			const child = this.execFile(shell, args, options, (error, _stdout, stderr) => {
				if (!error) { resolve(); return; }
				const label = request.kind === 'setup' ? 'setup' : 'teardown';
				// maxBuffer 超過でも killed=true になるため、タイムアウトと区別する (code が
				// 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' の文字列になる。タイムアウト時は null)
				if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
					// allow-any-unicode-next-line
					reject(new Error(localize('paradis.workspaceLifecycle.scriptOutputExceeded', "{0} スクリプトの出力が上限 ({1} MB) を超えたため中断しました。", request.kind, PARADIS_LIFECYCLE_SCRIPT_MAX_BUFFER_BYTES / (1024 * 1024))));
					return;
				}
				if ((error as { killed?: boolean }).killed) {
					if (!isWindows && typeof childRef.pid === 'number') {
						// execFile の timeout はシェル本体しか kill しないため、残った孫プロセスを
						// プロセスグループごと始末する（既に全滅していれば ESRCH で無視される）
						try { process.kill(-childRef.pid, 'SIGKILL'); } catch { /* グループが既に存在しない */ }
					}
					// allow-any-unicode-next-line
					reject(new Error(localize('paradis.workspaceLifecycle.scriptTimedOut', "{0} スクリプトが {1} 分以内に終了しなかったため、強制終了しました。", label, PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES)));
					return;
				}
				const exitCode = (error as { code?: number }).code;
				const detail = stderr?.trim() || error.message;
				reject(new Error(typeof exitCode === 'number'
					// allow-any-unicode-next-line
					? localize('paradis.workspaceLifecycle.scriptFailedWithExit', "{0} スクリプトが失敗しました (exit {1}): {2}", label, exitCode, detail)
					// allow-any-unicode-next-line
					: localize('paradis.workspaceLifecycle.scriptFailed', "{0} スクリプトが失敗しました: {1}", label, detail)));
			});
			childRef.pid = child?.pid;
		});
	}
}

export class ParadisWorktreeGitChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisWorktreeGitService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'listBranches': return this.service.listBranches(String(args[0])) as Promise<T>;
			case 'addWorktree': return this.service.addWorktree(args[0] as IParadisAddWorktreeRequest) as Promise<T>;
			case 'removeWorktree': return this.service.removeWorktree(args[0] as IParadisRemoveWorktreeRequest) as Promise<T>;
			case 'runLifecycleScript': return this.service.runLifecycleScript(args[0] as IParadisRunLifecycleScriptRequest) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisWorktreeGit(server: IPCServer<string>, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	const service = new ParadisWorktreeGitService(logService, configurationService, args);
	server.registerChannel(PARADIS_WORKTREE_GIT_CHANNEL, new ParadisWorktreeGitChannel(service));
	return { dispose: () => { } };
}
