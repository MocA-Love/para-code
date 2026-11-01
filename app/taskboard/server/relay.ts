// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as path from 'node:path';
import type { ITaskBoardSlot, ITaskBoardStep, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { paradisTaskBoardHasHiddenCharacters } from '@engine/paradisTaskBoardDisplayText.js';
import { TaskBoardWorkspaceError, type ITaskBoardRunPort, type ITaskBoardWorkspacePort, type TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';
import type { GitHubClient } from './github.js';
import { ParaCodeBridgeError, type ParaCodeBridgeClient, type ParaCodeRelayEvent } from './paraCode.js';
import { githubReason, prRef } from './runner.js';

/*
 * SSH の窓のボード（q.html Q472 = A）。リポジトリは SSH の接続先にあり、git・ファイルの読み書きは Para Code の
 * 接続口の `/v1/relay` を通して、SSH の窓 → REH で行う（窓と REH が操作の種類・作業場所・パスを確かめる）。
 *
 * まだ出さないもの（SSH では断る）: 工程のコマンドとドラフト PR（run 工程）、コミットと push、clone の作業場所、
 * リポジトリの切り替え、Codex・Claude の「常に許可」。
 *
 * 中継の応答（git の出力・ファイルの中身）は console に出さない。ボードの出力は Para Code のログへ転送されるため。
 */

/** `sessionInfo` の答え（窓が決めたもの。ボードは自分で計算しない）。 */
export interface IRelaySessionInfo {
	readonly root: string;
	readonly worktreeRoot: string;
	readonly defaultBranch: string | undefined;
	readonly originFetch: string | undefined;
	readonly originPush: string | undefined;
	readonly worktrees: readonly string[];
}

export interface IRelayGitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

type Rev = { readonly kind: 'head' } | { readonly kind: 'local' | 'remote'; readonly branch: string };

/** SSH ではまだ使えない機能の、画面とエージェントに見せる文。 */
export const RELAY_UNSUPPORTED = 'SSH の接続先のリポジトリでは、まだ使えません';

/** 中継の口。`request` は ParaCodeBridgeClient.request（テストでは差し替える）。 */
export class RelayClient {
	constructor(
		private sessionId: string,
		private readonly request: <T>(method: 'POST', route: string, body: unknown, timeoutMs?: number) => Promise<T>,
	) { }

	/** SSH の窓を再読み込みすると、窓のセッションが新しくなる（Para Code が ipc で知らせる）。 */
	setSession(sessionId: string): void {
		this.sessionId = sessionId;
	}

	static of(client: ParaCodeBridgeClient, sessionId: string): RelayClient {
		return new RelayClient(sessionId, (method, route, body, timeoutMs) => client.request(method, route, body, timeoutMs));
	}

	private async call<T>(op: Record<string, unknown>, timeoutMs = 200_000): Promise<T> {
		const response = await this.request<{ ok: true; value: T }>('POST', '/v1/relay', { sessionId: this.sessionId, op }, timeoutMs);
		return response.value;
	}

	/**
	 * 起動の直後は、SSH の窓が鍵を接続口へ登録し、セッションに結ぶまで 403・404 が返る。それを「まだ」として
	 * `budgetMs` の間やり直す。
	 */
	async waitForSession(budgetMs = 60_000, sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<IRelaySessionInfo> {
		const deadline = Date.now() + budgetMs;
		for (let delay = 200; ; delay = Math.min(delay * 2, 2000)) {
			try {
				return await this.call<IRelaySessionInfo>({ kind: 'sessionInfo' }, 15_000);
			} catch (err) {
				const status = err instanceof ParaCodeBridgeError ? err.status : 0;
				if (![0, 403, 404].includes(status) || Date.now() + delay > deadline) {
					throw err;
				}
				await sleep(delay);
			}
		}
	}

	git(place: string, op: Record<string, unknown>): Promise<IRelayGitResult> {
		return this.call<IRelayGitResult>({ kind: 'git', place, git: op });
	}

	/** git を走らせ、失敗なら投げる（workspaces.ts の git() と同じ使い方）。 */
	async gitOk(place: string, op: Record<string, unknown>): Promise<string> {
		const result = await this.git(place, op);
		if (result.code !== 0) {
			// stderr は git の失敗の理由だけを短く載せる（中身のファイルは含まない）
			throw new Error(`git ${String(op.kind)}: ${(result.stderr || `exit ${result.code}`).trim().split('\n').slice(-3).join(' ')}`);
		}
		return result.stdout.trim();
	}

	/** `.para/` の中とフローの定義だけを読める。無ければ undefined。 */
	async readFile(place: string, relativePath: string, maxBytes?: number): Promise<Buffer | undefined> {
		const value = await this.call<{ base64?: string; missing?: boolean }>({ kind: 'readFile', place, path: relativePath, ...(maxBytes !== undefined ? { maxBytes } : {}) });
		return value.base64 !== undefined ? Buffer.from(value.base64, 'base64') : undefined;
	}

	/** フローの定義（共通・個人）だけを書ける。 */
	async writeFlowFile(relativePath: string, content: string): Promise<void> {
		await this.call({ kind: 'writeFile', path: relativePath, content });
	}

	async resetBoardDir(place: string, taskId: string): Promise<boolean> {
		return (await this.call<{ reset: boolean }>({ kind: 'resetBoardDir', place, taskId })).reset;
	}

	async excludeBoardDir(place: string): Promise<void> {
		await this.call({ kind: 'excludeBoardDir', place });
	}

	/** 工程のコマンドを頼む（SSH の窓が確かめてから走らせる）。終わりは relay-exit のイベントで届く。 */
	async runCommand(place: string, runId: string, command: string, step: { flowId: string; flowName: string; stepId: string; stepName: string; source: 'team' | 'personal' | 'default' }): Promise<void> {
		await this.call({ kind: 'runCommand', place, runId, command, step });
	}

	/**
	 * ボードのブランチを push する（SSH の窓が、送るコミット・ファイル・リモートを見せて確かめてから送る）。終わりは relay-exit で届く。
	 * `interactive` が false なら窓は確認を出さず、確認が要れば送らない（返却のとき）。
	 */
	async pushBranch(place: string, runId: string, branch: string, setUpstream: boolean, interactive: boolean): Promise<void> {
		await this.call({ kind: 'pushBranch', place, runId, branch, setUpstream, interactive });
	}

	async cancelRun(runId: string): Promise<void> {
		await this.call({ kind: 'cancelRun', runId });
	}
}

/** フローの定義の読み書きの口（flows.ts）。中継では共通・個人のファイルだけで、旧 `.paracode.json` は読むだけ。 */
export function relayFlowIo(relay: RelayClient, root: string): { read(relativePath: string): Promise<string | undefined>; write(relativePath: string, text: string): Promise<void> } {
	return {
		read: async relativePath => (await relay.readFile(root, relativePath, 1024 * 1024))?.toString('utf8'),
		write: (relativePath, text) => relay.writeFlowFile(relativePath, text),
	};
}

/**
 * SSH の接続先のワークツリーを作業場所にする（workspaces.ts の GitWorkspaces のワークツリーの部分と同じ手順）。
 * clone の作業場所は使わない。返却のときの push はしない（push は窓の確認が入る後の PR で出す）。
 */
export class RemoteWorkspaces implements ITaskBoardWorkspacePort {
	private stopped = false;
	private repoQueue: Promise<unknown> = Promise.resolve();
	/** 窓の作業場所にあるワークツリー（起動時に窓が引き取ったものと、このボードが作ったもの）。 */
	private readonly known: Set<string>;

	constructor(
		private readonly relay: RelayClient,
		private readonly info: IRelaySessionInfo,
		/** 返す前に、PR のブランチへ送る（承認済みのブランチだけ。確認は出さない）。 */
		private readonly pushBeforeRelease?: (place: string, branch: string) => Promise<void>,
	) {
		this.known = new Set(info.worktrees);
	}

	stop(): void {
		this.stopped = true;
	}

	/** ワークツリーの場所はブランチ名から決める（GitWorkspaces.worktreeDir と同じ形。接続先は POSIX）。 */
	worktreeDir(branch: string): string {
		return path.posix.join(this.info.worktreeRoot, branch.replace(/^para\//, '').replace(/[^A-Za-z0-9._-]+/g, '-'));
	}

	private inRepoQueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.repoQueue.then(() => {
			if (this.stopped) {
				throw new TaskBoardWorkspaceError('the task board has stopped');
			}
			return work();
		});
		this.repoQueue = run.catch(() => undefined);
		return run;
	}

	private exists(rev: Rev): Promise<boolean> {
		return this.relay.git(this.info.root, { kind: 'refExists', rev }).then(result => result.code === 0, () => false);
	}

	private base(): Rev {
		return { kind: 'remote', branch: this.info.defaultBranch ?? 'main' };
	}

	prepare(task: ITaskBoardTask, slot: ITaskBoardSlot, branch: string): Promise<{ branch: string; path: string }> {
		if (slot.kind !== 'worktree') {
			return Promise.reject(new TaskBoardWorkspaceError(RELAY_UNSUPPORTED));
		}
		return this.inRepoQueue(async () => {
			const dir = this.worktreeDir(branch);
			await this.relay.gitOk(this.info.root, { kind: 'fetch', prune: true });
			const list = await this.relay.gitOk(this.info.root, { kind: 'worktreeList' }).catch(() => '');
			const existing = list.split('\n\n').find(block => block.match(/^worktree (.+)$/m)?.[1] === dir);
			if (existing !== undefined) {
				// 前回の作業場所が残っていれば、同じブランチのワークツリーである限り使い直す（窓が作った・引き取ったものだけ使える）
				if (!existing.includes(`branch refs/heads/${branch}`)) {
					throw new TaskBoardWorkspaceError(`${dir} already exists and is not the worktree of ${branch}`);
				}
				// 窓の記録に無いワークツリー（別の PC や、記録を消した後の Para Code が作ったもの）は、窓が作業場所として
				// 認めないので使えない。黙って使い直すと、その後の操作と担当の起動がすべて断られる
				if (!this.known.has(dir)) {
					throw new TaskBoardWorkspaceError(`${dir} は、この Para Code が作った記録の無いワークツリーです。接続先で外してから、やり直してください`);
				}
				return { branch, path: dir };
			}
			const mode = await this.exists({ kind: 'local', branch }) ? 'existing' : await this.exists({ kind: 'remote', branch }) ? 'track' : 'new';
			await this.relay.gitOk(this.info.root, { kind: 'worktreeAdd', dir, branch, mode, ...(mode === 'new' ? { base: this.base() } : {}) });
			this.known.add(dir);
			await this.relay.excludeBoardDir(dir);
			await this.relay.resetBoardDir(dir, task.id).catch(() => undefined);
			return { branch, path: dir };
		});
	}

	async release(task: ITaskBoardTask, slot: ITaskBoardSlot): Promise<void> {
		if (slot.kind !== 'worktree') {
			return;
		}
		const dir = slot.path || (task.branch ? this.worktreeDir(task.branch) : '');
		if (!dir || dir === this.info.root) {
			return;
		}
		// PR ができた後の工程で担当がコミットしたものは、返す前に PR のブランチへ送る（GitWorkspaces と同じ）。返却では確認を
		// 出さないので、窓が承認済みのブランチだけが送られ、ほかは送らずに残る
		if (task.pr && task.branch && this.pushBeforeRelease) {
			await this.pushBeforeRelease(dir, task.branch).catch(() => undefined);
		}
		// 消すのはボードが作ったワークツリーだけ（窓と REH も確かめる）。未コミットの変更があれば残す（--force は使わない）
		const status = await this.relay.git(dir, { kind: 'status' }).catch(() => undefined);
		if (!status || status.code !== 0 || status.stdout.trim().length > 0) {
			return;
		}
		await this.inRepoQueue(() => this.relay.gitOk(this.info.root, { kind: 'worktreeRemove', dir }));
		this.known.delete(dir);
	}
}

/**
 * SSH のボードの run 工程。工程のコマンドは、SSH の窓が確かめて（初めてと中身が変わったとき）、接続先で走らせる。出力は
 * 順に届き、終わりはイベントで届く（環境変数は接続先で組み立てる。このボードの env は送らない）。ドラフト PR はまだ出さない。
 */
export class RemoteCommandRunner implements ITaskBoardRunPort {
	private readonly runs = new Map<string, { readonly taskId: string; readonly attempt: number }>();
	private readonly byTask = new Map<string, string>();
	/** push の終わりを待っている呼び出し（runId → 受け取り）。 */
	private readonly waiters = new Map<string, (event: Extract<ParaCodeRelayEvent, { type: 'relay-exit' }>) => void>();
	private seq = 0;

	constructor(
		private readonly engine: () => TaskBoardEngine,
		private readonly relay: RelayClient,
		private readonly placePath: (task: ITaskBoardTask) => string | undefined,
		/** PR を作る口と、PR を作るリポジトリ（起動時に固定した origin。G0）。 */
		private readonly github?: Pick<GitHubClient, 'findOpenPullRequest' | 'createDraftPullRequest'>,
		private readonly repo?: { readonly owner: string; readonly repo: string },
		private readonly defaultBranch?: string,
	) { }

	/**
	 * ブランチを push し、終わりを待つ。成功なら送ったコミットの件数と SHA、失敗なら理由（画面に出す文）。返却のとき
	 * （interactive が false）は、窓が承認済みのブランチだけを送る。
	 */
	async push(place: string, branch: string, setUpstream: boolean, interactive: boolean, taskId: string): Promise<{ readonly error?: string; readonly sent?: string }> {
		const runId = `push-${taskId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${++this.seq}`;
		const done = new Promise<Extract<ParaCodeRelayEvent, { type: 'relay-exit' }>>(resolve => this.waiters.set(runId, resolve));
		try {
			await this.relay.pushBranch(place, runId, branch, setUpstream, interactive);
		} catch (err) {
			this.waiters.delete(runId);
			return { error: `push を頼めませんでした: ${(err as Error).message}` };
		}
		const event = await done;
		if (event.code === 0 && !event.reason) {
			// 承認済みのブランチは後から足したコミットも確かめずに送るので、何を送ったかを必ず見せる
			return { sent: `${event.pushedCommits ?? 0} 件のコミットを送りました（${(event.pushedSha ?? '').slice(0, 12)}）` };
		}
		return { error: pushFailureText(event.reason) };
	}

	run(task: ITaskBoardTask, step: ITaskBoardStep): void {
		const engine = this.engine();
		const attempt = task.attempt;
		if (step.run === 'draft-pr') {
			void this.draftPr(task).catch((err: Error) => {
				const current = engine.getTask(task.id);
				if (current?.attempt === attempt) {
					engine.reportRunResult(task.id, attempt, { ok: false, detail: err.message });
				}
			});
			return;
		}
		const place = this.placePath(task);
		const command = step.command?.trim();
		if (!place || !command) {
			engine.reportRunResult(task.id, attempt, { ok: false, detail: !place ? '作業場所のディレクトリが分かりません' : 'コマンドが設定されていません' });
			return;
		}
		// 確認のダイアログで正しく見せられない文字（向きを変える文字・幅の無い文字・改行以外の制御文字）を含む本文は
		// 頼まない（SSH の窓と接続先でも断る）
		if (paradisTaskBoardHasHiddenCharacters(command)) {
			engine.reportRunResult(task.id, attempt, { ok: false, detail: 'コマンドに表示できない文字を含むため実行しません（フローの定義を確かめてください）' });
			return;
		}
		this.cancel(task);
		const runId = `${task.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${attempt}-${++this.seq}`;
		this.runs.set(runId, { taskId: task.id, attempt });
		this.byTask.set(task.id, runId);
		const flow = engine.flowOf(task);
		engine.reportOutput(task.id, [`${place} $ ${command}`, '  （SSH の窓で確かめてから、接続先で実行します）']);
		void this.relay.runCommand(place, runId, command, {
			flowId: flow.id, flowName: flow.name, stepId: step.id, stepName: step.name,
			source: flow.scope === 'team' ? 'team' : flow.scope === 'personal' ? 'personal' : 'default',
		}).catch((err: Error) => this.finish(runId, { ok: false, detail: `実行を頼めませんでした: ${err.message}` }));
	}

	cancel(task: ITaskBoardTask): void {
		const runId = this.byTask.get(task.id);
		if (runId !== undefined) {
			this.byTask.delete(task.id);
			this.runs.delete(runId);
			this.engine().reportOutput(task.id, ['^C　コマンドを止めました']);
			void this.relay.cancelRun(runId).catch(() => undefined);
		}
	}

	dispose(): void {
		for (const runId of [...this.runs.keys()]) {
			void this.relay.cancelRun(runId).catch(() => undefined);
		}
		this.runs.clear();
		this.byTask.clear();
	}

	/**
	 * ドラフト PR の工程（runner.ts の draftPr と同じ手順を、中継で行う）。未追跡のファイルがあれば止め、タスクのブランチに
	 * いることを確かめ、手元だけが進んでいれば SSH の窓の確認の後に push し、手元の GitHub の API で PR を作る。PR の本文は
	 * 固定の文と Issue の番号だけで、成果物もターミナルの出力も添えない。
	 */
	private async draftPr(task: ITaskBoardTask): Promise<void> {
		const engine = this.engine();
		const attempt = task.attempt;
		const fail = (detail: string) => engine.reportRunResult(task.id, attempt, { ok: false, detail });
		const alive = () => {
			const current = engine.getTask(task.id);
			return current?.attempt === attempt && current.status === 'working';
		};
		const place = this.placePath(task);
		const repo = this.repo;
		const github = this.github;
		const branch = task.branch ?? (place ? await this.relay.gitOk(place, { kind: 'currentBranch' }).then(b => b === 'HEAD' ? undefined : b, () => undefined) : undefined);
		if (!repo || !branch || !github || !place) {
			fail(!repo ? 'PR を作るリポジトリ（origin）が分かりません' : !branch ? 'ブランチがありません' : !github ? 'GitHub につないでいないので PR を作れません' : '作業場所が分かりません');
			return;
		}
		let found: Awaited<ReturnType<GitHubClient['findOpenPullRequest']>>;
		try {
			found = await github.findOpenPullRequest(repo.owner, repo.repo, branch);
		} catch (err) {
			if (alive()) {
				fail(`PR を探せませんでした: ${githubReason(err)}`);
			}
			return;
		}
		if (!alive()) {
			return;
		}
		await this.relay.excludeBoardDir(place).catch(() => undefined);
		const porcelain = (await this.relay.gitOk(place, { kind: 'status' }).catch(() => '')).split('\n').filter(Boolean);
		const changed = porcelain.map(l => l.replace(/^[ MTADRCU?!]{1,2} /, '').trim()).filter(Boolean);
		const newFiles = porcelain.filter(l => l.startsWith('??')).map(l => l.slice(2).trim());
		const current = await this.relay.gitOk(place, { kind: 'currentBranch' }).catch(() => '');
		if (current !== branch) {
			fail(`作業場所が ${current || '（ブランチ無し）'} にいます。タスクのブランチ ${branch} に戻してからやり直してください`);
			return;
		}
		if (changed.length && engine.flowOf(task).workspace.commit === 'board' && newFiles.length === 0) {
			const message = task.issue ? `${task.title} (#${task.issue.number})` : task.title;
			try {
				await this.relay.gitOk(place, { kind: 'addTracked' });
				await this.relay.gitOk(place, { kind: 'commit', message });
			} catch {
				fail('git commit が失敗しました');
				return;
			}
			engine.reportOutput(task.id, changed.map(f => `  コミットしました: ${f}`));
		} else if (changed.length) {
			engine.reportRunResult(task.id, attempt, { ok: false, detail: `作業場所に未コミットの変更が ${changed.length} 件あります。コミットするか決めてください`, uncommitted: changed, untracked: newFiles });
			return;
		}
		const base = this.defaultBranch ?? 'main';
		const count = async (baseRev: Record<string, unknown>, headRev: Record<string, unknown>) => Number(await this.relay.gitOk(place, { kind: 'aheadCount', base: baseRev, head: headRev }).catch(() => '0'));
		const ahead = await count({ kind: 'remote', branch: base }, { kind: 'head' });
		if (!ahead && !found) {
			fail(`origin/${base} より先のコミットがありません`);
			return;
		}
		await this.relay.gitOk(place, { kind: 'fetch', prune: true }).catch(() => undefined);
		const remote = (await this.relay.git(place, { kind: 'refExists', rev: { kind: 'remote', branch } }).catch(() => undefined))?.code === 0;
		const localAhead = remote ? await count({ kind: 'remote', branch }, { kind: 'head' }) : ahead;
		const remoteAhead = remote ? await count({ kind: 'head' }, { kind: 'remote', branch }) : 0;
		if (localAhead > 0 && remoteAhead > 0) {
			fail(`リモートの ${branch} に、手元に無いコミットが ${remoteAhead} 件あります。取り込んでからやり直してください`);
			return;
		}
		if (localAhead > 0) {
			engine.reportOutput(task.id, [`${place} $ git push origin ${branch}`, '  （SSH の窓で、送るコミットとファイルを確かめてから送ります）']);
			const pushed = await this.push(place, branch, true, true, task.id);
			if (!alive()) {
				return;
			}
			if (pushed.error !== undefined) {
				fail(pushed.error);
				return;
			}
			engine.reportOutput(task.id, [`  ${pushed.sent}`]);
		}
		if (found) {
			engine.reportRunResult(task.id, attempt, { ok: true, detail: `#${found.number}（既存）`, pr: prRef(repo, found.number, found.url, found.title, found.draft) });
			return;
		}
		const issue = task.issue;
		const closes = issue ? (issue.owner === repo.owner && issue.repo === repo.repo ? `Closes #${issue.number}` : `Closes ${issue.owner}/${issue.repo}#${issue.number}`) : '';
		const body = [closes, 'タスクボードが作ったドラフト PR です。'].filter(Boolean).join('\n\n');
		let created: Awaited<ReturnType<GitHubClient['createDraftPullRequest']>>;
		try {
			created = await github.createDraftPullRequest(repo.owner, repo.repo, branch, task.title, body);
		} catch (err) {
			if (alive()) {
				fail(`PR を作れませんでした: ${githubReason(err)}`);
			}
			return;
		}
		if (!alive()) {
			return;
		}
		engine.reportOutput(task.id, [`  ${created.existed ? '既存の PR を使います' : 'ドラフト PR を作りました'}: ${created.url}`]);
		engine.reportRunResult(task.id, attempt, { ok: true, detail: created.existed ? `#${created.number}（既存）` : `#${created.number}`, pr: prRef(repo, created.number, created.url, created.title, created.draft) });
	}

	/** 接続口から届いた、このボードの工程のコマンドの出力と終わり。 */
	onEvent(event: ParaCodeRelayEvent): void {
		if (event.type === 'relay-exit') {
			const waiter = this.waiters.get(event.runId);
			if (waiter) {
				this.waiters.delete(event.runId);
				waiter(event);
				return;
			}
		}
		const run = this.runs.get(event.runId);
		if (!run) {
			return;
		}
		if (event.type === 'relay-output') {
			const lines = event.lines.map(line => `  ${line}`);
			this.engine().reportOutput(run.taskId, lines.length > 200 ? [`  …（${lines.length - 200} 行を省略）`, ...lines.slice(-200)] : lines);
			return;
		}
		const detail = event.reason === 'not-approved' ? 'SSH の窓で「実行しない」を選んだか、確認に答えが無いまま 10 分たちました'
			: event.reason === 'confirm-pending' ? 'SSH の窓で確認を待っている別のコマンドがあります。そちらに答えてからやり直してください'
			: event.reason?.includes('cannot be displayed') ? 'コマンドに表示できない文字を含むため実行しません'
			: event.reason === 'disconnected' ? 'SSH の窓との接続が切れたので止めました'
				: event.reason ? `実行できませんでした: ${event.reason}`
					: event.timedOut ? '60 分を超えたので止めました'
						: event.cancelled ? '止めました（SSH の窓が閉じた・接続が切れたときも止まります）'
							: event.code === 0 ? '終了コード 0' : `終了コード ${event.code ?? event.signal}`;
		this.finish(event.runId, { ok: event.code === 0 && !event.reason && !event.cancelled && !event.timedOut, detail });
	}

	private finish(runId: string, result: { readonly ok: boolean; readonly detail: string }): void {
		const run = this.runs.get(runId);
		if (!run) {
			return;
		}
		this.runs.delete(runId);
		if (this.byTask.get(run.taskId) === runId) {
			this.byTask.delete(run.taskId);
		}
		this.engine().reportRunResult(run.taskId, run.attempt, result);
	}
}

/** push を送らなかった・失敗した理由を、画面の文にする。 */
function pushFailureText(reason: string | undefined): string {
	switch (reason) {
		case 'not-approved': return 'SSH の窓で push を「送らない」にしたか、確認に答えが無いまま 10 分たちました';
		case 'needs-confirmation': return 'このブランチの push はまだ確かめていないので、返却のときには送りませんでした';
		case 'confirm-pending': return 'SSH の窓で確認を待っている別の依頼があります。そちらに答えてからやり直してください';
		case 'push-url-changed': return 'push の送り先（origin）が、ボードを開いたときから変わったか、1 つではありません。送りませんでした';
		case 'push-mirror': return 'origin に mirror の設定があり、すべての参照を送ってしまうので送りませんでした';
		case 'board-files-in-commits': return '送るコミットに .para/ の中のファイルが入っています。コミットから外してからやり直してください';
		case 'hidden-characters': return '送るコミットの件名・ファイル名・送り先に、表示できない文字があります。送りませんでした';
		case 'disconnected': return 'SSH の窓との接続が切れたので送りませんでした';
		default: return `push が失敗しました${reason ? `: ${reason}` : ''}`;
	}
}
