/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * タスクボードの SSH 中継の、SSH の窓の側（設計書 G3・G4・G6・G9）。許すかどうかを決める場所。
 *
 *  - セッションは、この窓が自分の接続先（remoteAuthority）の、自分に登録されたリポジトリに対してだけ作る。
 *    リポジトリとワークツリーの置き場はボードの依頼からではなく、窓が自分で決める
 *  - ボードから来た依頼は、許す欄だけを取り出して組み直してから REH へ送る（paradisParseTaskBoardRelayRequest）。
 *    作業場所（place）は、セッションの root と、この窓が作った（または前に作って引き取った）ワークツリーだけ
 *  - 作ったワークツリーと、作ったときに origin に無かった `para/…` のブランチは、手元に記録する（鍵はリポジトリの
 *    uri.toString()）。Para Code を開き直した後も、返却（ワークツリーを外す）と、後の PR の push の確認に使う
 *  - 30 秒ごとに REH へ心拍を送る（REH は 120 秒途絶えたら閉じて、実行中のコマンドを止める）
 */

import { IntervalTimer } from '../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { posix } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ParadisTaskBoardErrorCode, ParadisTaskBoardRelayEvent, ParadisTaskBoardResult, paradisTaskBoardFail } from './paradisTaskBoardBridge.js';
import { IParadisTaskBoardRelayCommandStep, IParadisTaskBoardRelaySessionInfo, PARADIS_TASK_BOARD_RELAY_HEARTBEAT_MS, paradisParseTaskBoardRelayRequest, paradisTaskBoardIsBoardKey } from './paradisTaskBoardRelay.js';
import { paradisTaskBoardHasHiddenCharacters } from './paradisTaskBoardDisplayText.js';
import { paradisTaskBoardRemoteStripUrlCredentials } from './paradisTaskBoardRemote.js';
import { PARADIS_TASK_BOARD_LAUNCH_APPROVAL_TOOLS, paradisTaskBoardLaunchApprovalFlags } from './paradisTaskBoardToolApprovals.js';

export interface IParadisTaskBoardRelayWorktree {
	readonly dir: string;
	readonly branch: string;
}

/** 承認した工程のコマンド。 */
export interface IParadisTaskBoardRelayApproval {
	readonly hash: string;
	readonly command: string;
}

/** 確認のダイアログに出すもの。 */
export interface IParadisTaskBoardRelayCommandConfirmation {
	readonly authority: string;
	readonly repository: string;
	readonly place: string;
	readonly command: string;
	readonly step: IParadisTaskBoardRelayCommandStep;
	/** 前に承認した本文（中身が変わったとき）。 */
	readonly previous: string | undefined;
	/** 本文の SHA-256（先頭を表示に添える）。 */
	readonly hash: string;
}

/** 確認に答えが無いまま、この時間が過ぎたら「実行しない」にする。 */
export const PARADIS_TASK_BOARD_RELAY_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/** 手元に残す、リポジトリごとの記録。 */
export interface IParadisTaskBoardRelayRecord {
	/** この窓（Para Code）が作ったワークツリーと、そのブランチ。 */
	readonly worktrees: readonly IParadisTaskBoardRelayWorktree[];
	/** 作ったときに origin に無かった、ボードのブランチ（`para/…`）。 */
	readonly branches: readonly string[];
	/** push を確かめて「覚える」にしたブランチ（Q525 の c = B: ブランチごとに初回だけ確かめる）。 */
	readonly pushApproved?: readonly string[];
}

/** push の確認に出すもの。 */
export interface IParadisTaskBoardRelayPushConfirmation {
	readonly authority: string;
	readonly repository: string;
	readonly place: string;
	readonly branch: string;
	/** 送るコミット（完全な SHA）。 */
	readonly sha: string;
	readonly pushUrl: string;
	/** PR を作るリポジトリ（fetch の URL）。push の URL と違えば、ダイアログで分かるように出す。 */
	readonly fetchUrl: string | undefined;
	readonly commits: readonly string[];
	/** 件名を出し切れなかったコミットがあるか（200 件より多い）。 */
	readonly moreCommits: boolean;
	readonly files: readonly string[];
	/** 秘密らしい名前のファイル（`.env`、鍵の形）。ダイアログで目立たせる。 */
	readonly suspicious: readonly string[];
	/** 「覚える」を出してよいか（ボードが作ったと記録したブランチだけ）。 */
	readonly canRemember: boolean;
}

