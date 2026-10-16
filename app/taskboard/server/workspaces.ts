// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { execFile } from 'node:child_process';
import { existsSync, promises as fs, realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { ITaskBoardSlot, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { TaskBoardWorkspaceError, type ITaskBoardWorkspacePort } from '@engine/paradisTaskBoardEngine.js';

/*
 * 作業場所の git 操作（`--real-workspaces` のときだけ使う）。
 * 未コミットの変更がある作業場所は絶対に触らない（貸し出しを断る・返却時は残す）。
 * 消す操作は、ボードが作ったワークツリーを `git worktree remove`（--force なし）で外すことだけ。
 */

export function git(cwd: string, args: readonly string[], timeout = 60000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', ['-C', cwd, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`git ${args.join(' ')}: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
				return;
			}
			resolve(stdout.trim());
		});
	});
}

export async function remoteUrl(repoPath: string): Promise<string | undefined> {
	return git(repoPath, ['remote', 'get-url', 'origin'], 5000).catch(() => undefined);
}

export async function defaultBase(cwd: string): Promise<string> {
	const head = await git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '');
	return head ? head.replace('refs/remotes/', '') : 'origin/main';
}

async function isDirty(cwd: string): Promise<boolean> {
	// 貸し出し中の作業場所でも走るので、index.lock を取らない（エージェントの git 操作とぶつからないように）
	return (await git(cwd, ['--no-optional-locks', 'status', '--porcelain'])).length > 0;
}

/**
 * エージェントが計画などを書く `.para/` を git の除外に入れる（コミットに混ざらず、返した作業場所が
 * 未コミット扱いにならないように）。除外の設定は手元だけで、リポジトリの .gitignore は変えない。
 */
export async function excludeBoardFiles(cwd: string): Promise<void> {
	const file = path.resolve(cwd, await git(cwd, ['rev-parse', '--git-path', 'info/exclude']));
	const text = await fs.readFile(file, 'utf8').catch(() => '');
	if (text.split('\n').some(l => l.trim() === '/.para/' || l.trim() === '.para/')) {
		return;
	}
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}# Para Code task board\n/.para/\n`);
}

/** 今のブランチがタスクのブランチで、PR のブランチ（origin）より先のコミットがあれば push する。 */
async function pushIfAhead(cwd: string, branch: string): Promise<void> {
	const current = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
	if (current !== branch) {
		console.warn(`[taskboard] ${cwd} is on ${current}, not ${branch}; commits made there are not pushed before release`);
		return;
	}
	// マージ後にリモートのブランチが消えていれば、作り直さない
	await git(cwd, ['fetch', '--quiet', '--prune', 'origin']).catch(() => undefined);
	if (!(await remoteBranchExists(cwd, branch))) {
		return;
	}
	if (Number(await git(cwd, ['rev-list', '--count', `origin/${branch}..HEAD`])) > 0) {
		await git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
	}
}

/**
 * 前のタスクの計画やモックを、次のタスクのエージェントが読まないように `.para/` を空にする。同じタスクが借り直したとき
 * （差し戻しなど）は自分の分を残す。持ち主は `.para/.task` に書く。リポジトリが `.para/` を git で追跡していれば触らない。
 */
async function resetBoardFiles(cwd: string, taskId: string): Promise<void> {
	if (await git(cwd, ['ls-files', '--', '.para']).catch(() => '')) {
		return;
	}
	const dir = path.join(cwd, '.para');
	const marker = path.join(dir, '.task');
	if (await fs.readFile(marker, 'utf8').then(owner => owner.trim() === taskId, () => false)) {
		return;
	}
	await fs.rm(dir, { recursive: true, force: true });
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(marker, `${taskId}\n`);
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
	return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
}

/** 設定のクローンを、貸し出せる作業場所の一覧にする（dirty / missing を調べる）。 */
export async function inspectClones(paths: readonly string[]): Promise<ITaskBoardSlot[]> {
	return Promise.all(paths.map(async p => {
		const abs = path.resolve(p);
		const name = path.basename(abs);
		if (!existsSync(path.join(abs, '.git'))) {
			return { id: `clone:${abs}`, name, path: abs, kind: 'clone-pool' as const, missing: true };
		}
		const dirty = await isDirty(abs).catch(() => true);
		return { id: `clone:${abs}`, name, path: abs, kind: 'clone-pool' as const, dirty };
	}));
}

async function remoteBranchExists(cwd: string, branch: string): Promise<boolean> {
	return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then(() => true, () => false);
}

/** ブランチへ切り替える。手元に無ければリモートの同名ブランチを追い、それも無ければ既定のブランチから作る。 */
async function switchTo(cwd: string, branch: string): Promise<void> {
	if (await branchExists(cwd, branch)) {
		await git(cwd, ['switch', branch]);
		if (await remoteBranchExists(cwd, branch)) {
			// 別の作業場所で進めてリモートへ上げた分を取り込む（進められないときは手元のまま）
			await git(cwd, ['merge', '--ff-only', `origin/${branch}`]).catch(() => undefined);
		}
		return;
	}
	if (await remoteBranchExists(cwd, branch)) {
		await git(cwd, ['switch', '--track', '-c', branch, `origin/${branch}`]);
		return;
	}
	await git(cwd, ['switch', '--no-track', '-c', branch, await defaultBase(cwd)]);
}

