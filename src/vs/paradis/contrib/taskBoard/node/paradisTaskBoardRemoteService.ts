/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * タスクボードの SSH 中継の、接続先（REH）の側（q.html Q472 = A、Q525）。設計書は taskboard-ssh-relay-design.html。
 *
 * ここで守ること（設計書の R1〜R7）:
 *  - R1 型の決まった操作だけを受ける（argv は common/paradisTaskBoardRemote.ts が組み立てる）
 *  - R2 作業場所の root は、セッションを開いたリポジトリと、そのリポジトリのワークツリーで、持ち主が自分のものだけ
 *  - R3 読み書きは root の中だけ。1 段ずつ lstat して symlink を断り、開いた fd が確かめたファイルと同じかを照合する
 *  - R4 push は既定のブランチへは送らない（common 側）
 *  - R5 環境変数は REH 側で組み立てる
 *  - R6 同時実行・出力・時間の上限
 *  - R7 プロセスグループで止める。心拍が途絶えたら、そのセッションの実行をすべて止める
 *
 * 許すかどうか（コマンドの承認、push の確認、ボードが作ったブランチの記録）は手元のウィンドウで決める。ここでは扱わない。
 */

import * as cp from 'child_process';
import { randomBytes } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, join } from '../../../../base/common/path.js';
import { isLinux } from '../../../../base/common/platform.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	PARADIS_TASK_BOARD_REMOTE_BOARD_DIR,
	PARADIS_TASK_BOARD_REMOTE_LIMITS,
	ParadisTaskBoardRemoteError,
	paradisTaskBoardRemoteAbsolutePathError,
	paradisTaskBoardRemoteCommandError,
	paradisTaskBoardRemoteEnv,
	paradisTaskBoardRemoteGitPlan,
	paradisTaskBoardRemoteIsProtectedBranch,
	paradisTaskBoardRemoteIsWritablePath,
	paradisTaskBoardRemoteSegments,
} from '../common/paradisTaskBoardRemote.js';

/** 打ち切り時間（テストから差し替える）。 */
export interface IParadisTaskBoardRemoteTimeouts {
	/** 読むだけの git と、ワークツリー・ブランチの操作。 */
	readonly gitShortMs: number;
	/** fetch・push・commit（通信とフック）。 */
	readonly gitLongMs: number;
	readonly commandMs: number;
	readonly killGraceMs: number;
	readonly closeGraceMs: number;
	readonly heartbeatExpiryMs: number;
}

const DEFAULT_TIMEOUTS: IParadisTaskBoardRemoteTimeouts = {
	gitShortMs: 30_000,
	gitLongMs: 120_000,
	commandMs: PARADIS_TASK_BOARD_REMOTE_LIMITS.commandTimeoutMs,
	killGraceMs: PARADIS_TASK_BOARD_REMOTE_LIMITS.killGraceMs,
	closeGraceMs: PARADIS_TASK_BOARD_REMOTE_LIMITS.closeGraceMs,
	heartbeatExpiryMs: PARADIS_TASK_BOARD_REMOTE_LIMITS.heartbeatExpiryMs,
};

export interface IParadisTaskBoardRemoteGitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export interface IParadisTaskBoardRemoteRunResult {
	readonly code: number | null;
	readonly signal: string | null;
	readonly cancelled: boolean;
	readonly timedOut: boolean;
	readonly stdout: string;
}

export interface IParadisTaskBoardRemoteOutput {
	readonly sessionId: string;
	readonly runId: string;
	readonly lines: readonly string[];
}

export interface IParadisTaskBoardRemoteOpenResult {
	readonly toplevel: string;
	readonly commonDir: string;
}

interface IRun {
	readonly runId: string;
	cancel(): void;
}

interface ISession {
	readonly id: string;
	readonly toplevel: string;
	readonly commonDir: string;
	/** ボードのワークツリーを置くフォルダ（無ければワークツリーを作らせない）。 */
	readonly worktreeRoot: string | undefined;
	/** 作業場所として使ってよい root（realpath 済み）。 */
	readonly places: Set<string>;
	/** このセッションで作ったワークツリー（外してよいのはこれだけ）。 */
	readonly createdWorktrees: Set<string>;
	readonly runs: Map<string, IRun>;
	lastHeartbeat: number;
	inFlight: number;
	queued: number;
	/** git をリポジトリごとに 1 本ずつ流す列。 */
	gitQueue: Promise<unknown>;
	closed: boolean;
}

const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TASK_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function checkId(value: unknown, pattern: RegExp, label: string): string {
	if (typeof value !== 'string' || !pattern.test(value)) {
		throw new ParadisTaskBoardRemoteError('invalid', `${label} is not valid`);
	}
	return value;
}

function checkAbsolute(value: unknown): string {
	const error = paradisTaskBoardRemoteAbsolutePathError(value);
	if (error !== undefined) {
		throw new ParadisTaskBoardRemoteError('invalid', error);
	}
	return value as string;
}

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/** node のタイマーなら、プロセスの終了を引き止めないようにする（型の上では unref を持たない）。 */
function unref(timer: unknown): void {
	(timer as { unref?: () => void }).unref?.();
}

/** 出力を上限まで集める。 */
function appendCapped(current: string, chunk: string, max: number): string {
	return current.length >= max ? current : current + chunk.slice(0, max - current.length);
}