/** 担当を起動するときだけ許可を渡すかの確認に出すもの。 */
export interface IParadisTaskBoardRelayLaunchToolsConfirmation {
	readonly authority: string;
	readonly repository: string;
	readonly agent: 'claude' | 'codex';
	readonly tools: readonly string[];
}

/** 秘密らしいファイルの名前（承認済みのブランチでも、これが足されたら聞き直す）。 */
const SUSPICIOUS_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials\.json|kubeconfig|service-account[^/]*\.json|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|keystore|jks|tfstate))$/i;
/** 見本として置く `.env` の雛形（秘密を含まない決まりの名前）は外す。 */
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template)$/i;

/** 秘密らしい名前か（網羅的ではない。ダイアログでもそう伝える）。 */
export function paradisTaskBoardRelayIsSuspiciousFile(file: string): boolean {
	return SUSPICIOUS_FILE.test(file) && !ENV_TEMPLATE.test(file);
}

/** 窓のサービスを包んだもの（テストでは差し替える）。 */
export interface IParadisTaskBoardRelaySessionsHost {
	/** この窓の接続先。手元の窓では undefined（セッションを作らない）。 */
	readonly remoteAuthority: string | undefined;
	/** REH の `paradisTaskBoardRemote` チャネル。接続が無ければ undefined。 */
	remoteChannel(): IChannel | undefined;
	/** shared process の接続口のチャネル（セッションの登録先）。 */
	readonly bridge: IChannel;
	/** この窓に登録されたリポジトリ・スペースか。 */
	isWindowFolder(uri: URI): boolean;
	newSessionId(): string;
	readRecord(repository: string): IParadisTaskBoardRelayRecord;
	writeRecord(repository: string, record: IParadisTaskBoardRelayRecord): void;
	/** 工程のコマンドの承認（リポジトリ・フロー・工程ごとに、承認した本文と hash）。 */
	readApproval(key: string): IParadisTaskBoardRelayApproval | undefined;
	writeApproval(key: string, approval: IParadisTaskBoardRelayApproval): void;
	/** 初めての、または本文が変わった工程のコマンドを、この窓のダイアログで確かめる。 */
	confirmCommand(request: IParadisTaskBoardRelayCommandConfirmation): Promise<'once' | 'remember' | 'deny'>;
	/** push を、この窓のダイアログで確かめる（コマンドと同じ見せ方）。 */
	confirmPush(request: IParadisTaskBoardRelayPushConfirmation): Promise<'once' | 'remember' | 'deny'>;
	/** 担当を起動するときだけ許可を渡すかを確かめる（リポジトリごとに 1 回。起動の待ちより短く打ち切る）。 */
	confirmLaunchTools(request: IParadisTaskBoardRelayLaunchToolsConfirmation): Promise<'remember' | 'deny'>;
	sha256(text: string): Promise<string>;
	warn(message: string, error?: unknown): void;
}

interface IRelaySession {
	readonly sessionId: string;
	readonly repository: URI;
	/** REH が返した、リポジトリの一番上（realpath 済み）。 */
	readonly root: string;
	readonly worktreeRoot: string;
	/** 作業場所として使ってよい root（セッションの root と、作った・引き取ったワークツリー）。 */
	readonly places: Set<string>;
	/** ボードの鍵を結んだか（結ぶまでは依頼を受けない）。 */
	bound: boolean;
	/** 走っている（確認待ちを含む）工程のコマンド。 */
	readonly runs: Set<string>;
	/** 確認のダイアログを出している最中か（セッションごとに 1 件まで。コマンドと push で共有）。 */
	confirming: boolean;
	/** セッションを開いたときの origin の URL（認証情報を外したもの）と既定のブランチ。push のたびに照らす（G0）。 */
	pinnedPush: string | undefined;
	pinnedFetch: string | undefined;
	defaultBranch: string | undefined;
}

/** 記録に残すワークツリー・ブランチの数（古いものから落とす）。 */
const MAX_RECORDED = 200;

