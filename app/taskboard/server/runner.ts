// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { spawn, type ChildProcess } from 'node:child_process';
import { commandPath } from './executables.js';
import type { ITaskBoardPrRef, ITaskBoardStep, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import type { ITaskBoardRunPort, TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';
import { defaultBase, excludeBoardFiles, git } from './workspaces.js';

/*
 * 自動（run）工程を実際に走らせる（`--agents para-code` のとき）。
 *
 * - command: 作業場所で `sh -c <command>`（Windows は cmd /c）。終了コード 0 で完了。出力はターミナル欄へ流す
 * - draft-pr: ブランチを push し、`gh pr create --draft` で PR を作る。同じブランチの PR が既にあれば、それを使う
 *
 * やり直し・差し戻しで cancel が来たら、プロセスのグループごと止める。
 */

const MAX_RUN_MS = 60 * 60 * 1000;
const FLUSH_MS = 250;
/** SIGTERM で止まらないときに SIGKILL へ上げるまでの時間。 */
const KILL_GRACE_MS = 5000;
/** プロセスが終わった後、出力を持ったまま裏に残った子を待たずに切り上げるまでの時間。 */
const CLOSE_GRACE_MS = 2000;
/** 改行が来ないまま溜まった出力を、1 行として流す長さ。 */
const MAX_PENDING = 16 * 1024;

export interface ICommandRunnerOptions {
	readonly engine: () => TaskBoardEngine;
	/** 作業場所のディレクトリ。作業場所を持たない工程（draft-pr）では、元のリポジトリを使う。 */
	readonly placePath: (task: ITaskBoardTask) => string | undefined;
	readonly repoPath: string;
	/** PR を作るリポジトリ（origin）。 */
	readonly repo: { readonly owner: string; readonly repo: string } | undefined;
	/** テスト用に gh / git の場所を差し替える。 */
	readonly env?: NodeJS.ProcessEnv;
}

interface IRunning {
	readonly attempt: number;
	readonly child: ChildProcess;
	cancelled: boolean;
	/** SIGKILL へ上げるタイマー。出力の口がすべて閉じた（グループの子も残っていない）ら取り消す。 */
	killTimer?: NodeJS.Timeout;
}

export class CommandRunner implements ITaskBoardRunPort {
	private readonly running = new Map<string, IRunning>();
	/** 止めた後（開き直した後）は、コマンドを走らせない。 */
	private disposed = false;

	constructor(private readonly options: ICommandRunnerOptions) { }

	private get engine(): TaskBoardEngine {
		return this.options.engine();
	}

	dispose(): void {
		this.disposed = true;
		for (const [taskId] of this.running) {
			this.kill(taskId);
		}
	}

	run(task: ITaskBoardTask, step: ITaskBoardStep): void {
		if (this.disposed) {
			return;
		}
		this.kill(task.id);
		if (step.run === 'draft-pr') {
			void this.draftPr(task);
			return;
		}
		const cwd = this.options.placePath(task);
		if (!cwd) {
			this.engine.reportRunResult(task.id, task.attempt, { ok: false, detail: '作業場所のディレクトリが分かりません' });
			return;
		}
		const command = step.command?.trim();
		if (!command) {
			this.engine.reportRunResult(task.id, task.attempt, { ok: false, detail: 'コマンドが設定されていません' });
			return;
		}
		// エンジンが渡すタスクは後から書き換わるので、試行番号は始めた時点のものを使う
		const attempt = task.attempt;
		void this.exec(task, cwd, command, true).then(result => {
			this.engine.reportRunResult(task.id, attempt, result.code === 0
				? { ok: true, detail: '終了コード 0' }
				: { ok: false, detail: result.cancelled ? '止めました' : `終了コード ${result.code ?? result.signal}` });
		});
	}

	cancel(task: ITaskBoardTask): void {
		if (this.kill(task.id)) {
			this.engine.reportOutput(task.id, ['^C　コマンドを止めました']);
		}
	}

	private kill(taskId: string): boolean {
		const running = this.running.get(taskId);
		if (!running) {
			return false;
		}
		running.cancelled = true;
		this.running.delete(taskId);
		const pid = running.child.pid;
		const signal = (sig: NodeJS.Signals) => {
			try {
				if (pid && process.platform !== 'win32') {
					process.kill(-pid, sig);
				} else {
					running.child.kill(sig);
				}
			} catch {
				// 既に終わっている
			}
		};
		signal('SIGTERM');
		running.killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
		running.killTimer.unref();
		return true;
	}

	/** コマンドを走らせ、出力をターミナル欄へ流す。`shell` が false なら argv をそのまま渡す。 */
	private exec(task: ITaskBoardTask, cwd: string, command: string | readonly string[], shell: boolean): Promise<{ code: number | null; signal: string | null; cancelled: boolean; stdout: string }> {
		const engine = this.engine;
		const display = typeof command === 'string' ? command : command.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ');
		if (this.disposed) {
			return Promise.resolve({ code: null, signal: null, cancelled: true, stdout: '' });
		}
		engine.reportOutput(task.id, [`${cwd} $ ${display}`]);
		// Windows では作業フォルダ（リポジトリ）の git.exe や cmd.exe を拾わないよう、PATH から引いた絶対パスで起動する
		const [file, args] = shell
			? (process.platform === 'win32' ? [commandPath('cmd.exe'), ['/d', '/s', '/c', command as string]] : ['/bin/sh', ['-c', command as string]])
			: [commandPath((command as readonly string[])[0]), (command as readonly string[]).slice(1)];
		return new Promise(resolve => {
			const child = spawn(file, args as string[], {
				cwd,
				// NoDefaultCurrentDirectoryInExePath: Windows の cmd.exe と CreateProcess が、コマンドを作業フォルダから先に探さないように
				env: { ...process.env, ...this.options.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', CI: process.env.CI ?? '1', NoDefaultCurrentDirectoryInExePath: '1' },
				detached: process.platform !== 'win32',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const record: IRunning = { attempt: task.attempt, child, cancelled: false };
			this.running.set(task.id, record);
			let stdout = '';
			let pending = '';
			let flushTimer: NodeJS.Timeout | undefined;
			const flush = () => {
				flushTimer = undefined;
				const lines = pending.split('\n');
				pending = lines.pop() ?? '';
				if (pending.length > MAX_PENDING) {
					lines.push(pending);
					pending = '';
				}
				if (lines.length) {
					// `\r` で書き直す進捗表示は、最後に書かれた内容だけを残す。多すぎる行は省いたことを示す
					const shown = lines.map(l => `  ${l.replace(/\r$/, '').split('\r').pop() ?? ''}`);
					engine.reportOutput(task.id, shown.length > 200 ? [`  …（${shown.length - 200} 行を省略）`, ...shown.slice(-200)] : shown);
				}
			};
			const onData = (text: string, isStdout: boolean) => {
				if (isStdout && stdout.length < 1024 * 1024) {
					stdout += text;
				}
				pending += text;
				flushTimer ??= setTimeout(flush, FLUSH_MS);
			};
			child.stdout?.setEncoding('utf8');
			child.stderr?.setEncoding('utf8');
			child.stdout?.on('data', (c: string) => onData(c, true));
			child.stderr?.on('data', (c: string) => onData(c, false));
			const timeout = setTimeout(() => {
				engine.reportOutput(task.id, ['● 60 分を超えたので止めました']);
				this.kill(task.id);
			}, MAX_RUN_MS);
			let finished = false;
			const done = (code: number | null, signal: string | null) => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timeout);
				clearTimeout(flushTimer);
				pending += '\n';
				flush();
				if (this.running.get(task.id) === record) {
					this.running.delete(task.id);
				}
				resolve({ code, signal, cancelled: record.cancelled, stdout });
			};
			child.on('error', err => {
				engine.reportOutput(task.id, [`  ${err.message}`]);
				done(127, null);
			});
			child.on('close', (code, signal) => {
				clearTimeout(record.killTimer);
				done(code, signal);
			});
			// 裏に残った子が出力をつかんだままだと close が来ないので、終了から少し待って切り上げる
			child.on('exit', (code, signal) => setTimeout(() => done(code, signal), CLOSE_GRACE_MS).unref());
		});
	}

	private async draftPr(task: ITaskBoardTask): Promise<void> {
		const engine = this.engine;
		const attempt = task.attempt;
		const repo = this.options.repo;
		const place = this.options.placePath(task);
		// 作業場所を持ったまま来たのにブランチを覚えていない（手で取り込んだタスクなど）ときは、作業場所の今のブランチを使う
		const branch = task.branch ?? (place ? await git(place, ['rev-parse', '--abbrev-ref', 'HEAD']).then(b => b === 'HEAD' ? undefined : b, () => undefined) : undefined);
		const fail = (detail: string) => engine.reportRunResult(task.id, attempt, { ok: false, detail });
		// 段と段の合間に止められた（中止・差し戻し・やり直し）なら、次の段へ進まない
		const alive = () => {
			const current = engine.getTask(task.id);
			return current?.attempt === attempt && current.status === 'working';
		};
		if (!repo || !branch) {
			fail(!repo ? 'PR を作るリポジトリ（origin）が分かりません' : 'ブランチがありません');
			return;
		}
		const cwd = place ?? this.options.repoPath;
		const slug = `${repo.owner}/${repo.repo}`;
		if (!alive()) {
			return;
		}
		const existing = await this.exec(task, cwd, ['gh', 'pr', 'list', '--repo', slug, '--head', branch, '--state', 'open', '--json', 'number,url,title,isDraft', '--limit', '1'], false);
		if (existing.cancelled || !alive()) {
			return;
		}
		const found = parseJson<{ number: number; url: string; title: string; isDraft: boolean }[]>(existing.stdout)?.[0];
		// PR がすでにあっても、作業場所の変更（差し戻しでの手直しなど）をコミットして送ってから、その PR を使う
		if (place) {
			// 未コミットの変更があれば、push する前に止めて人に決めてもらう（コミットはカードのボタンから）
			await excludeBoardFiles(place).catch(() => undefined);
			const porcelain = (await git(place, ['--no-optional-locks', 'status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean);
			const changed = porcelain.map(l => l.replace(/^[ MTADRCU?!]{1,2} /, '').trim()).filter(Boolean);
			const newFiles = porcelain.filter(l => l.startsWith('??')).map(l => l.slice(2).trim());
			// エージェントが参考に別のブランチへ切り替えたままなら、その履歴をタスクのブランチとして出さない
			const current = await git(place, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
			if (current !== branch) {
				fail(`作業場所が ${current || '（ブランチ無し）'} にいます。タスクのブランチ ${branch} に戻してからやり直してください`);
				return;
			}
			// 追跡していないファイル（.env や試作の残り）は勝手にコミットしない。ボードに任せるフローでも、それがあれば人に聞く
			const untracked = newFiles.length > 0;
			if (changed.length && engine.flowOf(task).workspace.commit === 'board' && !untracked) {
				// ボードに任せるフロー: 追跡しているファイルの変更だけをまとめてコミットしてから進める
				const message = task.issue ? `${task.title} (#${task.issue.number})` : task.title;
				const add = await this.exec(task, cwd, ['git', 'add', '-u'], false);
				const commit = add.code === 0 && !add.cancelled && alive() ? await this.exec(task, cwd, ['git', 'commit', '--quiet', '-m', message], false) : add;
				if (commit.cancelled || !alive()) {
					return;
				}
				if (commit.code !== 0) {
					fail('git commit が失敗しました');
					return;
				}
				engine.reportOutput(task.id, changed.map(f => `  コミットしました: ${f}`));
			} else if (changed.length) {
				engine.reportRunResult(task.id, attempt, { ok: false, detail: `作業場所に未コミットの変更が ${changed.length} 件あります。コミットするか決めてください`, uncommitted: changed, untracked: newFiles });
				return;
			}
			const base = await defaultBase(place).catch(() => 'origin/main');
			const ahead = Number(await git(place, ['rev-list', '--count', `${base}..HEAD`]).catch(() => '0'));
			if (!ahead && !found) {
				fail(`${base} より先のコミットがありません`);
				return;
			}
			await git(place, ['fetch', '--quiet', '--prune', 'origin']).catch(() => undefined);
			// リモートのブランチと比べて、手元に新しいコミットがあるときだけ送る。リモートだけが進んでいる（GitHub の
			// Update branch など）なら送らずに使い、両方が進んでいれば取り込みを頼んで止まる
			const remote = await git(place, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then(() => true, () => false);
			const count = (range: string) => git(place, ['rev-list', '--count', range]).then(Number, () => 0);
			const localAhead = remote ? await count(`origin/${branch}..HEAD`) : ahead;
			const remoteAhead = remote ? await count(`HEAD..origin/${branch}`) : 0;
			if (localAhead > 0 && remoteAhead > 0) {
				fail(`リモートの ${branch} に、手元に無いコミットが ${remoteAhead} 件あります。取り込んでからやり直してください`);
				return;
			}
			if (localAhead > 0) {
				const push = await this.exec(task, cwd, ['git', 'push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], false);
				if (push.cancelled || !alive()) {
					return;
				}
				if (push.code !== 0) {
					fail('git push が失敗しました');
					return;
				}
			}
		}
		if (found) {
			engine.reportRunResult(task.id, attempt, { ok: true, detail: `#${found.number}（既存）`, pr: prRef(repo, found.number, found.url, found.title, found.isDraft) });
			return;
		}
		const title = task.title;
		const issue = task.issue;
		const closes = issue ? (issue.owner === repo.owner && issue.repo === repo.repo ? `Closes #${issue.number}` : `Closes ${issue.owner}/${issue.repo}#${issue.number}`) : '';
		const body = [closes, 'タスクボードが作ったドラフト PR です。'].filter(Boolean).join('\n\n');
		const created = await this.exec(task, cwd, ['gh', 'pr', 'create', '--repo', slug, '--head', branch, '--draft', `--title=${title}`, `--body=${body}`], false);
		if (created.cancelled || !alive()) {
			return;
		}
		const url = created.stdout.match(/https:\/\/\S+\/pull\/(?<n>\d+)/);
		if (created.code !== 0 || !url?.groups) {
			fail('gh pr create が失敗しました');
			return;
		}
		const number = Number(url.groups.n);
		engine.reportRunResult(task.id, attempt, { ok: true, detail: `#${number}`, pr: prRef(repo, number, url[0], title, true) });
	}
}

function prRef(repo: { owner: string; repo: string }, number: number, url: string, title: string, draft: boolean): ITaskBoardPrRef {
	return { owner: repo.owner, repo: repo.repo, number, url, title, state: draft ? 'draft' : 'open', checks: 'pending', review: 'none' };
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}