/** `.para/` を空にするときに辿る深さと件数の上限。 */
const CLEAR_MAX_DEPTH = 32;
const CLEAR_MAX_ENTRIES = 10_000;

/**
 * 開いたフォルダ。中の名前は `/proc/self/fd/<fd>/<名前>` で指す（開いた inode を起点に解決される）。
 */
class ParadisDirectoryHandle {

	private constructor(private readonly handle: fs.FileHandle) { }

	/** 開いたフォルダそのものを指すパス。 */
	get self(): string {
		return `/proc/self/fd/${this.handle.fd}`;
	}

	/** フォルダの中の 1 つの名前（`/` を含まない、形を確かめた段）。 */
	entry(name: string): string {
		return `${this.self}/${name}`;
	}

	/** root を開く。symlink（最後の段）・フォルダでないもの・持ち主が違うものは断る。 */
	static async openRoot(path: string, uid: number): Promise<ParadisDirectoryHandle> {
		const handle = await ParadisDirectoryHandle.openDirectory(path, path);
		if (handle === undefined) {
			throw new ParadisTaskBoardRemoteError('denied', `the folder does not exist: ${path}`);
		}
		const info = await handle.handle.stat();
		if (info.uid !== uid) {
			await handle.close();
			throw new ParadisTaskBoardRemoteError('denied', `the folder is not owned by this user: ${path}`);
		}
		return handle;
	}

	/** 中のフォルダを開く。無ければ `mode` があれば作り、無ければ undefined。 */
	async child(name: string, mode: number | undefined): Promise<ParadisDirectoryHandle | undefined> {
		const opened = await ParadisDirectoryHandle.openDirectory(this.entry(name), name);
		if (opened !== undefined || mode === undefined) {
			return opened;
		}
		await fs.mkdir(this.entry(name), { mode }).catch(error => {
			if (!isErrno(error, 'EEXIST')) {
				throw error;
			}
		});
		const created = await ParadisDirectoryHandle.openDirectory(this.entry(name), name);
		if (created === undefined) {
			throw new ParadisTaskBoardRemoteError('denied', `the folder could not be created: ${name}`);
		}
		return created;
	}

	close(): Promise<void> {
		return this.handle.close();
	}

	private static async openDirectory(path: string, label: string): Promise<ParadisDirectoryHandle | undefined> {
		try {
			return new ParadisDirectoryHandle(await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW));
		} catch (error) {
			if (isErrno(error, 'ENOENT')) {
				return undefined;
			}
			if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) {
				throw new ParadisTaskBoardRemoteError('denied', `the path goes through a symbolic link or a file: ${label}`);
			}
			throw error;
		}
	}
}

export class ParadisTaskBoardRemoteService extends Disposable {