/** REH の `[code] message` を、接続口の結果の code に直す。 */
function relayFailure(error: unknown): { readonly ok: false; readonly code: ParadisTaskBoardErrorCode; readonly message: string } {
	const message = error instanceof Error ? error.message : String(error);
	const code = /^\[(?<code>[a-z-]+)\]/.exec(message)?.groups?.code;
	if (/Unknown channel/i.test(message)) {
		return paradisTaskBoardFail('unavailable', 'The SSH host runs an older Para Code server without the task board relay.');
	}
	switch (code) {
		case 'denied': return paradisTaskBoardFail('rejected', message);
		case 'invalid': return paradisTaskBoardFail('invalid', message);
		case 'busy': return paradisTaskBoardFail('busy', message);
		case 'unknown-session': return paradisTaskBoardFail('not-found', message);
		case 'unsupported': return paradisTaskBoardFail('unavailable', message);
		default: return paradisTaskBoardFail('failed', message);
	}
}

/** ワークツリーの置き場。ボードの値は使わず、リポジトリの隣の `<名前>-worktrees` に決める（ボードの既定と同じ形）。 */
export function paradisTaskBoardRelayWorktreeRoot(root: string): string {
	return posix.join(posix.dirname(root), `${posix.basename(root)}-worktrees`);
}

export class ParadisTaskBoardRelaySessions extends Disposable {

	private readonly sessions = new Map<string, IRelaySession>();
	private readonly heartbeats = this._register(new DisposableMap<string, IDisposable>());

	constructor(private readonly host: IParadisTaskBoardRelaySessionsHost) {
		super();
	}

	override dispose(): void {
		for (const sessionId of [...this.sessions.keys()]) {
			void this.close(sessionId);
		}
		super.dispose();
	}

	/**
	 * この窓のリポジトリ（`vscode-remote`、authority がこの窓の接続先）に中継のセッションを開く。ボードの鍵を結ぶまで
	 * （{@link bind}）は、ボードからの依頼を受けない。前に作ったと記録しているワークツリーは、ここで引き取る。
	 */
	async prepare(repository: URI): Promise<ParadisTaskBoardResult<{ readonly sessionId: string; readonly root: string }>> {
		const authority = this.host.remoteAuthority;
		if (authority === undefined || repository.scheme !== Schemas.vscodeRemote || repository.authority !== authority) {
			return paradisTaskBoardFail('invalid', 'The repository is not on the SSH host of this window.');
		}
		if (!this.host.isWindowFolder(repository)) {
			return paradisTaskBoardFail('invalid', 'The repository is not registered in this window.');
		}
		const channel = this.host.remoteChannel();
		if (!channel) {
			return paradisTaskBoardFail('unavailable', 'This window is not connected to the SSH host.');
		}
		// まず置き場なしで開いて、本体のリポジトリを確かめる。ワークツリー（Para Code のスペースやボードの作業場所）から
		// 開いたら本体で開き直す（手元のボードの mainRepository と同じ。台帳とワークツリーの置き場が本体に揃うように）。
		// 本体がこの窓に登録されていなければ断る
		const probeId = this.host.newSessionId();
		let main: string;
		try {
			const probe = await channel.call<{ readonly toplevel: string; readonly commonDir: string }>('openSession', [probeId, repository.path]);
			main = typeof probe.commonDir === 'string' && posix.basename(probe.commonDir) === '.git' ? posix.dirname(probe.commonDir) : probe.toplevel;
		} catch (error) {
			return relayFailure(error);
		} finally {
			await channel.call('closeSession', [probeId]).catch(() => undefined);
		}
		const mainUri = main === repository.path ? repository : repository.with({ path: main });
		if (mainUri !== repository && !this.host.isWindowFolder(mainUri)) {
			return paradisTaskBoardFail('invalid', 'This folder is a worktree. Open the task board from the main repository of this window.');
		}
		const sessionId = this.host.newSessionId();
		const worktreeRoot = paradisTaskBoardRelayWorktreeRoot(main);
		let root: string;
		try {
			root = (await channel.call<{ readonly toplevel: string }>('openSession', [sessionId, main, worktreeRoot])).toplevel;
		} catch (error) {
			return relayFailure(error);
		}
		if (this._store.isDisposed) {
			void channel.call('closeSession', [sessionId]).catch(() => undefined);
			return paradisTaskBoardFail('unavailable', 'The window is closing.');
		}
		const session: IRelaySession = { sessionId, repository: mainUri, root, worktreeRoot, places: new Set([root]), bound: false, runs: new Set(), confirming: false, pinnedPush: undefined, pinnedFetch: undefined, defaultBranch: undefined };
		this.sessions.set(sessionId, session);
		const timer = new IntervalTimer();
		timer.cancelAndSet(() => {
			this.host.remoteChannel()?.call('heartbeat', [sessionId]).catch(error => this.host.warn('[ParadisTaskBoardRelay] heartbeat failed', error));
		}, PARADIS_TASK_BOARD_RELAY_HEARTBEAT_MS);
		// 工程のコマンドの出力（REH が 250 ms ごとにまとめて流す）を、そのボードへ渡す
		const output = channel.listen<{ readonly runId: string; readonly lines: readonly string[] }>('onOutput', sessionId)(chunk => {
			if (session.runs.has(chunk.runId)) {
				this.sendEvent(sessionId, { type: 'relay-output', runId: chunk.runId, lines: chunk.lines });
			}
		});
		this.heartbeats.set(sessionId, toDisposable(() => {
			timer.dispose();
			output.dispose();
		}));
		// 前に作ったワークツリー（Para Code を開き直した後でも返却できるように）。引き取れないものは記録から外す
		const record = this.host.readRecord(mainUri.toString());
		const adopted: IParadisTaskBoardRelayWorktree[] = [];
		for (const worktree of record.worktrees) {
			try {
				await channel.call('adoptWorktree', [sessionId, worktree.dir, worktree.branch]);
				session.places.add(worktree.dir);
				adopted.push(worktree);
			} catch {
				// 消えた・別のものに変わったワークツリー
			}
		}
		// push の宛先と PR のリポジトリを、ここで固定する（後から担当が origin を書き換えても、push で気づく）
		const pinned = await this.sessionInfo(session, channel).catch(() => undefined);
		session.pinnedPush = pinned?.originPush;
		session.pinnedFetch = pinned?.originFetch;
		session.defaultBranch = pinned?.defaultBranch;
		if (adopted.length !== record.worktrees.length) {
			this.host.writeRecord(mainUri.toString(), { ...record, worktrees: adopted });
		}
		return { ok: true, value: { sessionId, root } };
	}

