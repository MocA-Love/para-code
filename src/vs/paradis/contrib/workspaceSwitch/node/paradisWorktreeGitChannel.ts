/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// git worktree 操作（worktree add / ブランチ列挙）を実行するサービスと IPC チャネル。
// shared process と REH（接続先）の両方に同じチャネルを生やしてあり、workbench からは
// electron-browser/paradisWorktreeGitChannelClient.ts 経由で「そのリポジトリがあるマシン」へ
// 繋ぐ。実装方式は platform/git/node/localGitService.ts（upstream の低レベル git 実行）と
// 同じ execFile('git', ...) 直叩き。upstream サービスの改変を避けるため fork 側に独立させている。

import * as cp from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { homedir } from 'os';
import { CancellationError } from '../../../../base/common/errors.js';
import { basename, dirname, join } from '../../../../base/common/path.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { isLinux, isWindows } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv, ParadisRawShellEnvResolver } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { localize } from '../../../../nls.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisGithubCallSiteFromArgs, paradisIsGithubNoPullRequestMessage, paradisIsGithubRateLimitMessage, paradisRecordGithubCall, paradisRedactHomePath } from '../../githubMetrics/common/paradisGithubMetrics.js';
import { IParadisAddWorktreeRequest, IParadisDiffStat, IParadisGitBranches, IParadisPrStatus, IParadisRemoveWorktreeRequest, IParadisRunLifecycleScriptRequest, IParadisWorktreeGitCommandResult, IParadisWorktreeLockInfo, IParadisWorktreeLockQuery, paradisFindWorktreeLock, paradisParseGhPrStatus, paradisParseWorktreeListPorcelain, PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';
import { IParadisIssueStatus, IParadisIssueStatusesResult, paradisParseGhIssueStatus, paradisParseIssueUrl } from '../../../common/paradisIssueDetection.js';
import { IParadisCloneProgressEvent, IParadisCloneRepositoryRequest, paradisCloneOverallPercent, paradisParseCloneProgressLine } from '../common/paradisRepositoryClone.js';
import { paradisResolveLifecycleTimeoutMinutes } from '../common/paradisWorkspaceLifecycle.js';
import { PARADIS_PROJECT_ROOT_ENV_VAR } from '../../terminalPresets/common/paradisTerminalPresets.js';
import { getWslExePath } from '../../../../platform/agentHost/node/wslRemoteAgentHostHelpers.js';
import { ParadisCommandArgument, paradisBuildWslInvocationArgs, paradisMergeWslEnvNames, paradisParseWslLoginPath, paradisParseWslUncPath, paradisPlanWslCommand, paradisWslLoginPathProbeArgs, paradisWslPathArg } from '../../../common/paradisWslPath.js';

/**
 * setup/teardown スクリプトの最長実行時間。スクリプトはユーザー任意のシェルコマンドのため、
 * 終了しないコマンド（対話待ち・フォアグラウンドの dev サーバー等の書き間違い）が混ざると
 * 呼び出し元の worktree 作成/削除フローが永久に完了しなくなる。上限で強制打ち切りする。
 *
 * 既定値と範囲は paradisResolveLifecycleTimeoutMinutes が持つ。リポジトリの .paracode.json が
 * setupTimeoutMinutes / teardownTimeoutMinutes を指定していればそちらを使う（イメージや
 * ボリュームまで落とす `docker compose down --rmi all --volumes` のように、既定では
 * 足りない後片付けがあるため）。
 */
function paradisLifecycleScriptTimeoutMs(request: IParadisRunLifecycleScriptRequest<string>): number {
	return paradisResolveLifecycleTimeoutMinutes(request.timeoutMinutes) * 60_000;
}

/** setup/teardown スクリプトの stdout/stderr 上限。超過時は打ち切ってエラーにする。 */
const PARADIS_LIFECYCLE_SCRIPT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * git clone の無進捗タイムアウト。総時間ではなく「stderr の進捗出力が途絶えてから」の時間で
 * 打ち切る (巨大リポジトリの正常な長時間クローンは進捗が出続けるので誤爆しない)。
 * ネットワークストール等で close が永久に来ないケースの保険。
 */
const PARADIS_CLONE_IDLE_TIMEOUT_MS = 5 * 60_000;

/** SIGTERM で終わらなかった clone を強制終了するまでの待ち時間。 */
const PARADIS_CLONE_KILL_GRACE_MS = 5_000;

/**
 * clone を始めた相手を見分ける印。
 *
 * IPC のチャネルは呼び出しごとに接続の `ctx` を渡してくる。`ctx` は接続の間ずっと同じ値
 * （同じオブジェクト）なので、そのまま「誰が始めたか」の印として使える。REH では
 * `RemoteAgentConnectionContext`、shared process ではクライアント ID の文字列。
 */
export type ParadisCloneOwner = object | string;

/** 走行中の clone 1本ぶん。 */
interface IParadisRunningClone {
	readonly child: cp.ChildProcess;
	/** この clone を始めた接続。接続が消えたときに、その接続のぶんだけを畳むのに使う。 */
	readonly owner: ParadisCloneOwner | undefined;
	canceled: boolean;
	/** SIGTERM で終わらなかったときの保険。先に終わったら引き取る。 */
	killTimer: Timeout | undefined;
}

/**
 * gh が見つからないと判断してから、次に試すまでの待ち時間。恒久的に諦めないのは、
 * ユーザーが gh を入れた直後にアプリ全体の再起動を強いないため（shared process は
 * アプリ寿命なので、ウィンドウの再読み込みでは状態が消えない）。
 */
const PARADIS_GH_UNAVAILABLE_RETRY_MS = 10 * 60_000;

/**
 * 1回の getIssueStatuses 呼び出しで解決する Issue の上限。gh issue view は番号ごとに1本
 * 実行するため、対話から大量のURLが検出された回でもレート枠を食い潰さないよう先着で丸める。
 */
const PARADIS_ISSUE_STATUS_LOOKUPS_PER_CALL = 8;

/**
 * git 実行の上限時間。WSL へ振り分けるようになって初めて必要になった。停止中のディストロへ
 * 最初の1本を打つと VM の起動を待つことになり、`/etc/wsl.conf` の boot.command 次第では
 * そのまま返ってこない。呼び出し側（Workspaces ビュー）は単一の in-flight ガードで守られて
 * いるため、1本詰まると diff も PR もアプリを再起動するまで止まる。
 */
const PARADIS_WSL_COMMAND_TIMEOUT_MS = 30_000;

/**
 * シェルが「そんなコマンドは無い」で終わるときの終了コード。WSL へ振り分けた実行では
 * 実行ファイル不在が spawn の ENOENT ではなくこの終了コードとして現れる（起動しているのは
 * 必ず存在する wsl.exe のため）。
 */
const PARADIS_SHELL_COMMAND_NOT_FOUND_EXIT_CODE = 127;

/**
 * 子プロセスの失敗を読める1行にする。
 *
 * wsl.exe 自身が出すメッセージ（ディストロが無い等）は UTF-16LE のことがあり、utf8 として
 * 読むとヌル混じりになる。ここで落とさないと、そのままエラーダイアログへ出てしまう。
 * `WSL_UTF8=1` で解決しないのは、それが子プロセスの出力まで再エンコードしてしまい、
 * gh が返す JSON を壊し得るため（同じ判断が wslRemoteAgentHostService.ts にもある）。
 */
function paradisReadableChildError(stderr: string | undefined, error: Error, viaWsl: boolean): string {
	const cleaned = viaWsl ? stderr?.replace(/\0/g, '') : stderr;
	return cleaned?.trim() || error.message;
}

export class ParadisWorktreeGitService {

	private readonly cachedShellEnv: ParadisCachedShellEnv;

	constructor(
		private readonly logService: ILogService,
		configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
		private readonly execFile: typeof cp.execFile = cp.execFile,
		shellEnvResolver?: ParadisRawShellEnvResolver,
		/** WSL への振り分けを行うか。既定はホスト OS 判定で、テストからのみ差し替える。 */
		private readonly isWindowsHost: boolean = isWindows,
		/** git clone の起動口。テストからのみ差し替える。 */
		private readonly spawn: typeof cp.spawn = cp.spawn,
	) {
		this.cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisWorktreeGit',
			shellEnvResolver ?? createParadisShellEnvResolver(logService, configurationService, args),
			Date.now,
			reportParadisShellEnvDiagnosticError,
		);
	}

	/** ディストロごとの、ログインシェルが組み立てた PATH（1プロセスにつき1回だけ取得する）。 */
	private readonly wslLoginPaths = new Map<string, Promise<string | undefined>>();

	/**
	 * ログインシェルの PATH を取り出す。`~/.local/bin`・mise・Linuxbrew などプロファイルで
	 * PATH に足す場所へ git / gh を入れている構成では、これが無いと「ターミナルでは動くのに
	 * 見つからない」になる。取得できなくても致命的ではない（既定の PATH で続行する）。
	 */
	private probeWslLoginPath(distro: string): Promise<string | undefined> {
		const cached = this.wslLoginPaths.get(distro);
		if (cached !== undefined) {
			return cached;
		}
		const probe = new Promise<string | undefined>(resolve => {
			this.execFile(getWslExePath(), paradisWslLoginPathProbeArgs(distro), { encoding: 'utf8', timeout: PARADIS_WSL_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout) => {
				const value = err ? undefined : paradisParseWslLoginPath(stdout);
				if (value === undefined) {
					this.logService.trace(`[ParadisWorktreeGit] could not read the login PATH of WSL distro ${distro}; falling back to the default one`);
				}
				resolve(value);
			});
		});
		this.wslLoginPaths.set(distro, probe);
		return probe;
	}

	/**
	 * 対象パスが WSL 名前空間（`\\wsl.localhost\<distro>\...`）なら、実行をディストロの中へ移す。
	 * リポジトリの実体が WSL 側にある場合、Windows 側に git / gh が入っている保証は無く、仮に
	 * 入っていても 9p 越しの実行になり所有者チェック（safe.directory）にも掛かりやすい。
	 *
	 * `envNamesForWsl` に挙げた変数だけが `WSLENV` 経由でディストロの中へ渡る。
	 */
	private async resolveInvocation(command: string, args: readonly ParadisCommandArgument[], cwd: string | undefined, envNamesForWsl: readonly string[], env: NodeJS.ProcessEnv):
		Promise<{ readonly file: string; readonly args: string[]; readonly cwd: string | undefined; readonly env: NodeJS.ProcessEnv; readonly viaWsl: boolean }> {
		const plan = paradisPlanWslCommand(args, cwd);
		if (plan.kind === 'conflict') {
			throw new Error(`Cannot run ${command} across the Windows and WSL namespaces: ${plan.detail}`);
		}
		if (plan.kind === 'local' || !this.isWindowsHost) {
			return { file: command, args: plan.kind === 'local' ? [...plan.args] : args.map(arg => typeof arg === 'string' ? arg : arg.paradisPath), cwd, env, viaWsl: false };
		}
		return {
			file: getWslExePath(),
			args: paradisBuildWslInvocationArgs(plan, command, await this.probeWslLoginPath(plan.distro)),
			// ディストロの中での作業ディレクトリは挟んだ `sh -c` の cd で入る。wsl.exe 自身の
			// cwd は触らない（UNC を cwd にすると Windows 側で扱えないプロセスがある）。
			cwd: undefined,
			env: { ...env, WSLENV: paradisMergeWslEnvNames(env['WSLENV'], envNamesForWsl) },
			viaWsl: true,
		};
	}

	/** 実行名前空間の識別子。ローカルは空文字、WSL はディストロごとに分ける。 */
	private executionNamespaceKey(path: string): string {
		const location = this.isWindowsHost ? paradisParseWslUncPath(path) : undefined;
		return location === undefined ? '' : `wsl:${location.distro.toLowerCase()}`;
	}

	private async exec(args: ParadisCommandArgument[], cwd?: string): Promise<string> {
		const env = await this.cachedShellEnv.getEnv();
		const invocation = await this.resolveInvocation('git', args, cwd, ['GIT_TERMINAL_PROMPT'], { ...env, GIT_TERMINAL_PROMPT: '0' });
		const label = invocation.viaWsl ? `git (in WSL) ${invocation.args.join(' ')}` : `git ${invocation.args.join(' ')}`;
		return new Promise<string>((resolve, reject) => {
			// タイムアウトは WSL 対応で必須になった。停止中のディストロへ最初の1本を打つと VM の
			// 起動を待たされ、`/etc/wsl.conf` の boot.command 次第では返ってこない。呼び出し側は
			// 単一の in-flight ガードで守られているので、1本詰まると以降のポーリングが全部止まる。
			this.execFile(invocation.file, invocation.args, { cwd: invocation.cwd, encoding: 'utf8', timeout: PARADIS_WSL_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, env: invocation.env }, (err, stdout, stderr) => {
				if (err) {
					const detail = paradisReadableChildError(stderr, err, invocation.viaWsl);
					this.logService.warn(`[ParadisWorktreeGit] ${label} failed: ${detail}`);
					reject(new Error(detail));
				} else {
					resolve(stdout);
				}
			});
		});
	}

	private static readonly RUN_GIT_ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'add', 'commit', 'log', 'rev-parse', 'branch', 'restore', 'remote', 'show']);
	// 外部コマンド実行やリポジトリ差し替えに繋がるオプションを拒否する。`-C`/`-c` は自前で
	// 先頭に足すので、呼び出し元が渡す args の側からは常に禁止する。`--output` は diff/log/show が
	// 受け付け、値に任意パスを渡せば任意ファイル書き込みに使える。
	// 既知の誤検出: このチェックは args 全体（オプションの「値」を含む）に掛かるため、例えば
	// `git commit -m` のメッセージがたまたま `--output=...` で始まると拒否される（git 自体は
	// `-m` の直後を常に値として扱うので危険はないが、区別せず一律拒否している）。安全側に倒した
	// 割り切りで、実害は「稀に操作が失敗してエラーが返る」程度（任意コマンド実行にはならない）。
	private static readonly RUN_GIT_FORBIDDEN_ARGUMENT = /^--(upload-pack|receive-pack|exec|git-dir|work-tree|config-env|output)\b|^-c$|^-C$/;

	/**
	 * モバイル中継・ソース管理タブ用の、許可リストで制限した任意 git サブコマンド実行。
	 * `exec` と異なり例外を投げず、常に exit code を含めて返す（呼び出し側が判定するため）。
	 *
	 * ここでのチェックはサブコマンドと危険なオプションの許可/禁止だけで、`args` の値
	 * （コミットハッシュ・ブランチ名等）の形式検証はしない。`git show <hash>` に不正な rev
	 * を渡してもコマンドとしては安全（任意コマンド実行にはならない）だが、呼び出し元が
	 * 意味のある値かどうかは呼び出し元の責任で確認すること（このチャネルの利用者が増えるたびに
	 * 個々の呼び出し元で検証すること — 例: 40桁以内の16進に絞る等）。
	 */
	async runGit(repoPath: string, args: readonly string[]): Promise<IParadisWorktreeGitCommandResult> {
		if (args.length === 0 || !ParadisWorktreeGitService.RUN_GIT_ALLOWED_SUBCOMMANDS.has(args[0])) {
			throw new Error(`ParadisWorktreeGit: git subcommand not allowed: ${args[0] ?? '(none)'}`);
		}
		for (const arg of args) {
			if (ParadisWorktreeGitService.RUN_GIT_FORBIDDEN_ARGUMENT.test(arg)) {
				throw new Error(`ParadisWorktreeGit: git argument not allowed: ${arg}`);
			}
		}
		const env = await this.cachedShellEnv.getEnv();
		// core.quotepath=false: 既定では非ASCIIパスが八進エスケープ+引用符("\345...")で出力され、
		// モバイルのソース管理タブで文字化け表示になるため無効化する。
		const gitArgs: ParadisCommandArgument[] = ['-C', paradisWslPathArg(repoPath), '-c', 'core.quotepath=false', ...args];
		const invocation = await this.resolveInvocation('git', gitArgs, undefined, ['GIT_TERMINAL_PROMPT'], { ...env, GIT_TERMINAL_PROMPT: '0' });
		return new Promise<IParadisWorktreeGitCommandResult>(resolve => {
			this.execFile(invocation.file, invocation.args, { cwd: invocation.cwd, encoding: 'utf8', timeout: PARADIS_WSL_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, env: invocation.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
				const rawCode: unknown = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code ?? 1 : 0;
				resolve({ code: typeof rawCode === 'number' ? rawCode : 1, stdout: String(stdout), stderr: String(stderr) });
			});
		});
	}

	/**
	 * gh (GitHub CLI) が見つからなかった実行名前空間と、そう判断した時刻。以降の PR 状態取得を
	 * しばらく打ち切る (未インストール環境でポーリングのたびに spawn を繰り返さない)。
	 *
	 * 名前空間ごとに分けるのは、片方の失敗でもう片方まで止めないため。WSL のディストロが
	 * 停止していれば当然そのディストロ側は失敗するが、Windows 側のリポジトリには関係がない。
	 */
	private readonly ghUnavailableSince = new Map<string, number>();

	/** その名前空間の gh を今は呼ばない、と決めている最中か（待ち時間を過ぎていれば解除する）。 */
	private isGhUnavailable(path: string): boolean {
		const key = this.executionNamespaceKey(path);
		const since = this.ghUnavailableSince.get(key);
		if (since === undefined) {
			return false;
		}
		if (Date.now() - since < PARADIS_GH_UNAVAILABLE_RETRY_MS) {
			return true;
		}
		this.ghUnavailableSince.delete(key);
		return false;
	}

	private async execGh(args: string[], cwd: string): Promise<string> {
		const env = await this.cachedShellEnv.getEnv();
		// GitHub API 利用状況ビュー用の計測。gh CLI 経由の呼び出しはすべてここを通るので、
		// 「どの処理がどれだけ gh を呼んでいるか」はこの1箇所で数えられる
		// (src/vs/paradis/contrib/githubMetrics/ 参照。拡張機能や他ツールの消費はレート枠側に現れる)
		const startedAt = Date.now();
		const callSite = paradisGithubCallSiteFromArgs(args);
		// 記録はダッシュボードに出るうえデバッグバンドルとして共有されるためユーザー名を残さない
		const worktreePath = paradisRedactHomePath(cwd, homedir());
		const invocation = await this.resolveInvocation('gh', args, cwd, ['GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER'], { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' });
		return new Promise<string>((resolve, reject) => {
			// gh はネットワーク I/O のためタイムアウト必須。無いとプロキシ環境等でハングしたとき
			// 呼び出し側 (Workspaces ビュー) の in-flight ガードが永久に解除されなくなる
			this.execFile(invocation.file, invocation.args, { cwd: invocation.cwd, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', windowsHide: true, env: invocation.env }, (err, stdout, stderr) => {
				if (err) {
					// 「gh が入っていない」の現れ方は実行経路で違う。ローカルは spawn の ENOENT、
					// WSL へ振り分けた場合は（起動するのが必ず存在する wsl.exe なので）挟んだ
					// シェルの終了コード 127 になる。ENOENT だけを見ていると、本来の目的である
					// WSL 構成でスロットルが一度も効かない。
					// なお ENOENT は「実行ファイルが無い」と「cwd へ届かない」を区別できないため、
					// ローカル側は cwd が実在するときだけ不在と判断する（判定は非同期で行い、
					// 同期 I/O で shared process を止めない。反映は次のポーリングで間に合う）。
					const exitCode = (err as { code?: unknown }).code;
					if (invocation.viaWsl) {
						if (exitCode === PARADIS_SHELL_COMMAND_NOT_FOUND_EXIT_CODE) {
							this.ghUnavailableSince.set(this.executionNamespaceKey(cwd), Date.now());
						}
					} else if (exitCode === 'ENOENT') {
						void fs.stat(cwd).then(
							() => this.ghUnavailableSince.set(this.executionNamespaceKey(cwd), Date.now()),
							() => { /* cwd へ届かないだけかもしれないので、gh 不在とは判断しない */ },
						);
					}
					const message = paradisReadableChildError(stderr, err, invocation.viaWsl);
					paradisRecordGithubCall({
						at: Date.now(),
						callSite,
						// gh CLI 経由の呼び出しは常に REST（gh api rate_limit の 'core' 資源）
						resource: 'core',
						durationMs: Date.now() - startedAt,
						// 「PR が無い」は gh が終了コード1で返すだけの正常系なので失敗に数えない
						success: paradisIsGithubNoPullRequestMessage(message),
						rateLimited: paradisIsGithubRateLimitMessage(message),
						errorMessage: message,
						worktreePath,
					});
					reject(new Error(message));
				} else {
					paradisRecordGithubCall({
						at: Date.now(),
						callSite,
						resource: 'core',
						durationMs: Date.now() - startedAt,
						success: true,
						rateLimited: false,
						worktreePath,
					});
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
		if (typeof worktreePath !== 'string' || worktreePath.length === 0 || this.isGhUnavailable(worktreePath)) {
			return undefined;
		}
		let branch: string;
		try {
			branch = (await this.exec(['-C', paradisWslPathArg(worktreePath), 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
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

	/**
	 * エージェントの対話から検出した GitHub Issue URL を番号・タイトル・状態へ解決する。
	 * `--repo` を明示するため worktreePath 自体のリポジトリと issueUrls の紐付け先が
	 * 別リポジトリでも正しく解決できる（cwd は gh 実行のためだけに使う）。
	 * gh CLI 未インストール・未認証・URL解釈失敗はその1件だけ resolved から欠落させる
	 * (Workspaces ビューのポーリング表示なので、個別の失敗で例外を伝播させない)。
	 * `attempted` には実際に gh へ問い合わせた URL を成否問わず入れる (呼び出し側が
	 * 「まだ結果が来ていない」と「試みたが解決できなかった」を区別するのに使う)。
	 */
	async getIssueStatuses(worktreePath: string, issueUrls: readonly string[]): Promise<IParadisIssueStatusesResult> {
		// IPC 境界の防御: 呼び出し元のバグ (undefined の文字列化等) を早期に無害化する
		if (typeof worktreePath !== 'string' || worktreePath.length === 0 || !Array.isArray(issueUrls) || this.isGhUnavailable(worktreePath)) {
			return { resolved: {}, attempted: [] };
		}
		const resolved: Record<string, IParadisIssueStatus> = {};
		const attempted: string[] = [];
		for (const url of issueUrls.slice(0, PARADIS_ISSUE_STATUS_LOOKUPS_PER_CALL)) {
			const parsed = typeof url === 'string' ? paradisParseIssueUrl(url) : undefined;
			if (parsed === undefined) {
				// URL自体が解釈できないのは呼び出し元のバグであり、gh へは問い合わせていないため
				// attempted には入れない (呼び出し側を「試行済み」と誤認させないため)。
				continue;
			}
			attempted.push(url);
			try {
				const stdout = await this.execGh(['issue', 'view', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--json', 'number,title,url,state'], worktreePath);
				const status = paradisParseGhIssueStatus(stdout);
				if (status !== undefined) {
					resolved[url] = status;
				}
			} catch (error) {
				this.logService.trace(`[ParadisWorktreeGit] gh issue view failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { resolved, attempted };
	}

	/** ローカルブランチ一覧（コミット日時の新しい順）と現在の HEAD ブランチを返す。 */
	async listBranches(repoPath: string): Promise<IParadisGitBranches> {
		const raw = await this.exec(['-C', paradisWslPathArg(repoPath), 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/']);
		const branches = raw.split('\n').map(line => line.trim()).filter(line => line.length > 0);
		let head: string | undefined;
		try {
			const headRaw = (await this.exec(['-C', paradisWslPathArg(repoPath), 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
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
			const raw = await this.exec(['-C', paradisWslPathArg(worktreePath), 'diff', 'HEAD', '--numstat']);
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
	// リクエスト型に `<string>` を明示しているのは、ここが電文を受け取る側だからで、意味がある。
	// 共有の型の既定は `ParadisHostPath`（送る側が綴りの規則を通したことの印）で、素の文字列を
	// 扱えるのは検証するこちら側だけ。詳細は src/vs/paradis/common/paradisHostPath.ts を参照。
	async addWorktree(request: IParadisAddWorktreeRequest<string>): Promise<void> {
		// IPC 境界の防御: 呼び出し側でサニタイズ済みだが、位置引数が git のオプションとして
		// 解釈されないことをここでも保証する（execFile なのでシェル注入は元々不可）
		for (const value of [request.newBranch, request.worktreePath, request.baseRef]) {
			if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
				throw new Error(`Invalid argument: ${String(value)}`);
			}
		}
		// stale なメタデータで add が失敗しないよう、先に prune しておく（Superset と同じ流儀）
		try {
			await this.exec(['-C', paradisWslPathArg(request.repoPath), 'worktree', 'prune']);
		} catch {
			// prune の失敗は致命的ではない
		}
		await this.exec(['-C', paradisWslPathArg(request.repoPath), 'worktree', 'add', '--no-track', '-b', request.newBranch, paradisWslPathArg(request.worktreePath), request.baseRef]);
	}

	/**
	 * git worktree remove [--force] <worktreePath> を実行する。
	 * 未コミット変更や未追跡ファイルがある場合、force なしだと git が失敗する（呼び出し側で
	 * force 付き再試行を確認する）。stale なメタデータで失敗しないよう先に prune する。
	 *
	 * `unlock` が立っている場合は先に `git worktree unlock` を試す。ロック済みの作業ツリーは
	 * `--force` を1つ付けても消えず、git は `-f -f` を要求するため（詳細は
	 * {@link IParadisRemoveWorktreeRequest<string>.unlock}）。`-f` を2つ渡す代わりに unlock を挟むのは、
	 * ロックの解除という取り消せない操作を、呼び出し側がユーザーの同意を得た場合だけに限るため。
	 */
	async removeWorktree(request: IParadisRemoveWorktreeRequest<string>): Promise<void> {
		// IPC 境界の防御: 位置引数が git のオプションとして解釈されないことを保証する
		if (typeof request.worktreePath !== 'string' || request.worktreePath.length === 0 || request.worktreePath.startsWith('-')) {
			throw new Error(`Invalid argument: ${String(request.worktreePath)}`);
		}
		try {
			await this.exec(['-C', paradisWslPathArg(request.repoPath), 'worktree', 'prune']);
		} catch {
			// prune の失敗は致命的ではない
		}
		// ロック解除は取り消せない副作用で、しかも「消せるかどうか」とは独立している。
		// remove が別の理由（ファイルを掴んでいるプロセス、権限、ネットワークボリューム等）で
		// 失敗すると、削除できていないのに他セッションの保護だけが消えた状態になる。
		// 解除する前に理由を控えておき、失敗したら掛け直す。
		let restoreLock: IParadisWorktreeLockInfo | undefined;
		if (request.unlock === true) {
			const lock = await this.readWorktreeLock(request);
			try {
				await this.exec(['-C', paradisWslPathArg(request.repoPath), 'worktree', 'unlock', paradisWslPathArg(request.worktreePath)]);
				// 掛け直すかどうかは **unlock が成功したこと** から決める。`git worktree unlock` は
				// ロックされていない相手には必ず失敗するので、成功＝確かにロックされていた。
				// 直前の読み取り結果を根拠にすると、`git worktree list` の spawn が一過性の理由で
				// 転けただけのときに「ロックされていなかった」と誤解し、掛け直さずに終わってしまう。
				// 理由が読めていなくても掛け直す（理由なしのロックとして戻すほうが、失うよりよい）。
				restoreLock = { locked: true, reason: lock.reason };
			} catch {
				// ロックされていなかった場合も失敗するので、ここでは中断しない（remove 側で判断する）
			}
		}
		const args: ParadisCommandArgument[] = ['-C', paradisWslPathArg(request.repoPath), 'worktree', 'remove'];
		if (request.force) {
			args.push('--force');
		}
		args.push(paradisWslPathArg(request.worktreePath));
		try {
			await this.exec(args);
		} catch (error) {
			if (restoreLock !== undefined) {
				const relock: ParadisCommandArgument[] = ['-C', paradisWslPathArg(request.repoPath), 'worktree', 'lock'];
				if (restoreLock.reason) {
					relock.push('--reason', restoreLock.reason);
				}
				relock.push(paradisWslPathArg(request.worktreePath));
				try {
					await this.exec(relock);
				} catch {
					// 掛け直せなくても削除失敗そのものは伝える（呼び出し側がエラーを出す）
				}
			}
			throw error;
		}
	}

	/**
	 * 対象 worktree がロックされているかと、その理由を返す。
	 *
	 * 判定に git のエラー文言を使わないのは、それが翻訳対象で環境の locale に左右されるため。
	 * `--porcelain` は機械可読で翻訳されない。
	 */
	async readWorktreeLock(request: IParadisWorktreeLockQuery<string>): Promise<IParadisWorktreeLockInfo> {
		const notLocked: IParadisWorktreeLockInfo = { locked: false, reason: '' };
		if (typeof request.worktreePath !== 'string' || request.worktreePath.length === 0) {
			return notLocked;
		}
		let output: string;
		try {
			output = await this.exec(['-C', paradisWslPathArg(request.repoPath), 'worktree', 'list', '--porcelain', '-z']);
		} catch {
			return notLocked;
		}
		// WSL の中で実行した場合、git が返すのはディストロから見た絶対パスなので、Windows 側で
		// realpath をかけても噛み合わない（かけると UNC のまま返ってきて必ず不一致になる）。
		// 要求パスを同じ名前空間へ写して、解決なしで突き合わせる。ディストロ内の symlink は
		// 解決できないままだが、今のように必ず見逃すよりはよい。
		//
		// どちらで実行されたかを決めるのは `-C` に渡した repoPath なので、比較方法の分岐も
		// そちらを基準にする。worktreePath 側で判定すると、両者が別の名前空間だったときに
		// 「実行は一方、比較は他方の規則」になり、必ず不一致＝ロックの見逃しになる。
		const wslRepo = this.isWindowsHost ? paradisParseWslUncPath(request.repoPath) : undefined;
		if (wslRepo !== undefined) {
			const wslWorktree = paradisParseWslUncPath(request.worktreePath);
			if (wslWorktree === undefined || wslWorktree.distro.toLowerCase() !== wslRepo.distro.toLowerCase()) {
				return notLocked; // 別の名前空間の作業ツリーは、この一覧には出てこない
			}
			return paradisFindWorktreeLock(paradisParseWorktreeListPorcelain(output), wslWorktree.linuxPath, { ignoreCase: false, backslashIsSeparator: false });
		}
		// git は実体解決済みのパスを返す（macOS の /tmp → /private/tmp 等）ので、
		// 素の文字列比較では取り違える。両側を解決してから突き合わせる。
		const target = await this.resolveWorktreePath(request.worktreePath);
		const entries = await Promise.all(paradisParseWorktreeListPorcelain(output)
			.map(async entry => ({ ...entry, path: await this.resolveWorktreePath(entry.path) })));
		return paradisFindWorktreeLock(entries, target, { ignoreCase: !isLinux, backslashIsSeparator: isWindows });
	}

	/**
	 * 実体解決したパスを返す。
	 *
	 * 末尾（作業ツリー自身）は既に消えていることがある——ロック済みエントリは
	 * `git worktree prune` で刈られないので、実体だけ `rm -rf` された状態が普通に残る。
	 * そこで親ディレクトリだけを解決して名前を継ぎ足す。丸ごと realpath して失敗し、
	 * 生パスへ落ちると、途中に symlink が1つでもあるだけで（macOS の /tmp、symlink された
	 * home、/Volumes 配下）git 側の解決済みパスと噛み合わずロックを見逃す。
	 */
	private async resolveWorktreePath(path: string): Promise<string> {
		try {
			return await fs.realpath(path);
		} catch {
			// 葉が無いだけかもしれない。親が解決できるならそちらで組み立てる。
		}
		try {
			const parent = dirname(path);
			return parent === path ? path : join(await fs.realpath(parent), basename(path));
		} catch {
			return path;
		}
	}

	/**
	 * リポジトリ定義の setup/teardown スクリプトを、対象 worktree を cwd として解決済みシェルで実行する。
	 * 環境変数 PARACODE_PROJECT_ROOT_PATH に親リポジトリの絶対パスを渡す。
	 */
	async runLifecycleScript(request: IParadisRunLifecycleScriptRequest<string>): Promise<void> {
		if (!request.script.trim() || !request.repoPath || !request.worktreePath) {
			throw new Error('Invalid lifecycle script request.');
		}
		const env = await this.cachedShellEnv.getEnv();
		// Windows では SHELL が設定されていても（Git Bash 等）引数形式が /c 系と食い違うため、
		// プラットフォームごとにシェルと引数形式を対で選ぶ
		const shell = isWindows ? (env.ComSpec || 'cmd.exe') : (env.SHELL || '/bin/sh');
		const args = isWindows ? ['/d', '/s', '/c', request.script] : ['-lc', request.script];
		const timeoutMs = paradisLifecycleScriptTimeoutMs(request);
		// `detached` は execFile の型定義には無いが、ランタイムでは spawn へそのまま透過される。
		// POSIX ではスクリプトを独立したプロセスグループにし、タイムアウト時に
		// バックグラウンド化した孫プロセス（`some-daemon &` 等）ごと殺せるようにする
		const options: cp.ExecFileOptionsWithStringEncoding & { detached: boolean } = {
			cwd: request.worktreePath,
			encoding: 'utf8',
			timeout: timeoutMs,
			killSignal: 'SIGKILL',
			// bun install 等は 1MiB (Node 既定) を超える出力を吐き得る。上限は明示しつつ余裕を持たせる
			maxBuffer: PARADIS_LIFECYCLE_SCRIPT_MAX_BUFFER_BYTES,
			detached: !isWindows,
			env: { ...env, [PARADIS_PROJECT_ROOT_ENV_VAR]: request.repoPath }
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
					reject(new Error(localize('paradis.workspaceLifecycle.scriptTimedOut', "{0} スクリプトが {1} 分以内に終了しなかったため、強制終了しました。", label, timeoutMs / 60_000)));
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
	/** git clone の進捗。 */
	readonly onCloneProgress = this._onCloneProgress.event;

	/** 実行中の clone。cloneId → プロセス・依頼元・キャンセル済みフラグ。 */
	private readonly runningClones = new Map<string, IParadisRunningClone>();

	/**
	 * プロセスが終わる直前に走行中の clone を始末する係。走行中の clone が1本も無い間は
	 * 取り付けない（テストや、clone を一度も使わないプロセスに listener を残さないため）。
	 */
	private exitGuard: (() => void) | undefined;

	/**
	 * このプロセス（または、このサービス）が終わろうとしているか。立っている間は作りかけの
	 * ディレクトリを消さない——削除を始めても最後まで走り切れる保証が無く、途中で止まると
	 * 中途半端に削られたディレクトリが残るため。
	 */
	private shuttingDown = false;

	/**
	 * git clone --progress を実行する。stderr のステージ進捗を onCloneProgress で配信し、
	 * 完了/失敗はこの呼び出しの resolve/reject で伝える。キャンセル時は CancellationError
	 * (name: 'Canceled') で reject する。失敗・キャンセル時は作りかけのディレクトリを削除する
	 * (開始前に未存在を確認しているので、消してよいのはこの clone が作ったものに限られる)。
	 *
	 * @param owner この clone を依頼した接続。渡しておくと、その接続が消えたときに
	 * {@link cancelClonesFor} で畳める。省略すると誰のものでもない clone になり、
	 * サービスが畳まれるまで走り続ける。
	 */
	async cloneRepository(request: IParadisCloneRepositoryRequest<string>, owner?: ParadisCloneOwner): Promise<void> {
		const { url, targetPath, cloneId } = request ?? {};
		// IPC 境界の防御: 位置引数が git のオプションとして解釈されないことを保証する
		// (url は '--' の後ろに置くが、多層防御として '-' 始まりも拒否する)
		for (const value of [url, targetPath, cloneId]) {
			if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
				throw new Error(`Invalid argument: ${String(value)}`);
			}
		}
		if (this.shuttingDown) {
			throw new CancellationError();
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
				const child = this.spawn('git', ['clone', '--progress', '--', url, targetPath], {
					env: { ...env, GIT_TERMINAL_PROMPT: '0' },
					stdio: ['ignore', 'ignore', 'pipe'],
				});
				const entry: IParadisRunningClone = { child, owner, canceled: false, killTimer: undefined };
				this.trackClone(cloneId, entry);

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
					this.untrackClone(cloneId);
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
			// このプロセス自体が終わろうとしている間は消さない。数 GB の再帰削除は途中で
			// プロセスごと消えるほうが普通で、そうなると「中途半端に削られたディレクトリ」が
			// 残る——手を付けずに残すより悪い。畳む道 (dispose と exit ガード) が消さないのと
			// 同じ扱いに揃えてある。残骸は次の clone が「フォルダが既に存在します」として見せる。
			if (!this.shuttingDown) {
				// 開始前に targetPath の未存在を確認済みなので、残骸はこの clone が作ったもの。
				// git は kill 時にディレクトリを掃除しないことがあるため明示的に消す (ベストエフォート)
				try {
					await fs.rm(targetPath, { recursive: true, force: true });
				} catch {
					// 削除失敗は元のエラーを優先する
				}
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
		// 誰の clone かは記録しているが、ここでは照合しない（依頼元以外からの cancel を
		// 拒むのは別の話——このチャネルの権限分けとして扱う）。畳む側の入り口はここに集約して
		// あるので、照合を足すならこの1箇所で済む。
		this.stopClone(entry);
		return true;
	}

	/**
	 * ある接続が始めた clone をまとめて畳む。
	 *
	 * 接続が消えたということは、進捗を受け取る相手も、途中でやめる口も無くなったということ。
	 * 放っておくと `git clone` は最後まで走り切るか、無進捗タイムアウトまで居座る。巨大な
	 * リポジトリだと、その間ずっと接続先の帯域とディスクを使い続ける。
	 */
	cancelClonesFor(owner: ParadisCloneOwner): void {
		for (const [cloneId, entry] of this.runningClones) {
			if (entry.owner === owner) {
				this.logService.info(`[ParadisWorktreeGit] the client that started clone ${cloneId} is gone; stopping it`);
				this.stopClone(entry);
			}
		}
	}

	/**
	 * 走行中の clone を1本畳む。
	 *
	 * 先に `canceled` を立てるのは、close ハンドラがこれを見て CancellationError で settle し、
	 * 作りかけのディレクトリを消すため。ここで台帳から消さないのも同じ理由で、後始末は
	 * close の側に一本化してある。
	 */
	private stopClone(entry: IParadisRunningClone): void {
		if (entry.canceled) {
			return;
		}
		entry.canceled = true;
		entry.child.kill('SIGTERM');
		// SIGTERM で終了しない場合の保険。素直に終わったときは close 側で引き取る
		// （無進捗タイマーと同じ扱い。放っておくと 5 秒ぶんプロセスを終われなくする）。
		entry.killTimer = setTimeout(() => entry.child.kill('SIGKILL'), PARADIS_CLONE_KILL_GRACE_MS);
	}

	private trackClone(cloneId: string, entry: IParadisRunningClone): void {
		this.runningClones.set(cloneId, entry);
		if (this.exitGuard === undefined) {
			// このプロセスが終わるときに、走行中の clone を道連れにする。
			//
			// dispose 側の後始末だけでは足りない。REH のサーバーは寿命が尽きると
			// `serverLifetimeService` がその場で `process.exit(0)` を呼ぶだけで、
			// `setupServerServices` が積んだ DisposableStore は誰も畳まない
			// （src/vs/server/node/remoteExtensionHostAgentServer.ts の `disposables` は
			// 作られるだけで dispose される場所が無い）。POSIX では親が終わっても子は
			// 死なないので、ここで殺さないと `git clone` だけが接続先に残る。
			//
			// ここでは作りかけのディレクトリは消さない。終了処理の中で数 GB の再帰削除を
			// 同期で始めるほうが危ないので、残骸は次の clone が「フォルダが既に存在します」
			// として見せる側に倒す（外から SIGKILL された場合も同じ結果になる）。
			this.exitGuard = () => {
				this.shuttingDown = true;
				for (const running of this.runningClones.values()) {
					running.canceled = true;
					running.child.kill('SIGKILL');
				}
			};
			process.once('exit', this.exitGuard);
		}
	}

	private untrackClone(cloneId: string): void {
		const entry = this.runningClones.get(cloneId);
		if (entry !== undefined) {
			clearTimeout(entry.killTimer);
			entry.killTimer = undefined;
		}
		this.runningClones.delete(cloneId);
		if (this.runningClones.size === 0 && this.exitGuard !== undefined) {
			process.removeListener('exit', this.exitGuard);
			this.exitGuard = undefined;
		}
	}

	/**
	 * サービスを畳む。走行中の clone は、購読者がもう居ないので止める。
	 *
	 * SIGTERM ではなく SIGKILL なのは、畳むと決めた後に猶予を待つ相手が居ないため
	 * （猶予タイマーが動く前にプロセスごと終わることがある）。
	 *
	 * ここから先は作りかけのディレクトリを消さない（`shuttingDown` を立てる）。畳むのは
	 * プロセスが終わる直前で、数 GB の再帰削除は途中で打ち切られるほうが普通だから——
	 * 中途半端に削られたディレクトリは、手を付けずに残すより悪い。exit ガードと同じ扱い。
	 */
	dispose(): void {
		this.shuttingDown = true;
		for (const [cloneId, entry] of this.runningClones) {
			this.logService.info(`[ParadisWorktreeGit] shutting down while clone ${cloneId} is running; stopping it`);
			entry.canceled = true;
			clearTimeout(entry.killTimer);
			entry.killTimer = undefined;
			entry.child.kill('SIGKILL');
		}
		this.runningClones.clear();
		if (this.exitGuard !== undefined) {
			process.removeListener('exit', this.exitGuard);
			this.exitGuard = undefined;
		}
		this._onCloneProgress.dispose();
	}
}

// TContext をジェネリックにしてあるのは、shared process（IPCServer<string>）だけでなく
// リモートサーバー（REH の SocketServer<RemoteAgentConnectionContext>）にも同じチャネルを
// 登録するため。SSH 接続中に「接続先へクローンする」を選べるようにするのに必要。
export class ParadisWorktreeGitChannel<TContext extends ParadisCloneOwner = string> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisWorktreeGitService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		if (event === 'onCloneProgress') {
			return this.service.onCloneProgress as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			// ctx をそのまま渡すのは、これが接続の間ずっと同じ値だから。接続が消えたときに
			// 「その接続が始めた clone」を選び出す印になる（登録側の onDidRemoveConnection 参照）。
			case 'cloneRepository': return this.service.cloneRepository(args[0] as IParadisCloneRepositoryRequest<string>, ctx) as Promise<T>;
			case 'cancelClone': return Promise.resolve(this.service.cancelClone(String(args[0]))) as Promise<T>;
			case 'listBranches': return this.service.listBranches(String(args[0])) as Promise<T>;
			case 'addWorktree': return this.service.addWorktree(args[0] as IParadisAddWorktreeRequest<string>) as Promise<T>;
			case 'getDiffStat': return this.service.getDiffStat(String(args[0])) as Promise<T>;
			case 'getPrStatus': return this.service.getPrStatus(String(args[0])) as Promise<T>;
			case 'getIssueStatuses': return this.service.getIssueStatuses(String(args[0]), Array.isArray(args[1]) ? args[1].filter((value): value is string => typeof value === 'string') : []) as Promise<T>;
			case 'removeWorktree': return this.service.removeWorktree(args[0] as IParadisRemoveWorktreeRequest<string>) as Promise<T>;
			case 'readWorktreeLock': return this.service.readWorktreeLock(args[0] as IParadisWorktreeLockQuery<string>) as Promise<T>;
			case 'runLifecycleScript': return this.service.runLifecycleScript(args[0] as IParadisRunLifecycleScriptRequest<string>) as Promise<T>;
			case 'runGit': return this.service.runGit(String(args[0]), Array.isArray(args[1]) ? args[1].filter((value): value is string => typeof value === 'string') : []) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * 「このチャネルを畳んだら、走行中の clone も畳む」を両方の登録口で共通にする。
 *
 * @param cancelClonesOnDisconnect 接続が消えたら、その接続が始めた clone を止めるか。
 * **REH でだけ true にすること。** REH の接続が消えるのは再接続の猶予が尽きたときか
 * graceful disconnect のときで（`ManagementConnection.onClose`）、一瞬の回線断では消えない。
 * つまり「進捗を見ている人も、途中でやめる口も、もう無い」が本当に成り立つ。
 * 対して shared process の接続は MessagePort の `close` そのものなので、**ウィンドウを
 * 再読み込みしただけでも消える**。そこで止めると、手元での clone 中に Reload Window した
 * だけで作りかけのディレクトリごと消える（従来は完走していた）。手元は畳むのを dispose に
 * 任せる。
 */
function paradisRegisterWorktreeGitChannel<TContext extends ParadisCloneOwner>(server: IPCServer<TContext>, service: ParadisWorktreeGitService, cancelClonesOnDisconnect: boolean): IDisposable {
	const store = new DisposableStore();
	if (cancelClonesOnDisconnect) {
		store.add(server.onDidRemoveConnection(connection => service.cancelClonesFor(connection.ctx)));
	}
	server.registerChannel(PARADIS_WORKTREE_GIT_CHANNEL, new ParadisWorktreeGitChannel<TContext>(service));
	store.add(toDisposable(() => service.dispose()));
	return store;
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisWorktreeGit(server: IPCServer<string>, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	return paradisRegisterWorktreeGitChannel(server, new ParadisWorktreeGitService(logService, configurationService, args), false);
}

/**
 * serverServices.ts（REH）の PARA-PATCH 点から1行で呼べるファクトリ。
 *
 * SSH 接続中に「接続先へクローンする」を選んだとき、git を動かすのは接続先でなければ
 * ならない。shared process 版は常に手元で動くため、同じチャネルを接続先にも生やす。
 *
 * configurationService / args を渡さないのは、どちらもログインシェルの環境変数を解決する
 * ためのオプションで（未指定でも既定の解決にフォールバックする）、サーバー側には対応する
 * 実体が無いため。ログインシェルを介する runLifecycleScript は接続先の ~/.profile 等で PATH が
 * 戻るが、execFile 直叩きの git / gh は接続先の PATH に載っている必要がある（gh を
 * ~/.local/bin などに入れている接続先では、PR 状態が取れないことがある）。
 */
export function registerParadisWorktreeGitForServer<TContext extends ParadisCloneOwner>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	return paradisRegisterWorktreeGitChannel(server, new ParadisWorktreeGitService(logService), true);
}