	private readonly sessions = new Map<string, ISession>();
	private readonly _onOutput = this._register(new Emitter<IParadisTaskBoardRemoteOutput>());
	readonly onOutput: Event<IParadisTaskBoardRemoteOutput> = this._onOutput.event;
	private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly logService: ILogService,
		/** REH 自身の環境（ログインシェルで解決したもの）。手元から送られた値は混ぜない。 */
		private readonly baseEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly timeouts: IParadisTaskBoardRemoteTimeouts = DEFAULT_TIMEOUTS,
		private readonly now: () => number = Date.now,
		private readonly spawn: typeof cp.spawn = cp.spawn,
		/** 自分の uid。作業場所の持ち主の照合に使う。テストからのみ差し替える。 */
		private readonly uid: number | undefined = process.getuid?.(),
		sweep = true,
		/** ファイルを確かめた後、書き換え・削除の直前に呼ぶ。すり替えを試すテストからのみ差し替える。 */
		private readonly afterCheck: (stage: 'write' | 'reset') => Promise<void> = async () => { },
	) {
		super();
		if (sweep) {
			this.sweepTimer = setInterval(() => this.sweepHeartbeats(), Math.min(30_000, this.timeouts.heartbeatExpiryMs));
			unref(this.sweepTimer);
		}
	}

	override dispose(): void {
		if (this.sweepTimer !== undefined) {
			clearInterval(this.sweepTimer);
		}
		for (const session of [...this.sessions.values()]) {
			this.close(session);
		}
		super.dispose();
	}

	// --- セッション -------------------------------------------------------------------------

	/**
	 * セッションを開く。`repoRoot` はリポジトリの toplevel（realpath 済みの形）で、持ち主が自分のもの。
	 * `worktreeRoot` はボードのワークツリーを置くフォルダで、無ければ 0700 で作り、あれば持ち主が自分で
	 * グループ・他人が書けないことを確かめる（`/tmp` のような共有の場所に置かせない）。
	 */
	async openSession(sessionId: unknown, repoRoot: unknown, worktreeRoot?: unknown): Promise<IParadisTaskBoardRemoteOpenResult> {
		this.ensureSupported();
		const id = checkId(sessionId, SESSION_ID, 'session id');
		if (this.sessions.has(id)) {
			throw new ParadisTaskBoardRemoteError('invalid', 'session already exists');
		}
		const root = await this.checkOwnedDirectory(checkAbsolute(repoRoot));
		const toplevel = (await this.runGitUnqueued(root, { kind: 'toplevel' })).trim();
		if (toplevel !== root) {
			throw new ParadisTaskBoardRemoteError('denied', 'the folder is not the top of a git repository');
		}
		const commonDir = await fs.realpath((await this.runGitUnqueued(root, { kind: 'commonDir' })).trim());
		const worktrees = worktreeRoot === undefined || worktreeRoot === null ? undefined : await this.prepareWorktreeRoot(checkAbsolute(worktreeRoot));
		if (this.sessions.has(id)) {
			throw new ParadisTaskBoardRemoteError('invalid', 'session already exists');
		}
		this.sessions.set(id, {
			id, toplevel: root, commonDir, worktreeRoot: worktrees,
			places: new Set([root]), createdWorktrees: new Set(), runs: new Map(),
			lastHeartbeat: this.now(), inFlight: 0, queued: 0, gitQueue: Promise.resolve(), closed: false,
		});
		return { toplevel: root, commonDir };
	}

	closeSession(sessionId: unknown): void {
		const session = this.sessions.get(checkId(sessionId, SESSION_ID, 'session id'));
		if (session) {
			this.close(session);
		}
	}

	heartbeat(sessionId: unknown): void {
		this.session(sessionId).lastHeartbeat = this.now();
	}

	/** 心拍が途絶えたセッションを閉じる（実行中のコマンドを止める）。タイマーとテストから呼ぶ。 */
	sweepHeartbeats(): void {
		const now = this.now();
		for (const session of [...this.sessions.values()]) {
			if (now - session.lastHeartbeat > this.timeouts.heartbeatExpiryMs) {
				this.logService.info(`[ParadisTaskBoardRemote] session ${session.id} lost its heartbeat; stopping ${session.runs.size} run(s)`);
				this.close(session);
			}
		}
	}

	/**
	 * 既にあるフォルダを作業場所として登録する（clone の作業場所や、Para Code のスペースのワークツリー）。
	 * 同じリポジトリ（git の common dir が同じ）の作業ツリーの一番上で、持ち主が自分のものだけ。
	 */
	async registerPlace(sessionId: unknown, place: unknown): Promise<void> {
		const session = this.session(sessionId);
		const dir = await this.checkOwnedDirectory(checkAbsolute(place));
		await this.checkSameRepository(session, dir);
		session.places.add(dir);
	}

	private session(sessionId: unknown): ISession {
		const session = this.sessions.get(checkId(sessionId, SESSION_ID, 'session id'));
		if (!session || session.closed) {
			throw new ParadisTaskBoardRemoteError('unknown-session', 'the task board session is not open');
		}
		return session;
	}

	private close(session: ISession): void {
		session.closed = true;
		this.sessions.delete(session.id);
		for (const run of [...session.runs.values()]) {
			run.cancel();
		}
	}

	private ensureSupported(): void {
		// 接続先の REH は Linux だけを配っている（.github/workflows/para-reh.yml）。Windows のパスと持ち主の規則はここに無い
		// ファイルの読み書きは /proc/self/fd を使って fd を起点に辿る（Linux だけ）
		if (!isLinux || this.uid === undefined) {
			throw new ParadisTaskBoardRemoteError('unsupported', 'the task board relay runs only on Linux hosts');
		}
	}

	/** 作業場所の root が登録済みで、今も同じ場所（realpath が変わっていない）か。 */
	private async place(session: ISession, place: unknown): Promise<string> {
		const dir = checkAbsolute(place);
		if (!session.places.has(dir)) {
			throw new ParadisTaskBoardRemoteError('denied', 'the folder is not a workspace of this task board session');
		}
		await this.checkOwnedDirectory(dir);
		return dir;
	}

	/** realpath が自分自身（symlink を通っていない）で、ディレクトリで、持ち主が自分のものか。 */
	private async checkOwnedDirectory(dir: string): Promise<string> {
		const real = await fs.realpath(dir).catch(() => undefined);
		if (real !== dir) {
			throw new ParadisTaskBoardRemoteError('denied', `the folder does not exist or is reached through a symbolic link: ${dir}`);
		}
		const info = await fs.lstat(dir);
		if (!info.isDirectory() || info.uid !== this.uid) {
			throw new ParadisTaskBoardRemoteError('denied', `the folder is not a directory owned by this user: ${dir}`);
		}
		return dir;
	}

	private async checkSameRepository(session: ISession, dir: string): Promise<void> {
		const toplevel = (await this.runGitUnqueued(dir, { kind: 'toplevel' }).catch(() => '')).trim();
		const commonDir = await fs.realpath((await this.runGitUnqueued(dir, { kind: 'commonDir' }).catch(() => '')).trim()).catch(() => undefined);
		if (toplevel !== dir || commonDir !== session.commonDir) {
			throw new ParadisTaskBoardRemoteError('denied', 'the folder is not a work tree of the session repository');
		}
	}

	private async prepareWorktreeRoot(dir: string): Promise<string> {
		const parent = await this.checkOwnedDirectory(dirname(dir));
		try {
			await fs.mkdir(join(parent, basename(dir)), { mode: 0o700 });
		} catch (error) {
			if (!isErrno(error, 'EEXIST')) {
				throw error;
			}
		}
		const root = await this.checkOwnedDirectory(dir);
		const info = await fs.lstat(root);
		if ((info.mode & 0o022) !== 0) {
			throw new ParadisTaskBoardRemoteError('denied', `the worktree folder is writable by other users: ${dir}`);
		}
		return root;
	}

	// --- git ---------------------------------------------------------------------------------

	/**
	 * 作業場所で git の操作を 1 つ行う。終了コードは投げずに返す（ボードが判定する）。
	 * ワークツリーの追加は worktree root の直下の新しいフォルダだけ、外すのはこのセッションで作ったものだけ。
	 */
	async git(sessionId: unknown, place: unknown, op: unknown): Promise<IParadisTaskBoardRemoteGitResult> {
		const session = this.session(sessionId);
		const dir = await this.place(session, place);
		const kind = (op as { kind?: unknown } | undefined)?.kind;
		let worktreeDir: string | undefined;
		if (kind === 'worktreeAdd' || kind === 'worktreeRemove') {
			if (dir !== session.toplevel) {
				throw new ParadisTaskBoardRemoteError('denied', 'worktrees are managed from the repository folder');
			}
			worktreeDir = checkAbsolute((op as { dir?: unknown }).dir);
			if (kind === 'worktreeAdd') {
				await this.checkNewWorktreeDir(session, worktreeDir);
			} else if (!session.createdWorktrees.has(worktreeDir)) {
				throw new ParadisTaskBoardRemoteError('denied', 'only worktrees created by this task board session can be removed');
			}
		}
		const plan = paradisTaskBoardRemoteGitPlan(dir, op);
		if (kind === 'push') {
			await this.checkHostDefaultBranch(session, dir, (op as { branch: string }).branch);
		}
		const result = await this.enqueueGit(session, () => this.execGit(plan.args, plan.network || plan.hooks ? this.timeouts.gitLongMs : this.timeouts.gitShortMs));
		if (worktreeDir !== undefined && result.code === 0 && !session.closed) {
			if (kind === 'worktreeAdd') {
				const created = await this.checkOwnedDirectory(worktreeDir);
				session.createdWorktrees.add(created);
				session.places.add(created);
			} else {
				session.createdWorktrees.delete(worktreeDir);
				session.places.delete(worktreeDir);
			}
		}
		return result;
	}

	/**
	 * 既定のブランチへの push を、ボードが渡した `defaultBranch` だけに頼らず、接続先の `refs/remotes/origin/HEAD` を
	 * 自分で読んで断る（`main`・`master` は common 側で常に断る）。限界: `origin/HEAD` は作業場所の利用者（担当の
	 * エージェントを含む）が `git remote set-head` で書き換えられるので、これだけでは守れない。手元のウィンドウが
	 * セッションの開始で固定した既定のブランチ（設計書 PR 3）と合わせて使う。
	 */
	private async checkHostDefaultBranch(session: ISession, dir: string, branch: string): Promise<void> {
		const head = await this.enqueueGit(session, () => this.execGit(paradisTaskBoardRemoteGitPlan(dir, { kind: 'defaultBranch' }).args, this.timeouts.gitShortMs));
		const hostDefault = head.code === 0 ? /^refs\/remotes\/origin\/(?<branch>.+)$/.exec(head.stdout.trim())?.groups?.branch : undefined;
		if (paradisTaskBoardRemoteIsProtectedBranch(branch, hostDefault)) {
			throw new ParadisTaskBoardRemoteError('denied', `push to the default branch is not allowed: ${branch}`);
		}
	}

	private async checkNewWorktreeDir(session: ISession, dir: string): Promise<void> {
		if (session.worktreeRoot === undefined) {
			throw new ParadisTaskBoardRemoteError('denied', 'this session has no worktree folder');
		}
		if (dirname(dir) !== session.worktreeRoot || !/^[A-Za-z0-9._-]{1,200}$/.test(basename(dir)) || basename(dir).startsWith('.')) {
			throw new ParadisTaskBoardRemoteError('denied', 'a new worktree must be a direct child of the worktree folder');
		}
		await this.checkOwnedDirectory(session.worktreeRoot);
		if (await fs.lstat(dir).then(() => true, () => false)) {
			throw new ParadisTaskBoardRemoteError('denied', `the worktree folder already exists: ${dir}`);
		}
	}

	private async enqueueGit<T>(session: ISession, task: () => Promise<T>): Promise<T> {
		if (session.queued >= PARADIS_TASK_BOARD_REMOTE_LIMITS.maxQueued) {
			throw new ParadisTaskBoardRemoteError('busy', 'too many git operations are waiting');
		}
		session.queued++;
		const run = session.gitQueue.then(async () => {
			session.queued--;
			if (session.closed) {
				throw new ParadisTaskBoardRemoteError('unknown-session', 'the task board session was closed');
			}
			return this.withSlot(session, task);
		}, () => undefined);
		session.gitQueue = run.catch(() => undefined);
		return run as Promise<T>;
	}

	private async withSlot<T>(session: ISession, task: () => Promise<T>): Promise<T> {
		if (session.inFlight >= PARADIS_TASK_BOARD_REMOTE_LIMITS.maxInFlight) {
			throw new ParadisTaskBoardRemoteError('busy', 'too many operations are running');
		}
		session.inFlight++;
		try {
			return await task();
		} finally {
			session.inFlight--;
		}
	}

	/** セッションを開く前の確認用。成功しなければ投げる。 */
	private async runGitUnqueued(dir: string, op: { readonly kind: 'toplevel' | 'commonDir' }): Promise<string> {
		const result = await this.execGit(paradisTaskBoardRemoteGitPlan(dir, op).args, this.timeouts.gitShortMs);
		if (result.code !== 0) {
			throw new ParadisTaskBoardRemoteError('denied', 'the folder is not a git repository');
		}
		return result.stdout;
	}

	private async execGit(args: readonly string[], timeoutMs: number): Promise<IParadisTaskBoardRemoteGitResult> {
		const env = paradisTaskBoardRemoteEnv(await this.baseEnv());
		const result = await this.spawnBounded('git', args, undefined, env, timeoutMs, undefined).promise;
		return {
			code: result.timedOut && result.code === 0 ? 1 : (result.code ?? 1),
			stdout: result.stdout,
			stderr: result.timedOut ? `${result.stderr}\nParadisTaskBoardRemote: timed out after ${timeoutMs / 1000}s` : result.stderr,
			timedOut: result.timedOut,
		};
	}

	// --- ファイル -----------------------------------------------------------------------------
	//
	// 読み書きは、作業場所の root を O_DIRECTORY | O_NOFOLLOW で開いた fd を起点に、1 段ずつ `/proc/self/fd/<fd>/<名前>`
	// で開き直して辿る（Linux の openat 相当。Node に openat が無いため）。各段は O_NOFOLLOW なので symlink なら ELOOP で
	// 止まり、確かめた後にパスの途中を symlink へすり替えられても、開いたフォルダ（inode）の外へは届かない。

	/**
	 * 作業場所の中のファイルを読む（成果物、フローの定義）。途中の段にも最後にも symlink があれば断る。ハードリンク
	 * （nlink が 2 以上）も断る（`.para/out.txt` を `~/.ssh/id_ed25519` へのハードリンクにすると、パスの検査を
	 * すべて通って中身を運べてしまうため）。無ければ undefined。
	 */
	async readFile(sessionId: unknown, place: unknown, relativePath: unknown, maxBytes: unknown): Promise<Uint8Array | undefined> {
		const session = this.session(sessionId);
		const dir = await this.place(session, place);
		const segments = paradisTaskBoardRemoteSegments(relativePath);
		const limit = typeof maxBytes === 'number' && Number.isInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, PARADIS_TASK_BOARD_REMOTE_LIMITS.maxReadBytes) : PARADIS_TASK_BOARD_REMOTE_LIMITS.maxReadBytes;
		return this.withDirectory(dir, segments.slice(0, -1), undefined, async parent => {
			if (parent === undefined) {
				return undefined;
			}
			const handle = await fs.open(parent.entry(segments[segments.length - 1]), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch(error => {
				if (isErrno(error, 'ENOENT')) {
					return undefined;
				}
				throw isErrno(error, 'ELOOP') ? new ParadisTaskBoardRemoteError('denied', `the file is a symbolic link: ${relativePath}`) : error;
			});
			if (handle === undefined) {
				return undefined;
			}
			try {
				const info = await handle.stat();
				if (!info.isFile()) {
					throw new ParadisTaskBoardRemoteError('denied', `the path is not a regular file: ${relativePath}`);
				}
				if (info.nlink !== 1) {
					throw new ParadisTaskBoardRemoteError('denied', `the file has other hard links: ${relativePath}`);
				}
				if (info.size > limit) {
					throw new ParadisTaskBoardRemoteError('denied', `the file is larger than ${limit} bytes: ${relativePath}`);
				}
				const buffer = Buffer.alloc(info.size);
				const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
				return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
			} finally {
				await handle.close();
			}
		});
	}

	/**
	 * 作業場所の中へ書く。書けるのはフローの定義の 3 ファイルと `.para/` の中だけ。足りない途中のフォルダは作り
	 * （`.para` は 0700）、既にある段が symlink なら断る。親のフォルダの fd を起点に、一時ファイルを O_EXCL で作ってから
	 * 同じフォルダの中で rename する。
	 */
	async writeFile(sessionId: unknown, place: unknown, relativePath: unknown, content: unknown): Promise<void> {
		const session = this.session(sessionId);
		const dir = await this.place(session, place);
		const segments = paradisTaskBoardRemoteSegments(relativePath);
		if (!paradisTaskBoardRemoteIsWritablePath(segments.join('/'))) {
			throw new ParadisTaskBoardRemoteError('denied', `the task board may not write this file: ${relativePath}`);
		}
		const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content instanceof Uint8Array ? Buffer.from(content) : undefined;
		if (bytes === undefined || bytes.length > PARADIS_TASK_BOARD_REMOTE_LIMITS.maxWriteBytes) {
			throw new ParadisTaskBoardRemoteError('invalid', 'content must be a string or bytes up to 1 MiB');
		}
		const name = segments[segments.length - 1];
		await this.withDirectory(dir, segments.slice(0, -1), segment => segment === PARADIS_TASK_BOARD_REMOTE_BOARD_DIR ? 0o700 : 0o755, async parent => {
			const target = parent!.entry(name);
			const existing = await fs.lstat(target).catch(() => undefined);
			if (existing && !existing.isFile()) {
				throw new ParadisTaskBoardRemoteError('denied', `the target is not a regular file: ${relativePath}`);
			}
			const temp = parent!.entry(`.${name}.${randomBytes(6).toString('hex')}.tmp`);
			const handle = await fs.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, existing ? existing.mode & 0o777 : 0o644);
			try {
				await handle.writeFile(bytes);
			} finally {
				await handle.close();
			}
			try {
				await this.afterCheck('write');
				await fs.rename(temp, target);
			} catch (error) {
				await fs.unlink(temp).catch(() => undefined);
				throw error;
			}
		});
	}

	/**
	 * `.para/` を次のタスクのために空にし、持ち主の印（`.para/.task`）を書く（workspaces.ts の resetBoardFiles と同じ意味）。
	 * 同じタスクの印があれば何もしない。`.para` が symlink やファイルなら断る（リンクの先を消さない）。中身は開いた
	 * `.para` の fd を起点に 1 件ずつ、symlink を辿らずに消す。リポジトリが `.para/` を追跡していれば触らない（false を返す）。
	 */
	async resetBoardDir(sessionId: unknown, place: unknown, taskId: unknown): Promise<boolean> {
		const session = this.session(sessionId);
		const dir = await this.place(session, place);
		const task = checkId(taskId, TASK_ID, 'task id');
		const tracked = await this.git(session.id, dir, { kind: 'boardDirTracked' });
		if (tracked.code !== 0 || tracked.stdout.trim().length > 0) {
			return false;
		}
		const owner = await this.readFile(session.id, dir, `${PARADIS_TASK_BOARD_REMOTE_BOARD_DIR}/.task`, 1024).catch(() => undefined);
		if (owner !== undefined && Buffer.from(owner).toString('utf8').trim() === task) {
			return true;
		}
		await this.withDirectory(dir, [PARADIS_TASK_BOARD_REMOTE_BOARD_DIR], undefined, async boardDir => {
			if (boardDir !== undefined) {
				await this.afterCheck('reset');
				await this.clearDirectory(boardDir, { remaining: CLEAR_MAX_ENTRIES }, 0);
			}
		});
		await this.writeFile(session.id, dir, `${PARADIS_TASK_BOARD_REMOTE_BOARD_DIR}/.task`, `${task}\n`);
		return true;
	}

	/**
	 * `.git/info/exclude` に `/.para/` を足す（無ければ）。場所はセッションのリポジトリの common dir の `info/exclude`
	 * に決め打ちし、common dir の fd を起点に開く。symlink とハードリンクには書かない。
	 */
	async excludeBoardDir(sessionId: unknown, place: unknown): Promise<void> {
		const session = this.session(sessionId);
		await this.place(session, place);
		await this.withDirectory(session.commonDir, ['info'], () => 0o755, async infoDir => {
			const handle = await fs.open(infoDir!.entry('exclude'), fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o644).catch(error => {
				throw isErrno(error, 'ELOOP') ? new ParadisTaskBoardRemoteError('denied', 'the exclude file is a symbolic link') : error;
			});
			try {
				const info = await handle.stat();
				if (!info.isFile() || info.nlink !== 1) {
					throw new ParadisTaskBoardRemoteError('denied', 'the exclude file is not a regular file with a single link');
				}
				const text = (await handle.readFile()).toString('utf8');
				if (text.split('\n').some(line => line.trim() === `/${PARADIS_TASK_BOARD_REMOTE_BOARD_DIR}/`)) {
					return;
				}
				await handle.write(`${text && !text.endsWith('\n') ? '\n' : ''}# Para Code task board\n/${PARADIS_TASK_BOARD_REMOTE_BOARD_DIR}/\n`);
			} finally {
				await handle.close();
			}
		});
	}

	/**
	 * root を開き、`segments` のフォルダを 1 段ずつ fd で辿って `task` に渡す。`create` があれば無い段を作り、
	 * 無ければ足りない段で undefined を渡す。symlink・ファイルの段は断る。開いた fd は最後にすべて閉じる。
	 */
	private async withDirectory<T>(root: string, segments: readonly string[], create: ((segment: string) => number) | undefined, task: (dir: ParadisDirectoryHandle | undefined) => Promise<T>): Promise<T> {
		const opened: ParadisDirectoryHandle[] = [];
		try {
			let current: ParadisDirectoryHandle | undefined = await ParadisDirectoryHandle.openRoot(root, this.uid!);
			opened.push(current);
			for (const segment of segments) {
				current = await current.child(segment, create?.(segment));
				if (current === undefined) {
					break;
				}
				opened.push(current);
			}
			return await task(current);
		} finally {
			for (const handle of opened.reverse()) {
				await handle.close();
			}
		}
	}

	/** 開いたフォルダの中身を 1 件ずつ消す。中のフォルダは O_NOFOLLOW で開き直して潜る（symlink はリンクそのものを消す）。 */
	private async clearDirectory(dir: ParadisDirectoryHandle, budget: { remaining: number }, depth: number): Promise<void> {
		if (depth > CLEAR_MAX_DEPTH) {
			throw new ParadisTaskBoardRemoteError('denied', 'the board folder is nested too deeply');
		}
		for (const name of await fs.readdir(dir.self)) {
			if (--budget.remaining < 0) {
				throw new ParadisTaskBoardRemoteError('denied', 'the board folder has too many files');
			}
			const info = await fs.lstat(dir.entry(name));
			if (info.isDirectory()) {
				const child = await dir.child(name, undefined);
				if (child !== undefined) {
					try {
						await this.clearDirectory(child, budget, depth + 1);
					} finally {
						await child.close();
					}
				}
				await fs.rmdir(dir.entry(name));
			} else {
				await fs.unlink(dir.entry(name));
			}
		}
	}

	// --- 工程のコマンド ---------------------------------------------------------------------

	/**
	 * 作業場所で工程のコマンドを `/bin/sh -c` で走らせ、出力を {@link onOutput} へ流す。本文が承認済みかは手元の
	 * ウィンドウが確かめてから送ってくる（ここでは形と上限だけ）。同時に 2 本まで、60 分で止める。
	 */
	async runCommand(sessionId: unknown, place: unknown, runId: unknown, command: unknown): Promise<IParadisTaskBoardRemoteRunResult> {
		const session = this.session(sessionId);
		const dir = await this.place(session, place);
		const id = checkId(runId, RUN_ID, 'run id');
		const commandError = paradisTaskBoardRemoteCommandError(command);
		if (commandError !== undefined) {
			throw new ParadisTaskBoardRemoteError('invalid', commandError);
		}
		if (session.runs.has(id)) {
			throw new ParadisTaskBoardRemoteError('invalid', 'the run id is already used');
		}
		if (session.runs.size >= PARADIS_TASK_BOARD_REMOTE_LIMITS.maxConcurrentCommands) {
			throw new ParadisTaskBoardRemoteError('busy', `at most ${PARADIS_TASK_BOARD_REMOTE_LIMITS.maxConcurrentCommands} commands can run at the same time`);
		}
		const env = paradisTaskBoardRemoteEnv(await this.baseEnv());
		if (session.closed) {
			throw new ParadisTaskBoardRemoteError('unknown-session', 'the task board session was closed');
		}
		if (session.runs.size >= PARADIS_TASK_BOARD_REMOTE_LIMITS.maxConcurrentCommands || session.inFlight >= PARADIS_TASK_BOARD_REMOTE_LIMITS.maxInFlight) {
			throw new ParadisTaskBoardRemoteError('busy', 'too many operations are running');
		}
		const output = new ParadisTaskBoardRemoteOutputBuffer(lines => this._onOutput.fire({ sessionId: session.id, runId: id, lines }));
		const running = this.spawnBounded('/bin/sh', ['-c', command as string], dir, env, this.timeouts.commandMs, chunk => output.push(chunk));
		session.runs.set(id, { runId: id, cancel: running.cancel });
		session.inFlight++;
		try {
			const result = await running.promise;
			output.finish(result.timedOut ? `● ${Math.round(this.timeouts.commandMs / 60_000)} 分を超えたので止めました` : undefined);
			return { code: result.code, signal: result.signal, cancelled: result.cancelled, timedOut: result.timedOut, stdout: result.stdout };
		} finally {
			output.dispose();
			session.inFlight--;
			session.runs.delete(id);
		}
	}

	cancelRun(sessionId: unknown, runId: unknown): boolean {
		const run = this.session(sessionId).runs.get(checkId(runId, RUN_ID, 'run id'));
		run?.cancel();
		return run !== undefined;
	}

	/**
	 * プロセスを新しいプロセスグループの先頭として起こし、出力を上限まで集める。時間切れと cancel では
	 * グループごと SIGTERM → 猶予の後 SIGKILL。終わった後、孫が出力をつかんだままでも closeGrace で切り上げる。
	 */
	private spawnBounded(file: string, args: readonly string[], cwd: string | undefined, env: Record<string, string>, timeoutMs: number, onData: ((chunk: string) => void) | undefined):
		{ readonly promise: Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }>; cancel(): void } {
		const maxKept = onData ? PARADIS_TASK_BOARD_REMOTE_LIMITS.maxKeptStdoutChars : PARADIS_TASK_BOARD_REMOTE_LIMITS.maxGitOutputChars;
		let child: cp.ChildProcess | undefined;
		let stopping = false;
		let timedOut = false;
		let cancelled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const signal = (sig: NodeJS.Signals) => {
			const pid = child?.pid;
			try {
				if (pid !== undefined) {
					process.kill(-pid, sig);
				}
			} catch {
				// 既に終わっている
			}
		};
		// グループがまだあるか。グループの番号を使っているプロセスが残っている間は、その番号は別のプロセスに振られない
		const groupAlive = () => {
			const pid = child?.pid;
			if (pid === undefined) {
				return false;
			}
			try {
				process.kill(-pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const stop = () => {
			if (stopping) {
				return;
			}
			stopping = true;
			signal('SIGTERM');
			killTimer = setTimeout(() => {
				if (groupAlive()) {
					signal('SIGKILL');
				}
			}, this.timeouts.killGraceMs);
		};
		const promise = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }>(resolve => {
			let stdout = '';
			let stderr = '';
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined = undefined;
			const done = (code: number | null, sig: string | null) => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timer);
				// 猶予の SIGKILL は、時間切れ・cancel の後に残った孫を止めるため、終わってからも撃つ
				// グループが消えていれば撃たない（番号が別のプロセスへ振り直されうるため）
				if (killTimer !== undefined) {
					if (groupAlive()) {
						unref(killTimer);
					} else {
						clearTimeout(killTimer);
						killTimer = undefined;
					}
				}
				resolve({ code, signal: sig, stdout, stderr, timedOut, cancelled });
			};
			try {
				child = this.spawn(file, [...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
			} catch (error) {
				stderr = String((error as Error).message);
				done(127, null);
				return;
			}
			timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, timeoutMs);
			child.stdout?.setEncoding('utf8');
			child.stderr?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				stdout = appendCapped(stdout, chunk, maxKept);
				onData?.(chunk);
			});
			child.stderr?.on('data', (chunk: string) => {
				if (!onData) {
					stderr = appendCapped(stderr, chunk, maxKept);
				}
				onData?.(chunk);
			});
			child.on('error', error => {
				stderr = appendCapped(stderr, error.message, maxKept);
				done(127, null);
			});
			child.on('close', (code, sig) => done(code, sig));
			child.on('exit', (code, sig) => unref(setTimeout(() => done(code, sig), this.timeouts.closeGraceMs)));
		});
		return {
			promise,
			cancel: () => {
				cancelled = true;
				stop();
			},
		};
	}
}