	/** セッションにボードの鍵を結び、shared process へ登録する（ここから先、そのボードの依頼を受ける）。 */
	async bind(sessionId: string, boardKey: string): Promise<ParadisTaskBoardResult<true>> {
		const session = this.sessions.get(sessionId);
		if (!session || session.bound) {
			return paradisTaskBoardFail('invalid', 'The relay session is not prepared.');
		}
		if (!paradisTaskBoardIsBoardKey(boardKey)) {
			return paradisTaskBoardFail('invalid', 'The board key is not valid.');
		}
		const registered = await this.host.bridge.call<boolean>('registerRelaySession', { sessionId, boardKey, authority: this.host.remoteAuthority, repository: session.root }).catch(() => false);
		if (!registered) {
			return paradisTaskBoardFail('failed', 'The task board bridge did not accept the relay session.');
		}
		session.bound = true;
		return { ok: true, value: true };
	}

	async close(sessionId: string): Promise<void> {
		if (!this.sessions.delete(sessionId)) {
			return;
		}
		this.heartbeats.deleteAndDispose(sessionId);
		await Promise.all([
			this.host.remoteChannel()?.call('closeSession', [sessionId]).catch(() => undefined),
			this.host.bridge.call('closeRelaySession', sessionId).catch(() => undefined),
		]);
	}

	/** 担当を起動してよい作業場所か（セッションの root と、作った・引き取ったワークツリー）。パスは大小文字を区別して比べる。 */
	launchTarget(sessionId: string, path: string): URI | undefined {
		const session = this.sessions.get(sessionId);
		if (!session?.bound || !session.places.has(path)) {
			return undefined;
		}
		return URI.from({ scheme: Schemas.vscodeRemote, authority: session.repository.authority, path });
	}

