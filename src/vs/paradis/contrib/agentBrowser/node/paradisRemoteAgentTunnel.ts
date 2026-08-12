/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH 接続先から手元の MCP / hook ゲートウェイへ戻ってくる経路を張る。
//
// なぜ要るか: エージェントCLIの hook (`notify-v*.sh`) も para-browser MCP も、手元の
// shared process が 127.0.0.1 で待っている HTTP へ話しかける前提で書かれている。SSH 接続中は
// エージェントが接続先で動くので、その 127.0.0.1 は接続先自身を指してしまい何も届かない。
//
// なぜ ssh を別に起動するのか: VS Code 本体のトンネルは「接続先のポートを手元で開く」方向
// しか持たない (ITunnelService.openTunnel は手元で listen する)。逆向きは open-remote-ssh にも
// 無く、`~/.ssh/config` の RemoteForward も読まれない (実測: 接続先から叩くと 000)。
// そこで同じホストへ `ssh -N -R` を1本だけ足して、接続先の同じ番号を手元へ向ける。
//
// 安全側の設計:
//  - 失敗しても投げない。トンネルが無い状態は「今までどおり hook が届かない」だけで、
//    ローカルのターミナルにも既存機能にも影響しない
//  - BatchMode。パスフレーズ待ちで固まらせない (鍵は ssh-agent 経由で解決される想定)
//  - ExitOnForwardFailure。ポートを取れなかったのに繋がったまま、を作らない
//  - 同じ authority へ二重に張らない。切断時と shared process 終了時に必ず畳む

import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/** `ssh-remote+<host>` から ssh に渡すホスト名を取り出す。他の種類の authority は扱わない。 */
export function paradisSshHostFromAuthority(remoteAuthority: string | undefined): string | undefined {
	if (!remoteAuthority) {
		return undefined;
	}
	const separator = remoteAuthority.indexOf('+');
	if (separator < 0) {
		return undefined;
	}
	const kind = remoteAuthority.slice(0, separator);
	const host = remoteAuthority.slice(separator + 1);
	if (kind !== 'ssh-remote' || host.length === 0) {
		return undefined;
	}
	// ssh の引数に渡すので、ホスト名として妥当な文字だけを通す（オプション注入を防ぐ）
	if (host.startsWith('-') || !/^[A-Za-z0-9._@%:\-[\]]+$/.test(host)) {
		return undefined;
	}
	return host;
}

/** 落ちたときの再試行間隔。張り直しで ssh を叩き続けないよう、控えめに戻す。 */
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

interface ITunnelEntry {
	readonly host: string;
	child: ChildProcess | undefined;
	retries: number;
	retryTimer: ReturnType<typeof setTimeout> | undefined;
	disposed: boolean;
}

/**
 * 接続先ごとに `ssh -N -R <port>:127.0.0.1:<port>` を1本維持する。
 *
 * ポート番号は手元のゲートウェイが実際に listen している番号をそのまま使う。接続先でも
 * 同じ番号で開くので、既存の hook スクリプト・MCP シムが読む「ポートファイルの port」を
 * そのまま接続先へ置けば、両者の期待が一致する。
 */
export class ParadisRemoteAgentTunnels extends Disposable {

	private readonly tunnels = new Map<string, ITunnelEntry>();

	constructor(
		private readonly logService: ILogService,
		// shared process の PATH は端末のそれとは限らないので、素の `ssh` が引けないときのために
		// 標準の場所も見る（macOS / Linux とも /usr/bin/ssh）。
		private readonly spawnSsh: (args: string[]) => ChildProcess = args => spawn(
			existsSync('/usr/bin/ssh') ? '/usr/bin/ssh' : 'ssh',
			args,
			{ stdio: ['ignore', 'ignore', 'pipe'] }
		),
	) {
		super();
		this._register(toDisposable(() => {
			for (const authority of [...this.tunnels.keys()]) {
				this.close(authority);
			}
		}));
	}

