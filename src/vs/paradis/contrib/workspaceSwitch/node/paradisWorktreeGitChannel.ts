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
import { existsSync, promises as fs } from 'fs';
import { CancellationError } from '../../../../base/common/errors.js';
import { dirname } from '../../../../base/common/path.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv, ParadisRawShellEnvResolver } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { localize } from '../../../../nls.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisAddWorktreeRequest, IParadisDiffStat, IParadisGitBranches, IParadisPrStatus, IParadisRemoveWorktreeRequest, IParadisRunLifecycleScriptRequest, paradisParseGhPrStatus, PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';
import { IParadisCloneProgressEvent, IParadisCloneRepositoryRequest, paradisCloneOverallPercent, paradisParseCloneProgressLine } from '../common/paradisRepositoryClone.js';
import { PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES } from '../common/paradisWorkspaceLifecycle.js';

/**
 * setup/teardown スクリプトの最長実行時間。スクリプトはユーザー任意のシェルコマンドのため、
 * 終了しないコマンド（対話待ち・フォアグラウンドの dev サーバー等の書き間違い）が混ざると
 * 呼び出し元の worktree 作成/削除フローが永久に完了しなくなる。上限で強制打ち切りする。
 */
const PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MS = PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES * 60_000;

/** setup/teardown スクリプトの stdout/stderr 上限。超過時は打ち切ってエラーにする。 */
const PARADIS_LIFECYCLE_SCRIPT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * git clone の無進捗タイムアウト。総時間ではなく「stderr の進捗出力が途絶えてから」の時間で
 * 打ち切る (巨大リポジトリの正常な長時間クローンは進捗が出続けるので誤爆しない)。
 * ネットワークストール等で close が永久に来ないケースの保険。
 */