	/** shared process から振り分けられた `/v1/relay` の依頼。 */
	async handle(arg: unknown): Promise<ParadisTaskBoardResult<unknown>> {
		const parsed = paradisParseTaskBoardRelayRequest(arg);
		if (!parsed.ok) {
			return paradisTaskBoardFail(parsed.code, parsed.message);
		}
		const { sessionId, op } = parsed.value;
		const session = this.sessions.get(sessionId);
		if (!session?.bound) {
			return paradisTaskBoardFail('not-found', 'The relay session is not open in this window.');
		}
		const channel = this.host.remoteChannel();
		if (!channel) {
			return paradisTaskBoardFail('unavailable', 'This window is not connected to the SSH host.');
		}
		const opPlace = op.kind === 'sessionInfo' || op.kind === 'writeFile' || op.kind === 'cancelRun' ? undefined : op.place;
		if (opPlace !== undefined && !session.places.has(opPlace)) {
			return paradisTaskBoardFail('rejected', 'The folder is not a workspace of this task board session.');
		}
		// ブランチを切り替える操作と `.para/` の作り直しは、ボードのワークツリーだけ（本体の作業ツリーは利用者のもの）
		const onWorktreeOnly = op.kind === 'resetBoardDir' || op.kind === 'runCommand' || op.kind === 'pushBranch'
			|| (op.kind === 'git' && (op.git.kind === 'switch' || op.git.kind === 'detach' || op.git.kind === 'mergeFfOnly' || op.git.kind === 'addTracked' || op.git.kind === 'commit'));
		if (onWorktreeOnly && opPlace === session.root) {
			return paradisTaskBoardFail('rejected', 'The task board does not switch branches or reset files in the main working tree of the repository.');
		}
		if (op.kind === 'git' && (op.git.kind === 'worktreeAdd' || op.git.kind === 'worktreeRemove')) {
			const dir = op.git.dir as string;
			// ワークツリーを足すのは置き場の直下だけ、外すのはこのセッションの作業場所（root 以外）だけ。REH でも重ねて確かめる
			const allowed = op.place === session.root && (op.git.kind === 'worktreeAdd' ? posix.dirname(dir) === session.worktreeRoot : dir !== session.root && session.places.has(dir));
			if (!allowed) {
				return paradisTaskBoardFail('rejected', 'The worktree folder is not allowed for this task board session.');
			}
		}
		try {
			switch (op.kind) {
				case 'sessionInfo': return { ok: true, value: await this.sessionInfo(session, channel) };
				case 'git': return { ok: true, value: await this.git(session, channel, op.place, op.git) };
				case 'readFile': {
					const bytes = await channel.call<VSBuffer | undefined>('readFile', [sessionId, op.place, op.path, op.maxBytes]);
					return bytes === undefined
						? { ok: true, value: { missing: true, detail: op.path } }
						: { ok: true, value: { base64: encodeBase64(bytes), size: bytes.byteLength, detail: `${op.path} ${bytes.byteLength}` } };
				}
				case 'writeFile':
					await channel.call('writeFile', [sessionId, session.root, op.path, op.content]);
					return { ok: true, value: { detail: op.path } };
				case 'resetBoardDir':
					return { ok: true, value: { reset: await channel.call<boolean>('resetBoardDir', [sessionId, op.place, op.taskId]) } };
				case 'excludeBoardDir':
					await channel.call('excludeBoardDir', [sessionId, op.place]);
					return { ok: true, value: {} };
				case 'runCommand':
					if (session.runs.has(op.runId)) {
						return paradisTaskBoardFail('invalid', 'The run id is already used.');
					}
					// 確認はボードの依頼を待たせずに進める（ダイアログは何分も開いていることがある）。結果は終わりのイベントで返す
					session.runs.add(op.runId);
					void this.startCommand(session, op.place, op.runId, op.command, op.step);
					return { ok: true, value: { accepted: true, detail: `run ${op.runId}` } };
				case 'pushBranch':
					if (session.runs.has(op.runId)) {
						return paradisTaskBoardFail('invalid', 'The run id is already used.');
					}
					session.runs.add(op.runId);
					void this.startPush(session, op.place, op.runId, op.branch, op.setUpstream, op.interactive);
					return { ok: true, value: { accepted: true, detail: `push ${op.branch}` } };
				case 'cancelRun':
					return { ok: true, value: { cancelled: await channel.call<boolean>('cancelRun', [sessionId, op.runId]).catch(() => false) } };
			}
		} catch (error) {
			return relayFailure(error);
		}
	}