export class GitWorkspaces implements ITaskBoardWorkspacePort {
	/** 止めた後（別のリポジトリで開き直した後など）は、作業場所に触らない。 */
	private stopped = false;
	private readonly inFlight = new Set<Promise<unknown>>();

	constructor(private readonly repoPath: string, private readonly worktreeRoot: string) { }

	/** 以後の準備と返却を断り、進行中のものが終わるのを待つ（最大 waitMs）。 */
	async stop(waitMs = 30000): Promise<void> {
		this.stopped = true;
		await Promise.race([Promise.allSettled([...this.inFlight]), new Promise(resolve => setTimeout(resolve, waitMs))]);
	}

	private track<T>(work: () => Promise<T>): Promise<T> {
		if (this.stopped) {
			return Promise.reject(new TaskBoardWorkspaceError('the task board has stopped'));
		}
		const p = work();
		this.inFlight.add(p);
		void p.finally(() => this.inFlight.delete(p)).catch(() => undefined);
		return p;
	}

	/** ワークツリーの場所はブランチ名から決める（返却や再起動の後も同じ場所を求められるように）。 */
	worktreeDir(branch: string): string {
		return path.join(this.worktreeRoot, branch.replace(/^para\//, '').replace(/[^A-Za-z0-9._-]+/g, '-'));
	}

	private async isWorktreeOf(dir: string, branch: string): Promise<boolean> {
		const list = await git(this.repoPath, ['worktree', 'list', '--porcelain']).catch(() => '');
		const dirs = new Set([dir, existsSync(dir) ? realpathSync(dir) : dir]);
		return list.split('\n\n').some(b => {
			const at = b.match(/^worktree (.+)$/m)?.[1];
			return at !== undefined && (dirs.has(at) || (existsSync(at) && dirs.has(realpathSync(at)))) && b.includes(`branch refs/heads/${branch}`);
		});
	}

	prepare(task: ITaskBoardTask, slot: ITaskBoardSlot, branch: string): Promise<{ branch: string; path: string }> {
		return this.track(() => this.prepareNow(task.id, slot, branch));
	}

	release(task: ITaskBoardTask, slot: ITaskBoardSlot): Promise<void> {
		return this.track(() => this.releaseNow(task, slot));
	}

	private async prepareNow(taskId: string, slot: ITaskBoardSlot, branch: string): Promise<{ branch: string; path: string }> {
		if (slot.kind === 'worktree') {
			const dir = this.worktreeDir(branch);
			await git(this.repoPath, ['fetch', '--quiet', 'origin']);
			if (existsSync(dir)) {
				// 前回の作業場所が残っていれば、同じブランチのワークツリーである限り使い直す
				if (await this.isWorktreeOf(dir, branch)) {
					return { branch, path: dir };
				}
				throw new TaskBoardWorkspaceError(`${dir} already exists and is not the worktree of ${branch}`);
			}
			if (await branchExists(this.repoPath, branch)) {
				await git(this.repoPath, ['worktree', 'add', dir, branch]);
			} else if (await remoteBranchExists(this.repoPath, branch)) {
				await git(this.repoPath, ['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`]);
			} else {
				await git(this.repoPath, ['worktree', 'add', '--no-track', '-b', branch, dir, await defaultBase(this.repoPath)]);
			}
			await excludeBoardFiles(dir);
			return { branch, path: dir };
		}
		if (!existsSync(path.join(slot.path, '.git'))) {
			throw new TaskBoardWorkspaceError(`${slot.name} is not a git checkout`, 'missing');
		}
		await excludeBoardFiles(slot.path);
		await resetBoardFiles(slot.path, taskId);
		if (await isDirty(slot.path)) {
			throw new TaskBoardWorkspaceError(`${slot.name} has uncommitted changes`, 'dirty');
		}
		await git(slot.path, ['fetch', '--quiet', 'origin']);
		await switchTo(slot.path, branch);
		return { branch, path: slot.path };
	}

	private async releaseNow(task: ITaskBoardTask, slot: ITaskBoardSlot): Promise<void> {
		// PR ができた後の工程でエージェントがコミットしたものは、返す前に PR のブランチへ送る（送らないと手元にだけ残る）
		const place = slot.kind === 'worktree' ? slot.path || (task.branch ? this.worktreeDir(task.branch) : '') : slot.path;
		if (task.pr && task.branch && place && existsSync(place)) {
			await pushIfAhead(place, task.branch).catch(err => console.warn('[taskboard] push before release failed:', (err as Error).message));
		}
		if (slot.kind === 'worktree') {
			const dir = slot.path || (task.branch ? this.worktreeDir(task.branch) : '');
			// 消すのはボードが作ったワークツリーだけ。未コミットの変更があれば残す（--force は使わない）
			if (dir && existsSync(dir) && task.branch && await this.isWorktreeOf(dir, task.branch) && !(await isDirty(dir))) {
				await git(this.repoPath, ['worktree', 'remove', dir]);
			}
			return;
		}
		if (existsSync(path.join(slot.path, '.git')) && !(await isDirty(slot.path))) {
			// ブランチは残し、作業場所だけ既定のブランチの先頭へ戻す
			await git(slot.path, ['switch', '--detach', await defaultBase(slot.path)]);
		}
	}
}
