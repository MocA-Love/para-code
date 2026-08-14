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
import { createHash } from 'crypto';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from '../../../../base/common/path.js';
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

/** 1ウィンドウが同時に引ける Codex ソケットの上限。 */
const MAX_SOCKET_FORWARDS_PER_WINDOW = 8;

/** 落ちたときの再試行間隔。張り直しで ssh を叩き続けないよう、控えめに戻す。 */
const RETRY_DELAY_MS = 5000;

/** 接続先の Claude Code の版を聞き直す間隔。頻繁に変わるものではないので長めに持つ。 */
const CLAUDE_VERSION_TTL_MS = 30 * 60_000;
const MAX_RETRIES = 3;

interface ITunnelEntry {
	readonly host: string;
	/**
	 * この接続へ転送の足し引きを頼むための制御ソケット。置き場が無い・長すぎる場合は undefined で、
	 * そのときは Codex ソケットの引き込みだけを諦める（**戻り経路は張る**。hook が届かなくなる
	 * ほうがずっと痛い）。
	 */
	readonly controlPath: string | undefined;
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
	/** 接続先ごとの Claude Code の版。ssh を毎回叩かないための控え。 */
	private readonly claudeVersions = new Map<string, { readonly version: string | undefined; readonly at: number }>();
	/** ウィンドウ → そのウィンドウが欲しがっている転送（手元のパス → 接続先のパス）。 */
	private readonly socketForwardOwners = new Map<string, Map<string, string>>();
	/** 実際に張れている転送（手元のパス → 接続先のパス）。取り下げに同じ指定が要る。 */
	private readonly openedSocketForwards = new Map<string, string>();

