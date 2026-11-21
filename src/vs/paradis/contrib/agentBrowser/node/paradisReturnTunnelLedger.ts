/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 戻りトンネルの ssh の PID を控え、前の起動が残した ssh を次の起動で片付ける。
//
// アプリが正常に終われば、戻りトンネルの ssh は shared process の終了処理で止まる。落ちた・強制終了
// されたときは親を失ったまま生き残り、接続先の番号を握り続ける。そこへつながったエージェントは、
// 接続元の確認（今の shared process が起こした ssh か）を通らず、タブを開く道具だけ断られる。
//
// 片付ける相手は「この控えにある PID で、今もコマンドが戻りトンネルの形をしているもの」だけにする。
// コマンドの形だけで探すと、同じ利用者が動かしている別の Para Code（開発版など）の生きたトンネルまで
// 止めてしまう。PID だけで止めると、番号が使い回された無関係のプロセスを止めてしまう。

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { dirname } from '../../../../base/common/path.js';

/** 戻りトンネルの ssh のコマンドの形（paradisRemoteAgentTunnel.ts の `tunnelArgs`）。 */
const RETURN_TUNNEL_COMMAND = /(?:^|\/)ssh -N -R \d+:127\.0\.0\.1:\d+ -o ControlPath=none -o BatchMode=yes -o ExitOnForwardFailure=yes /;

/** そのコマンドが、Para Code の張った戻りトンネルの ssh の形か。 */
export function paradisIsReturnTunnelCommand(command: string): boolean {
	return RETURN_TUNNEL_COMMAND.test(command.trim());
}

/** 控えの中身を読む。壊れていれば空。 */
export function paradisParseReturnTunnelLedger(raw: string): number[] {
	try {
		const value: unknown = JSON.parse(raw);
		const pids = typeof value === 'object' && value !== null ? (value as { pids?: unknown }).pids : undefined;
		return Array.isArray(pids) ? pids.filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 1) : [];
	} catch {
		return [];
	}
}

export interface IParadisReturnTunnelLedgerHost {
	/** その PID のコマンド。居なければ undefined。 */
	commandOf(pid: number): Promise<string | undefined>;
	kill(pid: number): void;
	readFile(file: string): Promise<string | undefined>;
	writeFile(file: string, content: string): Promise<void>;
}

const nodeHost: IParadisReturnTunnelLedgerHost = {
	commandOf: pid => new Promise(resolve => {
		execFile('ps', ['-p', String(pid), '-o', 'args='], { timeout: 5000 }, (error, stdout) => {
			const command = error ? '' : stdout.trim();
			resolve(command.length > 0 ? command : undefined);
		});
	}),
	kill: pid => process.kill(pid),
	readFile: async file => {
		try {
			return await fs.readFile(file, 'utf8');
		} catch {
			return undefined;
		}
	},
	writeFile: async (file, content) => {
		await fs.mkdir(dirname(file), { recursive: true });
		await fs.writeFile(file, content, { mode: 0o600 });
	},
};

export class ParadisReturnTunnelLedger {

	private readonly live = new Set<number>();
	private readonly reaped: Promise<void>;
	private writing: Promise<void> = Promise.resolve();

	constructor(
		private readonly file: string,
		private readonly log: { info(message: string): void; warn(message: string, error?: unknown): void },
		private readonly host: IParadisReturnTunnelLedgerHost = nodeHost,
		platform: NodeJS.Platform = process.platform,
	) {
		// Windows には同じ形の `ps` が無い。控えも片付けもしない
		this.reaped = platform === 'win32' ? Promise.resolve() : this.reapStale();
	}

	/** 前の起動が残した ssh の片付けが済むのを待つ（テスト用）。 */
	whenReaped(): Promise<void> {
		return this.reaped;
	}

	/** 張った ssh を控える。 */
	add(pid: number | undefined): void {
		if (typeof pid === 'number' && pid > 1 && !this.live.has(pid)) {
			this.live.add(pid);
			this.save();
		}
	}

	/** 終わった ssh を控えから外す。 */
	remove(pid: number | undefined): void {
		if (typeof pid === 'number' && this.live.delete(pid)) {
			this.save();
		}
	}

	private async reapStale(): Promise<void> {
		try {
			const raw = await this.host.readFile(this.file);
			if (raw === undefined) {
				return;
			}
			let stopped = 0;
			for (const pid of paradisParseReturnTunnelLedger(raw)) {
				if (this.live.has(pid) || pid === process.pid) {
					continue;
				}
				const command = await this.host.commandOf(pid);
				if (command !== undefined && paradisIsReturnTunnelCommand(command)) {
					try {
						this.host.kill(pid);
						stopped++;
					} catch {
						// もう居ない
					}
				}
			}
			if (stopped > 0) {
				this.log.info(`[paradis] stopped ${stopped} return tunnel(s) left behind by a previous run`);
			}
		} catch (error) {
			this.log.warn('[paradis] could not check for return tunnels left behind by a previous run', error);
		}
	}

	private save(): void {
		// 片付けが読む前に上書きしない。書き込みは 1 本ずつ流し、最後の状態を残す
		this.writing = this.writing.then(() => this.reaped).then(() => this.host.writeFile(this.file, JSON.stringify({ pids: [...this.live] }))).catch(error => {
			this.log.warn('[paradis] could not record the return tunnels', error);
		});
	}
}
