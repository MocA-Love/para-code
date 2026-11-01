// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as path from 'node:path';
import type { ITaskBoardSlot, ITaskBoardStep, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { paradisTaskBoardHasHiddenCharacters } from '@engine/paradisTaskBoardDisplayText.js';
import { TaskBoardWorkspaceError, type ITaskBoardRunPort, type ITaskBoardWorkspacePort, type TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';
import { ParaCodeBridgeError, type ParaCodeBridgeClient, type ParaCodeRelayEvent } from './paraCode.js';

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

	constructor(private readonly relay: RelayClient, private readonly info: IRelaySessionInfo) {
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
	private seq = 0;

	constructor(
		private readonly engine: () => TaskBoardEngine,
		private readonly relay: RelayClient,
		private readonly placePath: (task: ITaskBoardTask) => string | undefined,
	) { }

	run(task: ITaskBoardTask, step: ITaskBoardStep): void {
		const engine = this.engine();
		const attempt = task.attempt;
		if (step.run === 'draft-pr') {
			engine.reportRunResult(task.id, attempt, { ok: false, detail: `${RELAY_UNSUPPORTED}（ドラフト PR と push）` });
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

	/** 接続口から届いた、このボードの工程のコマンドの出力と終わり。 */
	onEvent(event: ParaCodeRelayEvent): void {
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