	constructor(
		private readonly logService: ILogService,
		// shared process の PATH は端末のそれとは限らないので、素の `ssh` が引けないときのために
		// 標準の場所も見る（macOS / Linux とも /usr/bin/ssh）。
		// 出力が要る用途（版の問い合わせ）だけ stdout を受ける。トンネル側は読み手が居ないので、
		// 繋いだままにするとパイプが詰まって固まりうる。
		private readonly spawnSsh: (args: string[], captureOutput?: boolean) => ChildProcess = (args, captureOutput) => spawn(
			existsSync('/usr/bin/ssh') ? '/usr/bin/ssh' : 'ssh',
			args,
			{ stdio: ['ignore', captureOutput === true ? 'pipe' : 'ignore', 'pipe'] }
		),
		/** 制御ソケットを置く場所。無ければ Codex ソケットの引き込みだけを諦める。 */
		private readonly runtimeDirectory: string | undefined = undefined,
	) {
		super();
		this._register(toDisposable(() => {
			for (const authority of [...this.tunnels.keys()]) {
				this.close(authority);
			}
			for (const owner of [...this.socketForwardOwners.keys()]) {
				this.releaseSocketForwards(owner);
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
		const entry: ITunnelEntry = { host, controlPath: this.controlPathFor(remoteAuthority), child: undefined, retries: 0, retryTimer: undefined, disposed: false };
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
			// Codex ペインのソケットを後から足し引きするための制御口。接続そのものは1本のまま
			// にしたいので、ペインごとに ssh を起こさずここへ相乗りさせる
			...(entry.controlPath !== undefined ? ['-M', '-S', entry.controlPath, '-o', 'ControlPersist=no'] : []),
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

	/**
	 * 接続先で Codex が作るソケットを、手元の同じ名前のソケットとして見えるようにする。
	 *
	 * Codex の承認カードやモデル一覧は、TUI の画面ではなく app-server との構造化されたやり取りで
	 * 取っている。その相手は接続先に居るのに、話しかける shared process は手元に居る。手元に
	 * ソケットを作り、そこへの接続を接続先のソケットへ流す。手元の側から見ると、繋いでいない
	 * ときと同じ場所に同じソケットがあることになるので、読む側は何も変えなくてよい。
	 *
	 * **既に張ってある戻り経路に相乗りする**（`ControlMaster`）。ペインごとに ssh を起こすと、
	 * ターミナルを何枚も開いたウィンドウを復元しただけで同時接続が10本を超え、sshd の
	 * `MaxStartups` に触って何本かが黙って落ちる。接続は接続先1つにつき1本のままにする。
	 * 戻り経路が無い（設定で切られている・まだ張れていない）ときは何もしない。
	 *
	 * @param owner どのウィンドウの要求か。ウィンドウは同じ接続先へ何枚でも開けるので、
	 * 自分の要求だけを差し替える（他のウィンドウのぶんまで畳むと、相手のペインが黙って死ぬ）。
	 */
	syncSocketForwards(owner: string, remoteAuthority: string, wanted: ReadonlyMap<string, string>): void {
		const entry = this.tunnels.get(remoteAuthority);
		if (entry === undefined || entry.disposed || entry.controlPath === undefined) {
			return;
		}
		if (wanted.size > MAX_SOCKET_FORWARDS_PER_WINDOW) {
			this.logService.warn(`[paradis] too many Codex panes to forward (${wanted.size}); keeping the first ${MAX_SOCKET_FORWARDS_PER_WINDOW}`);
			wanted = new Map([...wanted].slice(0, MAX_SOCKET_FORWARDS_PER_WINDOW));
		}
		const previous = this.socketForwardOwners.get(owner) ?? new Map<string, string>();
		this.socketForwardOwners.set(owner, new Map(wanted));
		for (const [localPath] of previous) {
			if (!wanted.has(localPath)) {
				this.dropSocketForward(entry, localPath);
			}
		}
		for (const [localPath, remotePath] of wanted) {
			if (previous.get(localPath) !== remotePath) {
				this.openSocketForward(entry, localPath, remotePath);
			}
		}
	}

	/** そのウィンドウぶんの要求を取り下げる（閉じた・接続が切れた）。 */
	releaseSocketForwards(owner: string): void {
		const previous = this.socketForwardOwners.get(owner);
		if (previous === undefined) {
			return;
		}
		this.socketForwardOwners.delete(owner);
		for (const [localPath] of previous) {
			for (const entry of this.tunnels.values()) {
				this.dropSocketForward(entry, localPath);
			}
		}
	}

	/** 他のウィンドウがまだ欲しがっているか。 */
	private isSocketForwardWanted(localPath: string): boolean {
		for (const wanted of this.socketForwardOwners.values()) {
			if (wanted.has(localPath)) {
				return true;
			}
		}
		return false;
	}

	private openSocketForward(entry: ITunnelEntry, localPath: string, remotePath: string): void {
		// ssh は既にあるファイルへは listen しない。前回の残骸を先に片付ける
		try {
			mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
			unlinkSync(localPath);
		} catch {
			// 無ければそれでよい
		}
		this.controlCommand(entry, ['forward', '-L', `${localPath}:${remotePath}`], `forward the Codex socket`);
	}

	private dropSocketForward(entry: ITunnelEntry, localPath: string): void {
		if (this.isSocketForwardWanted(localPath)) {
			return;
		}
		const remotePath = this.openedSocketForwards.get(localPath);
		if (remotePath !== undefined) {
			this.controlCommand(entry, ['cancel', '-L', `${localPath}:${remotePath}`], 'stop forwarding the Codex socket');
			this.openedSocketForwards.delete(localPath);
		}
		try {
			unlinkSync(localPath);
		} catch {
			// 既に無ければそれでよい
		}
	}

	/** 戻り経路の接続へ、転送の足し引きを頼む（`ssh -O ...`）。 */
	private controlCommand(entry: ITunnelEntry, command: readonly string[], what: string): void {
		if (entry.controlPath === undefined) {
			return;
		}
		let child: ChildProcess;
		try {
			child = this.spawnSsh(['-S', entry.controlPath, '-O', ...command, entry.host]);
		} catch (error) {
			this.logService.warn(`[paradis] could not ${what} on ${entry.host}`, error);
			return;
		}
		child.on('error', error => this.logService.warn(`[paradis] could not ${what} on ${entry.host}`, error));
		child.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text.length > 0) {
				this.logService.warn(`[paradis] ${what} (${entry.host}): ${text}`);
			}
		});
		child.on('exit', code => {
			if (code === 0 && command[0] === 'forward') {
				this.openedSocketForwards.set(command[2].slice(0, command[2].indexOf(':')), command[2].slice(command[2].indexOf(':') + 1));
			}
		});
	}

	/**
	 * 制御ソケットの置き場。unix socket のパス長上限（約100バイト）に収まる必要があるため、
	 * 接続先の名前をそのまま使わず短いハッシュにする。
	 */
	private controlPathFor(remoteAuthority: string): string | undefined {
		if (this.runtimeDirectory === undefined) {
			return undefined;
		}
		const digest = createHash('sha256').update(remoteAuthority).digest('hex').slice(0, 12);
		const controlPath = join(this.runtimeDirectory, `ctl-${digest}.sock`);
		if (new TextEncoder().encode(controlPath).length > 100) {
			this.logService.warn('[paradis] the control socket path is too long; forwarding the Codex socket is unavailable');
			return undefined;
		}
		try {
			mkdirSync(this.runtimeDirectory, { recursive: true, mode: 0o700 });
			unlinkSync(controlPath);
		} catch {
			// 無ければそれでよい
		}
		return controlPath;
	}

	/**
	 * 接続先の Claude Code の版を尋ねる（`claude --version` の生の出力）。
	 *
	 * hook の一部は新しい版にしか無く、古い版は知らないキーごと設定を拒むことがある。手元では
	 * 同じことを `claude --version` で確かめてから入れているので、接続先でも同じ判断ができるように
	 * する。ログインシェル越しに実行するのは、`claude` が rc でしか PATH に入らない構成が多いため。
	 *
	 * 分からなければ undefined。その場合は「確認できた分だけ入れる」側に倒す。
	 */
	async claudeVersion(remoteAuthority: string): Promise<string | undefined> {
		const host = paradisSshHostFromAuthority(remoteAuthority);
		if (host === undefined) {
			return undefined;
		}
		const cached = this.claudeVersions.get(remoteAuthority);
		if (cached !== undefined && Date.now() - cached.at < CLAUDE_VERSION_TTL_MS) {
			return cached.version;
		}
		const version = await new Promise<string | undefined>(resolve => {
			let child: ChildProcess;
			try {
				// 引数は固定。ホスト名は authority の検証を通ったものだけが来る
				child = this.spawnSsh(['-o', 'BatchMode=yes', host, 'bash', '-lc', 'claude --version'], true);
			} catch (error) {
				this.logService.warn(`[paradis] could not ask ${host} which Claude Code it has`, error);
				resolve(undefined);
				return;
			}
			let output = '';
			child.on('error', () => resolve(undefined));
			child.stdout?.on('data', (chunk: Buffer) => {
				// 版の1行だけが要る。想定外に流れ続けても持ち続けない
				output = (output + chunk.toString()).slice(0, 1000);
			});
			child.on('exit', code => resolve(code === 0 && output.trim().length > 0 ? output.trim() : undefined));
		});
		this.claudeVersions.set(remoteAuthority, { version, at: Date.now() });
		return version;
	}

	/** テスト用。張られている接続先の一覧。 */
	get authorities(): readonly string[] {
		return [...this.tunnels.keys()];
	}
}

export function createParadisRemoteAgentTunnels(logService: ILogService, runtimeDirectory?: string): ParadisRemoteAgentTunnels & IDisposable {
	return new ParadisRemoteAgentTunnels(logService, undefined, runtimeDirectory);
}