	/**
	 * 工程のコマンドを走らせる。承認（リポジトリ・フロー・工程ごとの本文の hash）と違えば、この窓のダイアログで確かめる
	 * （初めてのときと、中身が変わったとき。Q525 の b = A）。照合するのは REH へ送るこの文字列そのもの。
	 */
	private async startCommand(session: IRelaySession, place: string, runId: string, command: string, step: IParadisTaskBoardRelayCommandStep): Promise<void> {
		const exit = (event: Omit<Extract<ParadisTaskBoardRelayEvent, { type: 'relay-exit' }>, 'type' | 'runId'>) => {
			session.runs.delete(runId);
			this.sendEvent(session.sessionId, { type: 'relay-exit', runId, ...event });
		};
		const key = `${session.repository.toString()}|${step.flowId}|${step.stepId}`;
		const hash = await this.host.sha256(command);
		const approved = this.host.readApproval(key);
		if (approved?.hash !== hash) {
			// 確認は 1 件ずつ（ダイアログを積み上げて、押し間違いを誘わない）
			if (session.confirming) {
				exit({ code: null, signal: null, cancelled: false, timedOut: false, reason: 'confirm-pending' });
				return;
			}
			session.confirming = true;
			const answer = await this.host.confirmCommand({
				authority: session.repository.authority, repository: session.root, place, command, step,
				previous: approved?.command, hash,
			}).catch(() => 'deny' as const).finally(() => session.confirming = false);
			if (answer === 'deny') {
				exit({ code: null, signal: null, cancelled: false, timedOut: false, reason: 'not-approved' });
				return;
			}
			if (answer === 'remember') {
				this.host.writeApproval(key, { hash, command });
			}
		}
		const channel = this.host.remoteChannel();
		if (!channel || !this.sessions.has(session.sessionId)) {
			exit({ code: null, signal: null, cancelled: true, timedOut: false, reason: 'disconnected' });
			return;
		}
		try {
			const result = await channel.call<{ readonly code: number | null; readonly signal: string | null; readonly cancelled: boolean; readonly timedOut: boolean }>('runCommand', [session.sessionId, place, runId, command]);
			// 心拍が切れて REH が止めたときは cancelled で返る
			exit({ code: result.code, signal: result.signal, cancelled: result.cancelled, timedOut: result.timedOut });
		} catch (error) {
			const failure = relayFailure(error);
			exit({ code: null, signal: null, cancelled: false, timedOut: false, reason: `${failure.code}: ${failure.message}`.slice(0, 500) });
		}
	}

