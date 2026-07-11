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
import { IParadisAddWorktreeRequest, IParadisDiffStat, IParadisGitBranches, IParadisRemoveWorktreeRequest, IParadisRunLifecycleScriptRequest, PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';

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

	/**
	 * 作業ツリーの未コミット差分 (staged + unstaged、HEAD 比較) の統計を返す。
	 * git 管理外・HEAD 未作成・コマンド失敗時は { insertions: 0, deletions: 0 } を返す
	 * (Workspaces ビューのポーリング表示なので、個別の失敗で例外を伝播させない)。
	 */
	async getDiffStat(worktreePath: string): Promise<IParadisDiffStat> {
		try {
			const raw = await this.exec(['-C', worktreePath, 'diff', 'HEAD', '--numstat']);
			let insertions = 0;
			let deletions = 0;
			for (const line of raw.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				// フォーマット: "<added>\t<deleted>\t<path>" (バイナリファイルは '-' '-')
				const [added, deleted] = trimmed.split('\t');
				insertions += Number.parseInt(added, 10) || 0;
				deletions += Number.parseInt(deleted, 10) || 0;
			}
			return { insertions, deletions };
		} catch {
			return { insertions: 0, deletions: 0 };
		}
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
		const shell = env.SHELL || (isWindows ? env.ComSpec : undefined) || (isWindows ? 'cmd.exe' : '/bin/sh');
		const args = isWindows ? ['/d', '/s', '/c', request.script] : ['-lc', request.script];
		await new Promise<void>((resolve, reject) => {
			this.execFile(shell, args, {
				cwd: request.worktreePath,
				encoding: 'utf8',
				env: { ...env, PARACODE_PROJECT_ROOT_PATH: request.repoPath }
			}, (error, _stdout, stderr) => {
				if (!error) { resolve(); return; }
				const label = request.kind === 'setup' ? 'Setup' : 'Teardown';
				reject(new Error(`${label} script failed${typeof (error as { code?: number }).code === 'number' ? ` (exit ${(error as { code?: number }).code})` : ''}: ${stderr?.trim() || error.message}`));
			});
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
			case 'getDiffStat': return this.service.getDiffStat(String(args[0])) as Promise<T>;
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
