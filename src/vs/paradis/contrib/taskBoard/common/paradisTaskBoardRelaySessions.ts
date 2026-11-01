/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * タスクボードの SSH 中継の、SSH の窓の側（設計書 G3・G4・G9）。許すかどうかを決める場所。
 *
 *  - セッションは、この窓が自分の接続先（remoteAuthority）の、自分に登録されたリポジトリに対してだけ作る。
 *    リポジトリはボードの依頼からではなく、窓が自分の URI から決める
 *  - ボードから来た依頼は、許す欄だけを取り出して組み直してから REH へ送る（paradisParseTaskBoardRelayRequest）。
 *    2 本目で通すのは読むだけの git と readFile だけ
 *  - 30 秒ごとに REH へ心拍を送る（REH は 120 秒途絶えたら閉じて、実行中のコマンドを止める）
 *
 * セッションを作る入口（SSH の窓のボタン）は、ボードの側の作り替え（設計書の PR 3）で足す。
 */

import { IntervalTimer } from '../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ParadisTaskBoardErrorCode, ParadisTaskBoardResult, paradisTaskBoardFail } from './paradisTaskBoardBridge.js';
import { PARADIS_TASK_BOARD_RELAY_HEARTBEAT_MS, paradisParseTaskBoardRelayRequest, paradisTaskBoardIsBoardKey } from './paradisTaskBoardRelay.js';
import { paradisTaskBoardRemoteStripUrlCredentials } from './paradisTaskBoardRemote.js';

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
	warn(message: string, error?: unknown): void;
}

interface IRelaySession {
	readonly sessionId: string;
	/** REH が返した、リポジトリの一番上（realpath 済み）。2 本目では作業場所はこれだけ。 */
	readonly root: string;
}

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
	 * この窓のリポジトリ（`vscode-remote`、authority がこの窓の接続先）に中継のセッションを開き、shared process へ
	 * 登録する。`boardKey` はこのセッションを使ってよいボードの鍵（main の open() が返したもの）。
	 */
	async open(repository: URI, boardKey: string): Promise<ParadisTaskBoardResult<{ readonly sessionId: string }>> {
		const authority = this.host.remoteAuthority;
		if (authority === undefined || repository.scheme !== Schemas.vscodeRemote || repository.authority !== authority) {
			return paradisTaskBoardFail('invalid', 'The repository is not on the SSH host of this window.');
		}
		if (!this.host.isWindowFolder(repository)) {
			return paradisTaskBoardFail('invalid', 'The repository is not registered in this window.');
		}
		if (!paradisTaskBoardIsBoardKey(boardKey)) {
			return paradisTaskBoardFail('invalid', 'The board key is not valid.');
		}
		const channel = this.host.remoteChannel();
		if (!channel) {
			return paradisTaskBoardFail('unavailable', 'This window is not connected to the SSH host.');
		}
		const sessionId = this.host.newSessionId();
		let root: string;
		try {
			root = (await channel.call<{ readonly toplevel: string }>('openSession', [sessionId, repository.path])).toplevel;
		} catch (error) {
			return relayFailure(error);
		}
		if (this._store.isDisposed) {
			void channel.call('closeSession', [sessionId]).catch(() => undefined);
			return paradisTaskBoardFail('unavailable', 'The window is closing.');
		}
		this.sessions.set(sessionId, { sessionId, root });
		const timer = new IntervalTimer();
		timer.cancelAndSet(() => {
			this.host.remoteChannel()?.call('heartbeat', [sessionId]).catch(error => this.host.warn('[ParadisTaskBoardRelay] heartbeat failed', error));
		}, PARADIS_TASK_BOARD_RELAY_HEARTBEAT_MS);
		this.heartbeats.set(sessionId, toDisposable(() => timer.dispose()));
		const registered = await this.host.bridge.call<boolean>('registerRelaySession', { sessionId, boardKey, authority, repository: root }).catch(() => false);
		if (!registered) {
			await this.close(sessionId);
			return paradisTaskBoardFail('failed', 'The task board bridge did not accept the relay session.');
		}
		return { ok: true, value: { sessionId } };
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

	/** shared process から振り分けられた `/v1/relay` の依頼。 */
	async handle(arg: unknown): Promise<ParadisTaskBoardResult<unknown>> {
		const parsed = paradisParseTaskBoardRelayRequest(arg);
		if (!parsed.ok) {
			return paradisTaskBoardFail(parsed.code, parsed.message);
		}
		const { sessionId, op } = parsed.value;
		const session = this.sessions.get(sessionId);
		if (!session) {
			return paradisTaskBoardFail('not-found', 'The relay session is not open in this window.');
		}
		const channel = this.host.remoteChannel();
		if (!channel) {
			return paradisTaskBoardFail('unavailable', 'This window is not connected to the SSH host.');
		}
		try {
			if (op.kind === 'git') {
				const result = await channel.call<{ readonly code: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }>('git', [sessionId, session.root, op.git]);
				// URL の利用者の部分は REH でも外しているが、古い REH や取りこぼしに備えて窓でも外す
				const stdout = op.git.kind === 'remoteUrl' ? paradisTaskBoardRemoteStripUrlCredentials(result.stdout) : result.stdout;
				return { ok: true, value: { code: result.code, stdout, stderr: result.stderr, timedOut: result.timedOut } };
			}
			const bytes = await channel.call<VSBuffer | undefined>('readFile', [sessionId, session.root, op.path, op.maxBytes]);
			return bytes === undefined
				? { ok: true, value: { missing: true, detail: op.path } }
				: { ok: true, value: { base64: encodeBase64(bytes), size: bytes.byteLength, detail: `${op.path} ${bytes.byteLength}` } };
		} catch (error) {
			return relayFailure(error);
		}
	}
}
