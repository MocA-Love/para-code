/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「Para ホスト」ビューが、このウィンドウが**繋がっていない**ホストの中身を見るための ssh 実行。
//
// 繋がっているホストは既存の SSH 接続 (vscode-remote:// + IFileService) で読めるので、ここは
// 通らない。通るのは `~/.ssh/config` に書いてあるだけのホストで、読むたびに ssh を起こす。
//
// 実行方式は paradisWorktreeGitChannel.ts と同じ execFile 直叩き。BatchMode=yes を付けて
// **パスワード/パスフレーズを聞かれたら即座に失敗させる**: shared process には端末が無いので、
// 聞かれたまま待たせるとビューが黙って固まる (鍵が要るホストはエラーとして返し、
// ビュー側が「接続してから開く」導線を出す)。

import * as cp from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import { dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { parseSSHConfigHostEntries, stripSSHComment } from '../../../../platform/agentHost/common/sshConfigParsing.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisSshDirEntry, IParadisSshListRequest, paradisIsSafeSshHost, paradisParseSshListing, PARADIS_REMOTE_HOSTS_CHANNEL } from '../common/paradisRemoteHosts.js';

/**
 * ssh 1回あたりの上限。接続不能なホスト (電源が落ちている等) では TCP のタイムアウトを
 * 待つことになるため、ビューが体感で固まらない長さで切る。
 */
const PARADIS_SSH_TIMEOUT_MS = 20_000;

/** 一覧の出力上限。巨大ディレクトリで shared process のメモリを食い潰さないための保険。 */
const PARADIS_SSH_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** 1ディレクトリあたりの最大エントリ数。超えた分は切り捨てて、切り捨てた事実だけ返す。 */
const PARADIS_SSH_MAX_ENTRIES = 2000;

/** 接続確立の上限。全体 ({@link PARADIS_SSH_TIMEOUT_MS}) より短くして ls の時間を残す。 */
const PARADIS_SSH_CONNECT_TIMEOUT_SECONDS = 8;

/** ホーム基準のパスに付けている印 (ビュー側が組み立てる URI と対)。 */
const PARADIS_HOME_PATH_PREFIX = '/~/';

/** ユーザーへ見せる ssh のエラー。リモートが決める文字列なので、量も記法も抑える。 */
function paradisSanitizeSshError(stderr: string): string {
	return stderr
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.slice(-2)
		.join(' ')
		// 通知は markdown のリンク記法を解釈するので、記号を潰してリンクにさせない
		.replace(/[[\]()]/g, ' ')
		.slice(0, 200)
		.trim();
}

/** 一覧結果。`truncated` が true なら {@link PARADIS_SSH_MAX_ENTRIES} で打ち切っている。 */
export interface IParadisSshListResult {
	readonly entries: readonly IParadisSshDirEntry[];
	readonly truncated: boolean;
}

/**
 * リモートのディレクトリを1階層読む。
 *
 * 一覧には `ls -Ap` を使う。`-p` がディレクトリにだけ `/` を付けるので、ファイル名に改行が
 * 無い限り種別を1回の往復で判別できる (`ls -l` のパースは実装差が大きく、`find -printf` は
 * BSD 系に無い)。名前に改行を含むエントリは種別を誤るため、行末が `/` かどうかだけで判定し、
 * それ以外の解釈はしない。
 */
export class ParadisRemoteHostsSshService {

	constructor(private readonly logService: ILogService) { }

	/**
	 * `~/.ssh/config` のホスト別名を集める。Include も追う。
	 *
	 * upstream にも同じことをする `ISSHRemoteAgentHostService.listSSHConfigHosts()` があるが、
	 * あちらは Agent Sessions ウィンドウ専用のエントリからしか登録されないサービス
	 * (`sessions.desktop.main.ts` だけが読む) なので、通常ウィンドウからは解決できない。
	 * パーサ本体は common 層にあるのでそれを借り、ファイル読みだけここで行う。
	 */
	async listConfiguredHosts(): Promise<readonly string[]> {
		const configPath = join(os.homedir(), '.ssh', 'config');
		try {
			const content = await fsp.readFile(configPath, 'utf-8');
			const hosts = await this.collectHosts(content, dirname(configPath), new Set<string>());
			// 同じ別名が本体と Include の両方に書いてあることは珍しくない。
			// ツリーの identity が衝突するので、ここで一意にしておく
			return [...new Set(hosts)];
		} catch {
			this.logService.info(`[ParadisRemoteHosts] no readable ssh config at ${configPath}`);
			return [];
		}
	}

	/** Include をたどってホスト別名を集める (upstream の _parseSSHConfigHosts と同じ手順)。 */
	private async collectHosts(content: string, configDir: string, seen: Set<string>): Promise<string[]> {
		const hosts = [...parseSSHConfigHostEntries(content)];
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) {
				continue;
			}
			const includeMatch = trimmed.match(/^Include\s+(.+)$/i);
			if (!includeMatch) {
				continue;
			}
			for (const rawPattern of stripSSHComment(includeMatch[1]).split(/\s+/).filter(Boolean)) {
				const pattern = rawPattern.replace(/^~/, os.homedir());
				const resolved = isAbsolute(pattern) ? pattern : join(configDir, pattern);
				// 相互 Include で無限に潜らないよう、一度見たパスは辿らない
				if (seen.has(resolved)) {
					continue;
				}
				seen.add(resolved);
				try {
					const sub = await fsp.readFile(resolved, 'utf-8');
					hosts.push(...await this.collectHosts(sub, dirname(resolved), seen));
				} catch {
					// glob パターンや読めないファイルは黙って飛ばす (upstream と同じ)
				}
			}
		}
		return hosts;
	}

	async listDirectory(request: IParadisSshListRequest): Promise<IParadisSshListResult> {
		const target = paradisSanitizeSshHost(request.host);
		const path = request.path.trim();
		// パスはシングルクォートで包んで渡す。中のシングルクォートは POSIX の定石で閉じ直す。
		// ただし先頭の `~/` はクォートの外に出す — 中に入れるとリモートのシェルが展開せず、
		// 先頭 `/` の絶対パスとして解釈されて必ず見つからなくなる
		const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
		let quoted: string;
		if (path.length === 0) {
			quoted = '~';
		} else if (path.startsWith(PARADIS_HOME_PATH_PREFIX)) {
			quoted = `~/${quote(path.slice(PARADIS_HOME_PATH_PREFIX.length))}`;
		} else {
			quoted = quote(path);
		}
		// -L はリンク先を見る。付けないとディレクトリへのシンボリックリンクに `/` が付かず、
		// フォルダなのにファイル行として出て開けなくなる
		const command = `LC_ALL=C ls -ApL -- ${quoted}`;
		const stdout = await this.exec(target, command);
		return paradisParseSshListing(stdout, PARADIS_SSH_MAX_ENTRIES);
	}

	private exec(host: string, command: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const args = [
				// 対話プロンプトが出たら即失敗させる (端末が無いので待たせても永久に返らない)
				'-o', 'BatchMode=yes',
				// 未知のホスト鍵で確認待ちにしない。accept-new は「初回は受け入れるが、
				// 変わったら拒否」で、鍵の入れ替わり (中間者) は従来どおり弾ける。
				//
				// なお fork には別途 sshHostKeyPolicy.ts の慎重な方針 (未知は確認、不一致は拒否)
				// があり、こちらはそれを通らずに known_hosts へ焼き付ける。閲覧専用の入口なので
				// TOFU を選んでいるが、非対称なのは意図的。ユーザーには展開前の確認ダイアログで
				// 「初めてのホストは鍵を登録する」と伝えている
				'-o', 'StrictHostKeyChecking=accept-new',
				// 接続だけで全体の予算を使い切らないよう、全体タイムアウトより十分短くする
				'-o', `ConnectTimeout=${PARADIS_SSH_CONNECT_TIMEOUT_SECONDS}`,
				// これ以降はオプションではなく宛先。ホスト名検査と二重の網にする
				'--',
				host,
				command,
			];
			cp.execFile('ssh', args, {
				timeout: PARADIS_SSH_TIMEOUT_MS,
				maxBuffer: PARADIS_SSH_MAX_BUFFER_BYTES,
				encoding: 'utf8',
			}, (error, stdout, stderr) => {
				if (error) {
					// stderr の方が原因が具体的 (Permission denied / No route to host / ...)。
					// ただし中身はリモートが自由に決められる (SSH バナー等) ので、そのまま通知へ
					// 渡さない: 通知は markdown リンクを描くため、任意のリンクを出せてしまう。
					// 末尾2行だけ・リンク記法を潰して・長さも切る (ログにも同じものを出す)
					const detail = paradisSanitizeSshError(String(stderr ?? '')) || error.message;
					this.logService.warn(`[ParadisRemoteHosts] ssh listing failed for ${host}: ${detail}`);
					reject(new Error(detail));
					return;
				}
				resolve(String(stdout ?? ''));
			});
		});
	}
}

/** ホスト名の素性検査。ssh のオプションと解釈されうる文字列を弾く。 */
function paradisSanitizeSshHost(host: string): string {
	const trimmed = host.trim();
	if (!paradisIsSafeSshHost(trimmed)) {
		throw new Error(`unsupported ssh host: ${trimmed}`);
	}
	return trimmed;
}

class ParadisRemoteHostsChannel implements IServerChannel {

	constructor(private readonly service: ParadisRemoteHostsSshService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'listConfiguredHosts':
				return this.service.listConfiguredHosts() as Promise<T>;
			case 'listDirectory':
				return this.service.listDirectory(arg as IParadisSshListRequest) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/** shared process から呼ぶ登録関数 (他の paradis チャネルと同じ形)。 */
export function registerParadisRemoteHosts(server: IPCServer, logService: ILogService): void {
	server.registerChannel(PARADIS_REMOTE_HOSTS_CHANNEL, new ParadisRemoteHostsChannel(new ParadisRemoteHostsSshService(logService)));
}
