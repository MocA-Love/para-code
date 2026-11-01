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
import { ParadisTaskBoardErrorCode, ParadisTaskBoardResult, paradisTaskBoardFail } from './paradisTaskBoardBridge.js';
import { IParadisTaskBoardRelaySessionInfo, PARADIS_TASK_BOARD_RELAY_HEARTBEAT_MS, paradisParseTaskBoardRelayRequest, paradisTaskBoardIsBoardKey } from './paradisTaskBoardRelay.js';
import { paradisTaskBoardRemoteStripUrlCredentials } from './paradisTaskBoardRemote.js';

/** 手元に残す、リポジトリごとの記録。 */
export interface IParadisTaskBoardRelayRecord {
	/** この窓（Para Code）が作ったワークツリー。 */
	readonly worktrees: readonly string[];
	/** 作ったときに origin に無かった、ボードのブランチ（`para/…`）。 */
	readonly branches: readonly string[];
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
		const session: IRelaySession = { sessionId, repository: mainUri, root, worktreeRoot, places: new Set([root]), bound: false };
		this.sessions.set(sessionId, session);
		const timer = new IntervalTimer();
		timer.cancelAndSet(() => {
			this.host.remoteChannel()?.call('heartbeat', [sessionId]).catch(error => this.host.warn('[ParadisTaskBoardRelay] heartbeat failed', error));
		}, PARADIS_TASK_BOARD_RELAY_HEARTBEAT_MS);
		this.heartbeats.set(sessionId, toDisposable(() => timer.dispose()));
		// 前に作ったワークツリー（Para Code を開き直した後でも返却できるように）。引き取れないものは記録から外す
		const record = this.host.readRecord(mainUri.toString());
		const adopted: string[] = [];
		for (const dir of record.worktrees) {
			try {
				await channel.call('adoptWorktree', [sessionId, dir]);
				session.places.add(dir);
				adopted.push(dir);
			} catch {
				// 消えた・別のものに変わったワークツリー
			}
		}
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
		const opPlace = op.kind === 'sessionInfo' || op.kind === 'writeFile' ? undefined : op.place;
		if (opPlace !== undefined && !session.places.has(opPlace)) {
			return paradisTaskBoardFail('rejected', 'The folder is not a workspace of this task board session.');
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
			}
		} catch (error) {
			return relayFailure(error);
		}
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
		const worktrees = git.kind === 'worktreeAdd' ? [...record.worktrees.filter(dir => dir !== git.dir), git.dir as string] : git.kind === 'worktreeRemove' ? record.worktrees.filter(dir => dir !== git.dir) : record.worktrees;
		const createdBranch = git.mode === 'new' && typeof git.branch === 'string' && git.branch.startsWith('para/') ? git.branch : undefined;
		const branches = createdBranch !== undefined ? [...record.branches.filter(branch => branch !== createdBranch), createdBranch] : record.branches;
		this.host.writeRecord(key, { worktrees: worktrees.slice(-MAX_RECORDED), branches: branches.slice(-MAX_RECORDED) });
	}
}