const PARADIS_CLONE_IDLE_TIMEOUT_MS = 5 * 60_000;

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
			Date.now,
			reportParadisShellEnvDiagnosticError,
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

	/**
	 * gh (GitHub CLI) が見つからなかった (ENOENT) 場合に true。以降の PR 状態取得を
	 * プロセス生存中は打ち切る (未インストール環境でポーリングのたびに spawn を繰り返さない)。
	 */
	private ghUnavailable = false;

	private async execGh(args: string[], cwd: string): Promise<string> {
		const env = await this.cachedShellEnv.getEnv();
		return new Promise<string>((resolve, reject) => {
			// gh はネットワーク I/O のためタイムアウト必須。無いとプロキシ環境等でハングしたとき
			// 呼び出し側 (Workspaces ビュー) の in-flight ガードが永久に解除されなくなる
			this.execFile('gh', args, { cwd, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (err, stdout, stderr) => {
				if (err) {
					if ((err as { code?: unknown }).code === 'ENOENT') {
						this.ghUnavailable = true;
					}
					reject(new Error(stderr?.trim() || err.message));
				} else {
					resolve(stdout);
				}
			});
		});
	}

	/**
	 * 作業ツリーの現在ブランチに紐づく GitHub PR の状態を返す。
	 * gh CLI 未インストール・未認証・PR なし・detached HEAD などはすべて undefined を返す
	 * (Workspaces ビューのポーリング表示なので、失敗はチップ非表示として静かに縮退する)。
	 */
	async getPrStatus(worktreePath: string): Promise<IParadisPrStatus | undefined> {
		// IPC 境界の防御: 呼び出し元のバグ (undefined の文字列化等) を早期に無害化する
		if (typeof worktreePath !== 'string' || worktreePath.length === 0 || this.ghUnavailable) {
			return undefined;
		}
		let branch: string;
		try {
			branch = (await this.exec(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
		} catch {
			return undefined;
		}
		if (!branch || branch === 'HEAD') {
			// detached HEAD ではブランチ照合ができないため PR を紐づけない
			return undefined;
		}
		try {
			const stdout = await this.execGh(['pr', 'view', '--json', 'number,title,url,state,isDraft,headRefName'], worktreePath);
			return paradisParseGhPrStatus(stdout, branch);
		} catch (error) {
			// 「PR なし」は正常系。それ以外 (未認証・ネットワーク等) も表示上は同じ扱いだが、
			// 調査の手がかりに trace へは残す
			this.logService.trace(`[ParadisWorktreeGit] gh pr view failed for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
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
	 * 作業ツリーの未コミット差分 (staged + unstaged) の追加/削除行数を返す。
	 * git diff HEAD ベースのため、未追跡 (untracked) の新規ファイルは集計に含まれない (意図的な仕様)。
	 * git 管理外・HEAD 未作成・コマンド失敗時は { insertions: 0, deletions: 0 } を返す
	 * (Workspaces ビューのポーリング表示なので、個別の失敗で例外を伝播させない)。
	 */
	async getDiffStat(worktreePath: string): Promise<IParadisDiffStat> {
		// IPC 境界の防御: 呼び出し元のバグ (undefined の文字列化等) を早期に無害化する
		if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
			return { insertions: 0, deletions: 0 };
		}
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

	// --- git clone -----------------------------------------------------------------------------

	private readonly _onCloneProgress = new Emitter<IParadisCloneProgressEvent>();
	/** git clone の進捗 (プロセス寿命のサービスのため Emitter は dispose しない)。 */
	readonly onCloneProgress = this._onCloneProgress.event;

	/** 実行中の clone。cloneId → プロセスとキャンセル済みフラグ。 */
	private readonly runningClones = new Map<string, { child: cp.ChildProcess; canceled: boolean }>();

	/**
	 * git clone --progress を実行する。stderr のステージ進捗を onCloneProgress で配信し、
	 * 完了/失敗はこの呼び出しの resolve/reject で伝える。キャンセル時は CancellationError
	 * (name: 'Canceled') で reject する。失敗・キャンセル時は作りかけのディレクトリを削除する
	 * (開始前に未存在を確認しているので、消してよいのはこの clone が作ったものに限られる)。
	 */
	async cloneRepository(request: IParadisCloneRepositoryRequest): Promise<void> {
		const { url, targetPath, cloneId } = request ?? {};
		// IPC 境界の防御: 位置引数が git のオプションとして解釈されないことを保証する
		// (url は '--' の後ろに置くが、多層防御として '-' 始まりも拒否する)
		for (const value of [url, targetPath, cloneId]) {
			if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
				throw new Error(`Invalid argument: ${String(value)}`);
			}
		}
		if (this.runningClones.has(cloneId)) {
			throw new Error(`Clone already running: ${cloneId}`);
		}
		if (existsSync(targetPath)) {
			// allow-any-unicode-next-line
			throw new Error(localize('paradis.repositoryClone.targetExists', "フォルダが既に存在します: {0}", targetPath));
		}
		await fs.mkdir(dirname(targetPath), { recursive: true });
		const env = await this.cachedShellEnv.getEnv();

		try {
			await new Promise<void>((resolve, reject) => {
				const child = cp.spawn('git', ['clone', '--progress', '--', url, targetPath], {
					env: { ...env, GIT_TERMINAL_PROMPT: '0' },
					stdio: ['ignore', 'ignore', 'pipe'],
				});
				const entry = { child, canceled: false };
				this.runningClones.set(cloneId, entry);

				let idleTimedOut = false;
				let idleTimer: Timeout | undefined;
				const resetIdleTimer = () => {
					clearTimeout(idleTimer);
					idleTimer = setTimeout(() => {
						idleTimedOut = true;
						child.kill('SIGKILL');
					}, PARADIS_CLONE_IDLE_TIMEOUT_MS);
				};
				resetIdleTimer();

				let overallPercent = 0;
				let pendingChunk = '';
				let errorLines: string[] = [];
				const consumeLine = (line: string) => {
					const trimmed = line.trim();
					if (!trimmed) {
						return;
					}
					const progress = paradisParseCloneProgressLine(trimmed);
					if (progress) {
						overallPercent = Math.max(overallPercent, paradisCloneOverallPercent(progress.stage, progress.percent) ?? overallPercent);
					} else {
						// 進捗以外の行 ("Cloning into ...", fatal: 等)。失敗時のエラーメッセージ用に末尾を保持
						errorLines = [...errorLines, trimmed].slice(-8);
					}
					this._onCloneProgress.fire({ cloneId, message: trimmed.slice(0, 200), overallPercent });
				};
				child.stderr!.setEncoding('utf8');
				child.stderr!.on('data', (chunk: string) => {
					resetIdleTimer();
					pendingChunk += chunk;
					// git の進捗は \r で同一行を上書きしてくるため \r も行区切りとして扱う
					const lines = pendingChunk.split(/[\r\n]/);
					pendingChunk = lines.pop() ?? '';
					for (const line of lines) {
						consumeLine(line);
					}
				});

				let settled = false;
				const settle = (error?: Error) => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(idleTimer);
					this.runningClones.delete(cloneId);
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				};
				child.on('error', error => {
					const enoent = (error as { code?: unknown }).code === 'ENOENT';
					// allow-any-unicode-next-line
					settle(enoent ? new Error(localize('paradis.repositoryClone.gitNotFound', "git コマンドが見つかりません。Git をインストールしてから再試行してください。")) : error);
				});
				child.on('close', code => {
					consumeLine(pendingChunk);
					if (entry.canceled) {
						settle(new CancellationError());
					} else if (idleTimedOut) {
						// allow-any-unicode-next-line
						settle(new Error(localize('paradis.repositoryClone.stalled', "git clone が {0} 分間進捗しなかったため中断しました。", PARADIS_CLONE_IDLE_TIMEOUT_MS / 60_000)));
					} else if (code === 0) {
						settle();
					} else {
						this.logService.warn(`[ParadisWorktreeGit] git clone ${url} failed (exit ${code}): ${errorLines.join(' / ')}`);
						// allow-any-unicode-next-line
						settle(new Error(errorLines.join('\n') || localize('paradis.repositoryClone.failed', "git clone が失敗しました (exit {0})。", String(code))));
					}
				});
			});
		} catch (error) {
			// 開始前に targetPath の未存在を確認済みなので、残骸はこの clone が作ったもの。
			// git は kill 時にディレクトリを掃除しないことがあるため明示的に消す (ベストエフォート)
			try {
				await fs.rm(targetPath, { recursive: true, force: true });
			} catch {
				// 削除失敗は元のエラーを優先する
			}
			throw error;
		}
	}

	/** 実行中の clone を中断する。該当があれば true。 */
	cancelClone(cloneId: string): boolean {
		const entry = this.runningClones.get(cloneId);
		if (!entry) {
			return false;
		}
		entry.canceled = true;
		entry.child.kill('SIGTERM');
		// SIGTERM で終了しない場合の保険。close 済みなら kill は no-op
		// (shared process は常駐のため、この短命タイマーが寿命へ影響することはない)
		setTimeout(() => entry.child.kill('SIGKILL'), 5000);
		return true;
	}
}

export class ParadisWorktreeGitChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisWorktreeGitService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		if (event === 'onCloneProgress') {
			return this.service.onCloneProgress as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'cloneRepository': return this.service.cloneRepository(args[0] as IParadisCloneRepositoryRequest) as Promise<T>;
			case 'cancelClone': return Promise.resolve(this.service.cancelClone(String(args[0]))) as Promise<T>;
			case 'listBranches': return this.service.listBranches(String(args[0])) as Promise<T>;
			case 'addWorktree': return this.service.addWorktree(args[0] as IParadisAddWorktreeRequest) as Promise<T>;
			case 'getDiffStat': return this.service.getDiffStat(String(args[0])) as Promise<T>;
			case 'getPrStatus': return this.service.getPrStatus(String(args[0])) as Promise<T>;
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