/**
 * 工程のコマンドの出力を行に分け、250 ms ごとにまとめて流す。1 回に 200 行まで（古い方を省く）、
 * 合計 16 MiB を超えたら以後は捨てて省略と出す。`\r` で書き直す進捗は最後の内容だけを残す（runner.ts と同じ）。
 */
export class ParadisTaskBoardRemoteOutputBuffer {
	private pending = '';
	private lines: string[] = [];
	private total = 0;
	private overflowed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly emit: (lines: readonly string[]) => void) { }

	push(chunk: string): void {
		if (this.overflowed) {
			return;
		}
		this.total += chunk.length;
		if (this.total > PARADIS_TASK_BOARD_REMOTE_LIMITS.maxOutputChars) {
			this.overflowed = true;
			this.split(this.pending + '\n');
			this.pending = '';
			this.lines.push('…（出力が多すぎるので、ここから先は省きました）');
			this.flush();
			return;
		}
		this.split(this.pending + chunk);
		this.timer ??= setTimeout(() => this.flush(), PARADIS_TASK_BOARD_REMOTE_LIMITS.outputFlushMs);
	}

	finish(note: string | undefined): void {
		if (!this.overflowed && this.pending.length > 0) {
			this.split(this.pending + '\n');
		}
		this.pending = '';
		if (note !== undefined) {
			this.lines.push(note);
		}
		this.flush();
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private split(text: string): void {
		const parts = text.split('\n');
		this.pending = parts.pop() ?? '';
		if (this.pending.length > PARADIS_TASK_BOARD_REMOTE_LIMITS.outputMaxPendingChars) {
			parts.push(this.pending);
			this.pending = '';
		}
		for (const line of parts) {
			this.lines.push(line.replace(/\r$/, '').split('\r').pop() ?? '');
		}
	}

	private flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.lines.length === 0) {
			return;
		}
		const max = PARADIS_TASK_BOARD_REMOTE_LIMITS.outputLinesPerFlush;
		const lines = this.lines.length > max ? [`…（${this.lines.length - max} 行を省略）`, ...this.lines.slice(-max)] : this.lines;
		this.lines = [];
		this.emit(lines);
	}
}