	/**
	 * ボードのブランチを push する（Q525 の c = B、設計書 G6）。送るのは確認で見せた SHA のコミットそのもの。push のたびに、
	 * push の URL が固定した値と同じか、`.para/` の中のファイルや表示できない文字が入っていないかを確かめる。確認は、
	 * ボードが作ったと記録したブランチなら初回だけ（秘密らしい名前のファイルが足されたら聞き直す）、記録に無いブランチは毎回。
	 * 既定のブランチへは REH が送らない。返却のとき（interactive が false）は確認を出さず、確認が要れば送らない。
	 */
	private async startPush(session: IRelaySession, place: string, runId: string, branch: string, setUpstream: boolean, interactive: boolean): Promise<void> {
		const exit = (event: Omit<Extract<ParadisTaskBoardRelayEvent, { type: 'relay-exit' }>, 'type' | 'runId'>) => {
			session.runs.delete(runId);
			this.sendEvent(session.sessionId, { type: 'relay-exit', runId, ...event });
		};
		const refuse = (reason: string) => exit({ code: null, signal: null, cancelled: false, timedOut: false, reason });
		const channel = this.host.remoteChannel();
		if (!channel) {
			refuse('disconnected');
			return;
		}
		const git = async (op: Record<string, unknown>) => channel.call<{ readonly code: number; readonly stdout: string; readonly stderr: string }>('git', [session.sessionId, place, op]);
		try {
			const head = await git({ kind: 'headSha' });
			const sha = head.stdout.trim();
			if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
				refuse('no-commit');
				return;
			}
			// 送り先は、ちょうど 1 本で、セッションを開いたときに固定したものだけ（pushurl を足すと送り先が増える）
			const pushUrls = paradisTaskBoardRemoteStripUrlCredentials((await git({ kind: 'remoteUrl', push: true, all: true })).stdout).split('\n').map(url => url.trim()).filter(url => url.length > 0);
			const pushUrl = pushUrls[0] ?? '';
			if (session.pinnedPush === undefined || pushUrls.length !== 1 || pushUrl !== session.pinnedPush) {
				refuse('push-url-changed');
				return;
			}
			// mirror の設定があると、push がすべての参照を送る
			const mirror = await git({ kind: 'remoteMirror' });
			if (mirror.code === 0 && mirror.stdout.trim().toLowerCase() !== 'false') {
				refuse('push-mirror');
				return;
			}
			const remoteBranch = (await git({ kind: 'refExists', rev: { kind: 'remote', branch } })).code === 0;
			const base = remoteBranch ? { kind: 'remote', branch } : { kind: 'remote', branch: session.defaultBranch ?? 'main' };
			const subjects = await git({ kind: 'commitSubjects', base, head: { kind: 'sha', sha } });
			const changed = await git({ kind: 'changedFiles', base, head: { kind: 'sha', sha } });
			if (subjects.code !== 0 || changed.code !== 0) {
				refuse('cannot-read-commits');
				return;
			}
			const commits = subjects.stdout.split('\n').filter(line => line.length > 0);
			const files = changed.stdout.split('\0').filter(name => name.length > 0);
			// GitHub へ出る前に断るもの: ボードの作業フォルダの中身と、確認で正しく見せられない文字
			if (files.some(file => file === '.para' || file.startsWith('.para/'))) {
				refuse('board-files-in-commits');
				return;
			}
			if ([branch, pushUrl, ...commits, ...files].some(text => text.includes('\n') || paradisTaskBoardHasHiddenCharacters(text))) {
				refuse('hidden-characters');
				return;
			}
			const key = session.repository.toString();
			const record = this.host.readRecord(key);
			const recorded = branch.startsWith('para/') && record.branches.includes(branch);
			const approved = recorded && (record.pushApproved ?? []).includes(branch);
			const suspicious = files.filter(paradisTaskBoardRelayIsSuspiciousFile);
			// 記録に無いブランチは、送るコミットが 0 件でも確かめる（確認なしに新しいブランチを作らせない）
			if ((commits.length > 0 && (!approved || suspicious.length > 0)) || (!recorded && !approved)) {
				if (!interactive) {
					refuse('needs-confirmation');
					return;
				}
				if (session.confirming) {
					refuse('confirm-pending');
					return;
				}
				session.confirming = true;
				const answer = await this.host.confirmPush({
					authority: session.repository.authority, repository: session.root, place, branch, sha, pushUrl,
					fetchUrl: session.pinnedFetch, commits: commits.slice(0, 200), moreCommits: commits.length >= 200,
					files, suspicious, canRemember: recorded,
				}).catch(() => 'deny' as const).finally(() => session.confirming = false);
				if (answer === 'deny') {
					refuse('not-approved');
					return;
				}
				if (answer === 'remember' && recorded) {
					const latest = this.host.readRecord(key);
					this.host.writeRecord(key, { ...latest, pushApproved: [...(latest.pushApproved ?? []).filter(name => name !== branch), branch].slice(-MAX_RECORDED) });
				}
			}
			if (!this.sessions.has(session.sessionId)) {
				refuse('disconnected');
				return;
			}
			const result = await git({ kind: 'push', branch, setUpstream, defaultBranch: session.defaultBranch, source: sha });
			// 承認済みのブランチは、後から足したコミットも確かめずに送る（Q525 の c = B）。そのかわり、送った SHA と件数を必ず残す
			exit({ code: result.code, signal: null, cancelled: false, timedOut: false, ...(result.code === 0 ? { pushedSha: sha, pushedCommits: commits.length } : {}), ...(result.code !== 0 ? { reason: paradisTaskBoardRemoteStripUrlCredentials(result.stderr.trim().split('\n').slice(-3).join(' ')).slice(0, 400) || 'push-failed' } : {}) });
		} catch (error) {
			const failure = relayFailure(error);
			refuse(`${failure.code}: ${failure.message}`.slice(0, 500));
		}
	}

	/**
	 * 担当を起動するときだけ許可を渡す引数（Q525 の d = B）。渡すかどうかはリポジトリごとに 1 回この窓で確かめ、覚える。
	 * 断られた・答えが無いときは undefined（許可を渡さずに起動する）。
	 */
	async launchApprovalFlags(sessionId: string, agent: 'claude' | 'codex'): Promise<string | undefined> {
		const session = this.sessions.get(sessionId);
		if (!session?.bound) {
			return undefined;
		}
		const key = `launch-tools|${session.repository.toString()}`;
		if (this.host.readApproval(key)?.hash !== 'yes') {
			const answer = await this.host.confirmLaunchTools({ authority: session.repository.authority, repository: session.root, agent, tools: PARADIS_TASK_BOARD_LAUNCH_APPROVAL_TOOLS }).catch(() => 'deny' as const);
			if (answer !== 'remember') {
				return undefined;
			}
			this.host.writeApproval(key, { hash: 'yes', command: PARADIS_TASK_BOARD_LAUNCH_APPROVAL_TOOLS.join(',') });
		}
		return paradisTaskBoardLaunchApprovalFlags(agent);
	}

	private sendEvent(sessionId: string, event: ParadisTaskBoardRelayEvent): void {
		this.host.bridge.call('relayEvent', { sessionId, event }).catch(error => this.host.warn('[ParadisTaskBoardRelay] could not pass the command output to the board', error));
	}

	private async sessionInfo(session: IRelaySession, channel: IChannel): Promise<IParadisTaskBoardRelaySessionInfo> {
		const run = (git: Record<string, unknown>) => channel.call<{ readonly code: number; readonly stdout: string }>('git', [session.sessionId, session.root, git]).then(result => result.code === 0 ? result.stdout.trim() : undefined, () => undefined);
		const [head, fetchUrl, pushUrl] = await Promise.all([run({ kind: 'defaultBranch' }), run({ kind: 'remoteUrl', push: false }), run({ kind: 'remoteUrl', push: true })]);
		const strip = (url: string | undefined) => url === undefined ? undefined : paradisTaskBoardRemoteStripUrlCredentials(url);
		return {
			root: session.root,
			worktreeRoot: session.worktreeRoot,
			defaultBranch: head?.startsWith('refs/remotes/origin/') ? head.slice('refs/remotes/origin/'.length) : undefined,
			originFetch: strip(fetchUrl),
			originPush: strip(pushUrl),
			worktrees: [...session.places].filter(place => place !== session.root),
		};
	}

	private async git(session: IRelaySession, channel: IChannel, place: string, git: Readonly<Record<string, unknown>>): Promise<unknown> {
		const result = await channel.call<{ readonly code: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }>('git', [session.sessionId, place, git]);
		if (result.code === 0) {
			this.remember(session, git);
		}
		// URL の利用者の部分（トークン）は REH でも外しているが、古い REH や取りこぼしに備えて窓でも、出力の全体から外す
		return { code: result.code, stdout: paradisTaskBoardRemoteStripUrlCredentials(result.stdout), stderr: paradisTaskBoardRemoteStripUrlCredentials(result.stderr), timedOut: result.timedOut };
	}

	/** 作った・外したワークツリーと、作ったブランチを、手元の記録に残す。 */
	private remember(session: IRelaySession, git: Readonly<Record<string, unknown>>): void {
		const key = session.repository.toString();
		if (git.kind === 'worktreeAdd' && typeof git.dir === 'string') {
			session.places.add(git.dir);
		} else if (git.kind === 'worktreeRemove' && typeof git.dir === 'string') {
			session.places.delete(git.dir);
		} else if (git.kind !== 'switch') {
			return;
		}
		const record = this.host.readRecord(key);
		const worktrees = git.kind === 'worktreeAdd' ? [...record.worktrees.filter(worktree => worktree.dir !== git.dir), { dir: git.dir as string, branch: git.branch as string }] : git.kind === 'worktreeRemove' ? record.worktrees.filter(worktree => worktree.dir !== git.dir) : record.worktrees;
		const createdBranch = git.mode === 'new' && typeof git.branch === 'string' && git.branch.startsWith('para/') ? git.branch : undefined;
		const branches = createdBranch !== undefined ? [...record.branches.filter(branch => branch !== createdBranch), createdBranch] : record.branches;
		this.host.writeRecord(key, { worktrees: worktrees.slice(-MAX_RECORDED), branches: branches.slice(-MAX_RECORDED) });
	}
}