	/**
	 * 接続先への経路を用意する。既にあれば何もしない。
	 * @returns 張れた（もしくは既にある）なら true
	 */
	ensure(remoteAuthority: string, port: number): boolean {
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			return false;
		}
		const host = paradisSshHostFromAuthority(remoteAuthority);
		if (host === undefined) {
			// SSH 以外の接続先（コンテナ等）は対象外。静かに諦める
			return false;
		}
		const existing = this.tunnels.get(remoteAuthority);
		if (existing !== undefined && !existing.disposed) {
			return true;
		}
		const entry: ITunnelEntry = { host, child: undefined, retries: 0, retryTimer: undefined, disposed: false };
		this.tunnels.set(remoteAuthority, entry);
		this.start(remoteAuthority, entry, port);
		return true;
	}

	/** 接続が切れたとき（ウィンドウが閉じた・別の接続先へ移った）に畳む。 */
	close(remoteAuthority: string): void {
		const entry = this.tunnels.get(remoteAuthority);
		if (entry === undefined) {
			return;
		}
		entry.disposed = true;
		if (entry.retryTimer !== undefined) {
			clearTimeout(entry.retryTimer);
			entry.retryTimer = undefined;
		}
		entry.child?.kill();
		entry.child = undefined;
		this.tunnels.delete(remoteAuthority);
	}

	private start(remoteAuthority: string, entry: ITunnelEntry, port: number): void {
		const args = [
			'-N',
			'-R', `${port}:127.0.0.1:${port}`,
			// パスフレーズや初見ホストの確認で固まらせない。鍵は ssh-agent 側で解決される
			'-o', 'BatchMode=yes',
			// ポートを取れなかったら黙って繋がったままにせず終了させる
			'-o', 'ExitOnForwardFailure=yes',
			'-o', 'ServerAliveInterval=30',
			'-o', 'ServerAliveCountMax=3',
			entry.host,
		];

		let child: ChildProcess;
		try {
			child = this.spawnSsh(args);
		} catch (error) {
			this.logService.warn(`[paradis] could not start the return tunnel to ${entry.host}`, error);
			return;
		}
		entry.child = child;

		// spawn は起動できなくても例外を投げず、この event でだけ知らせてくる。購読しないと
		// 「ssh が PATH に無い」が黙って捨てられ、張れていないのに何も分からなくなる。
		child.on('error', error => {
			this.logService.warn(`[paradis] the return tunnel to ${entry.host} could not start (is ssh on PATH?)`, error);
		});

		// ssh の stderr は失敗理由（ポート衝突・鍵無し）が出る唯一の場所なので拾っておく。
		// 経路が張れないと実行状態が出ないだけで原因が見えないため、warn で残す。
		child.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text.length > 0) {
				this.logService.warn(`[paradis] return tunnel (${entry.host}): ${text}`);
			}
		});

		child.on('exit', code => {
			if (entry.disposed) {
				return;
			}
			entry.child = undefined;
			if (entry.retries >= MAX_RETRIES) {
				this.logService.warn(`[paradis] gave up on the return tunnel to ${entry.host} (last exit code ${code})`);
				return;
			}
			entry.retries++;
			entry.retryTimer = setTimeout(() => {
				entry.retryTimer = undefined;
				if (!entry.disposed) {
					this.start(remoteAuthority, entry, port);
				}
			}, RETRY_DELAY_MS);
		});
	}

	/**
	 * 接続先に置いたファイルへ実行権を与える。IFileService には権限を触る口が無いため、
	 * ここだけ ssh を短く1回叩く。パスは argv へ直接渡す（シェルを経由しない）。
	 */
	async chmodExecutable(remoteAuthority: string, path: string): Promise<boolean> {
		const host = paradisSshHostFromAuthority(remoteAuthority);
		if (host === undefined || !path.startsWith('/')) {
			return false;
		}
		return new Promise<boolean>(resolve => {
			let child: ChildProcess;
			try {
				child = this.spawnSsh(['-o', 'BatchMode=yes', host, 'chmod', '+x', path]);
			} catch (error) {
				this.logService.warn(`[paradis] could not chmod ${path} on ${host}`, error);
				resolve(false);
				return;
			}
			child.on('error', error => {
				this.logService.warn(`[paradis] could not chmod ${path} on ${host}`, error);
				resolve(false);
			});
			child.on('exit', code => resolve(code === 0));
		});
	}

	/** テスト用。張られている接続先の一覧。 */
	get authorities(): readonly string[] {
		return [...this.tunnels.keys()];
	}
}

export function createParadisRemoteAgentTunnels(logService: ILogService): ParadisRemoteAgentTunnels & IDisposable {
	return new ParadisRemoteAgentTunnels(logService);
}