/**
 * REH のチャネル。引数は信用せず、サービスの各メソッドが形を確かめる。
 */
export class ParadisTaskBoardRemoteChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisTaskBoardRemoteService) { }

	listen<T>(_ctx: TContext, event: string, arg?: unknown): Event<T> {
		if (event === 'onOutput') {
			// 出力はセッションを開いた側だけが購読する（セッションの ID を知っている相手）
			const sessionId = typeof arg === 'string' ? arg : undefined;
			return Event.filter(this.service.onOutput, output => output.sessionId === sessionId) as unknown as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'openSession': return this.service.openSession(args[0], args[1], args[2]) as Promise<T>;
			case 'closeSession': return this.service.closeSession(args[0]) as T;
			case 'heartbeat': return this.service.heartbeat(args[0]) as T;
			case 'registerPlace': return this.service.registerPlace(args[0], args[1]) as Promise<T>;
			case 'git': return this.service.git(args[0], args[1], args[2]) as Promise<T>;
			case 'readFile': return this.service.readFile(args[0], args[1], args[2], args[3]) as Promise<T>;
			case 'writeFile': return this.service.writeFile(args[0], args[1], args[2], args[3]) as Promise<T>;
			case 'resetBoardDir': return this.service.resetBoardDir(args[0], args[1], args[2]) as Promise<T>;
			case 'excludeBoardDir': return this.service.excludeBoardDir(args[0], args[1]) as Promise<T>;
			case 'runCommand': return this.service.runCommand(args[0], args[1], args[2], args[3]) as Promise<T>;
			case 'cancelRun': return this.service.cancelRun(args[0], args[1]) as T;
		}
		throw new Error(`Call not found: ${command}`);
	}
}
