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
import { Emitter, Event } from '../../../../base/common/event.js';
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

/**
 * 接続先のシェルへ1語として渡すためのクォート。
 *
 * ssh は「ホスト名より後ろの引数」を空白で繋いで1本のコマンド文字列にしてから送り、接続先の
 * sshd がそれをログインシェルに実行させる。つまり argv へ分けて渡しても単語分割は防げない。
 * POSIX のシングルクォートは中身を一切解釈しないので、含まれる `'` だけを閉じ直して包む。
 */
export function paradisShellQuote(value: string): string {
	return `'${value.split(`'`).join(`'\\''`)}'`;
}

/** 1ウィンドウが同時に引ける Codex ソケットの上限。 */
const MAX_SOCKET_FORWARDS_PER_WINDOW = 8;

/** 落ちたときの再試行間隔。張り直しで ssh を叩き続けないよう、控えめに戻す。 */
const RETRY_DELAY_MS = 5000;

/** 接続先の Claude Code の版を聞き直す間隔。頻繁に変わるものではないので長めに持つ。 */
const CLAUDE_VERSION_TTL_MS = 30 * 60_000;

/**
 * 版が引けなかったときだけの、ずっと短い控えの寿命。
 *
 * 引けない理由は「接続先にまだ入れていない」「ログインシェルの設定がこれから整う」のように
 * 後から直るものが多い。成功と同じ30分持ってしまうと、その間ずっと版依存の hook を落としたまま
 * 書き続けることになり、実行状態が粗いままセッションが終わる。
 */
const CLAUDE_VERSION_FAILURE_TTL_MS = 2 * 60_000;

/**
 * 版を聞き直す回数の上限（この shared process が生きている間・接続先ごと）。
 *
 * 短い控えのままにすると、Claude Code を入れていない接続先へ「2分ごとに ssh を数本」を
 * 永遠に投げ続けることになる。手元の同じ処理も同じ数で打ち切っている。
 */
const MAX_CLAUDE_VERSION_PROBES = 3;

/**
 * 単発の ssh（実行権付与・版の問い合わせ）を待つ上限。
 *
 * TCP が張れたあとに経路だけ消えると、ssh は何も言わずぶら下がり続ける。呼び出し元はこれを
 * await しているので、戻らないと hook 設置のループごと止まってしまう。必ず有限時間で決着させる。
 */
const ONE_SHOT_SSH_TIMEOUT_MS = 15_000;

/** 単発の ssh に共通で付ける、固まらないためのオプション。 */
const ONE_SHOT_SSH_OPTIONS = [
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=10',
	'-o', 'ServerAliveInterval=5',
	'-o', 'ServerAliveCountMax=3',
];

const MAX_RETRIES = 3;

/**
 * `Allocated port ...` の通知が来ないまま待たせない上限。接続先の `~/.ssh/config` に
 * `LogLevel ERROR`/`QUIET` があると（`-o LogLevel=INFO` で通常は上書きされるが、念のため）
 * ssh は正常に繋がったまま何も書かないことがある。有限時間で諦めて再試行の輪へ戻す。
 */
const ALLOCATION_TIMEOUT_MS = 10_000;

/** 使い切って諦めてから、また試していいと判断するまでの待ち時間。 */
const EXHAUSTED_RETRY_COOLDOWN_MS = 30_000;

interface ITunnelEntry {
	readonly remoteAuthority: string;
	readonly host: string;
	/**
	 * この接続先を欲しがっているウィンドウ。同じホストへ何枚でも開けるので、最後の1枚が
	 * 外れるまで畳まない（1枚閉じただけで全員の経路が死ぬ、を起こさない）。
	 */
	readonly owners: Set<string>;
	/**
	 * **実際に張れている**転送（手元のパス → 接続先のパス）。差分判定はここを基準にする。
	 * 接続が切れたら丸ごと捨てる（新しいマスターは何も引き継いでいない）。
	 */
	readonly openedSocketForwards: Map<string, string>;
	/** `ssh -O forward` の返事待ち。同じ転送を二重に頼まないための目印。 */
	readonly inFlightSocketForwards: Set<string>;
	/**
	 * この接続へ転送の足し引きを頼むための制御ソケット。置き場が無い・長すぎる場合は undefined で、
	 * そのときは Codex ソケットの引き込みだけを諦める（**戻り経路は張る**。hook が届かなくなる
	 * ほうがずっと痛い）。
	 */
	readonly controlPath: string | undefined;
	child: ChildProcess | undefined;
	retries: number;
	retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** 割り当て通知を待つ上限。番号が分かる・接続が終わるのどちらかで必ず片付ける。 */
	allocationTimer: ReturnType<typeof setTimeout> | undefined;
	disposed: boolean;
	/** 接続先で実際に割り当てられた番号。張れていない・切れている間は undefined。 */
	remotePort: number | undefined;
	/** 今回の接続試行の決着を待っている呼び出し元。複数の呼び出しが同じ結果を共有する。 */
	pending: Array<(port: number | undefined) => void>;
	/** 再試行を使い切って、この接続先はもう追い直さないと決めた状態。 */
	exhausted: boolean;
	/** 使い切った時刻。`EXHAUSTED_RETRY_COOLDOWN_MS` 経ったら追い直しを許す。 */
	exhaustedAt: number | undefined;
}

/**
 * 接続先ごとに `ssh -N -R 0:127.0.0.1:<port>` を1本維持する。
 *
 * 接続先で開くポートは固定番号ではなく、その都度 sshd に選ばせる動的な番号にする。
 * 同じ接続先ホストへ複数ユーザーの Para Code が同時に SSH するとき（例: 共有の開発サーバー）、
 * 全員が同じ既定ポートで戻りトンネルを張ろうとすると、先に繋いだ人だけが成功し、
 * 後から繋いだ人は `remote port forwarding failed for listen port <固定番号>` で
 * 恒久的に失敗する（実機で確認済み）。動的ポートなら sshd が空いている番号を選ぶので衝突しない。
 * 割り当てられた番号は ssh の stderr に出る `Allocated port <N> for remote forward to ...` を読んで拾う。
 */
export class ParadisRemoteAgentTunnels extends Disposable {

	private readonly tunnels = new Map<string, ITunnelEntry>();
	/** 接続先ごとの Claude Code の版。ssh を毎回叩かないための控え。 */
	private readonly claudeVersions = new Map<string, { readonly version: string | undefined; readonly at: number; readonly probes: number }>();
	/** ウィンドウ → そのウィンドウが欲しがっている転送（接続先ごと・手元のパス → 接続先のパス）。 */
	private readonly socketForwardOwners = new Map<string, { readonly remoteAuthority: string; readonly wanted: ReadonlyMap<string, string> }>();

	/** 接続先で割り当てられた番号が変わったことを知らせる（張り直しのたびに変わる）。 */
	private readonly _onDidChangePort = this._register(new Emitter<{ readonly remoteAuthority: string; readonly port: number | undefined }>());
	readonly onDidChangePort: Event<{ readonly remoteAuthority: string; readonly port: number | undefined }> = this._onDidChangePort.event;

	private readonly spawnSsh: (args: string[], captureOutput?: boolean) => ChildProcess;
	/**
	 * ログインシェル由来の環境。Dock/Finder から起動した Electron の環境には `~/.zshrc` 等で
	 * 設定される `SSH_AUTH_SOCK` が入らないため、1Password や gpg-agent を鍵の出し手にしている
	 * 構成では公開鍵認証が黙って失敗する。解決できるまでは素の環境で動く（解決は起動直後に始め、
	 * 間に合わなかった試行も既定の再試行でやり直される）。
	 */
	private sshEnv: NodeJS.ProcessEnv | undefined;

	constructor(
		private readonly logService: ILogService,
		// shared process の PATH は端末のそれとは限らないので、素の `ssh` が引けないときのために
		// 標準の場所も見る（macOS / Linux とも /usr/bin/ssh）。
		// 出力が要る用途（版の問い合わせ）だけ stdout を受ける。トンネル側は読み手が居ないので、
		// 繋いだままにするとパイプが詰まって固まりうる。
		spawnSsh: ((args: string[], captureOutput?: boolean) => ChildProcess) | undefined = undefined,
		/** 制御ソケットを置く場所。無ければ Codex ソケットの引き込みだけを諦める。 */
		private readonly runtimeDirectory: string | undefined = undefined,
		/** ログインシェル由来の環境の解決。渡されなければ shared process の素の環境で ssh を起こす。 */
		resolveSshEnv: (() => Promise<NodeJS.ProcessEnv>) | undefined = undefined,
	) {
		super();
		this.spawnSsh = spawnSsh ?? ((args, captureOutput) => spawn(
			existsSync('/usr/bin/ssh') ? '/usr/bin/ssh' : 'ssh',
			args,
			{ stdio: ['ignore', captureOutput === true ? 'pipe' : 'ignore', 'pipe'], env: this.sshEnv }
		));
		if (resolveSshEnv !== undefined) {
			void resolveSshEnv().then(env => {
				if (!this._store.isDisposed) {
					this.sshEnv = env;
				}
			}, error => this.logService.warn('[paradis] could not resolve the login shell environment for ssh', error));
		}
		this._register(toDisposable(() => {
			for (const owner of [...this.socketForwardOwners.keys()]) {
				this.socketForwardOwners.delete(owner);
			}
			for (const authority of [...this.tunnels.keys()]) {
				this.close(authority);
			}
		}));
	}

	/**
	 * 接続先への経路を用意する。既にあれば（張れていても、まだ試行中でも）その結果に相乗りする。
	 * @param owner どのウィンドウの求めか。同じ接続先へ複数のウィンドウが繋いでいるとき、
	 * 1枚閉じただけで全員の経路を畳まないために数えておく。
	 * @returns 接続先で実際に割り当てられた番号。張れなかった／使い切って諦めた場合は undefined
	 */
	ensure(remoteAuthority: string, port: number, owner?: string): Promise<number | undefined> {
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			return Promise.resolve(undefined);
		}
		const host = paradisSshHostFromAuthority(remoteAuthority);
		if (host === undefined) {
			// SSH 以外の接続先（コンテナ等）は対象外。静かに諦める
			return Promise.resolve(undefined);
		}
		const existing = this.tunnels.get(remoteAuthority);
		if (existing !== undefined && !existing.disposed) {
			if (owner !== undefined) {
				existing.owners.add(owner);
			}
			if (existing.remotePort !== undefined) {
				return Promise.resolve(existing.remotePort);
			}
			if (existing.exhausted) {
				if (existing.exhaustedAt !== undefined && Date.now() - existing.exhaustedAt < EXHAUSTED_RETRY_COOLDOWN_MS) {
					// 諦めてからまだ間もない。ここで待たせても誰も起こしてくれない
					return Promise.resolve(undefined);
				}
				// 十分待った。仕切り直す。resolver を pending へ積んでから start() を呼ぶこと
				// （逆にすると、spawn が同期的に失敗する経路で settle() が空の pending を空振りし、
				// この呼び出しの resolver だけ誰にも解決されず取り残される）
				existing.exhausted = false;
				existing.exhaustedAt = undefined;
				existing.retries = 0;
				const restarted = new Promise<number | undefined>(resolve => existing.pending.push(resolve));
				this.start(remoteAuthority, existing, port);
				return restarted;
			}
			return new Promise(resolve => existing.pending.push(resolve));
		}
		const entry: ITunnelEntry = {
			remoteAuthority, host, owners: new Set(owner !== undefined ? [owner] : []),
			openedSocketForwards: new Map(), inFlightSocketForwards: new Set(),
			controlPath: this.controlPathFor(remoteAuthority), child: undefined, retries: 0, retryTimer: undefined,
			allocationTimer: undefined, disposed: false, remotePort: undefined, pending: [], exhausted: false, exhaustedAt: undefined,
		};
		this.tunnels.set(remoteAuthority, entry);
		// resolver を pending へ積んでから start() を呼ぶこと（理由は上記コメントと同じ）
		const result = new Promise<number | undefined>(resolve => entry.pending.push(resolve));
		this.start(remoteAuthority, entry, port);
		return result;
	}

	/** 決着（成功／今回の試行の失敗）を、待っている全員へ配る。 */
	private settle(entry: ITunnelEntry, port: number | undefined): void {
		if (entry.allocationTimer !== undefined) {
			clearTimeout(entry.allocationTimer);
			entry.allocationTimer = undefined;
		}
		const changed = entry.remotePort !== port;
		entry.remotePort = port;
		const pending = entry.pending;
		entry.pending = [];
		for (const resolve of pending) {
			resolve(port);
		}
		if (changed) {
			// 番号は張り直しのたびに変わる。接続先のポートファイルを書き換える側が30秒ごとの
			// 見直しで気付くのを待っていると、その間の通知（承認待ち・完了）が丸ごと消える
			this._onDidChangePort.fire({ remoteAuthority: entry.remoteAuthority, port });
		}
		if (port !== undefined) {
			// 新しいマスターは前の `-L` を何も引き継いでいない。欲しがられている転送を張り直す
			this.applySocketForwards(entry);
		}
	}

	/**
	 * 接続が切れたとき（ウィンドウが閉じた・別の接続先へ移った）に畳む。
	 *
	 * @param owner どのウィンドウが手を引いたか。同じ接続先を他のウィンドウがまだ使っている間は
	 * 畳まない（1枚閉じただけで他のウィンドウの hook まで止まるのを避ける）。省略すると無条件に畳む。
	 */
	close(remoteAuthority: string, owner?: string): void {
		const entry = this.tunnels.get(remoteAuthority);
		if (entry === undefined) {
			return;
		}
		if (owner !== undefined) {
			entry.owners.delete(owner);
			if (entry.owners.size > 0) {
				return;
			}
		}
		entry.disposed = true;
		if (entry.retryTimer !== undefined) {
			clearTimeout(entry.retryTimer);
			entry.retryTimer = undefined;
		}
		entry.child?.kill();
		entry.child = undefined;
		// マスターごと落ちるので転送も一緒に消える。手元に残るソケットのファイルだけ片付ける
		for (const localPath of entry.openedSocketForwards.keys()) {
			try {
				unlinkSync(localPath);
			} catch {
				// 既に無ければそれでよい
			}
		}
		entry.openedSocketForwards.clear();
		entry.inFlightSocketForwards.clear();
		this.settle(entry, undefined);
		this.tunnels.delete(remoteAuthority);
	}

	private start(remoteAuthority: string, entry: ITunnelEntry, port: number): void {
		const args = [
			'-N',
			// 固定番号ではなく sshd に選ばせる。同じホストへ複数ユーザーが同時に繋ぐ共有サーバーで、
			// 全員が同じ番号を取り合って後勝ちの人だけ弾かれ続ける事故を避けるため
			'-R', `0:127.0.0.1:${port}`,
			// Codex ペインのソケットを後から足し引きするための制御口。接続そのものは1本のまま
			// にしたいので、ペインごとに ssh を起こさずここへ相乗りさせる
			...(entry.controlPath !== undefined ? ['-M', '-S', entry.controlPath, '-o', 'ControlPersist=no'] : []),
			// パスフレーズや初見ホストの確認で固まらせない。鍵は ssh-agent 側で解決される
			'-o', 'BatchMode=yes',
			// ポートを取れなかったら黙って繋がったままにせず終了させる
			'-o', 'ExitOnForwardFailure=yes',
			// 割り当てられた番号を知らせる `Allocated port ...` 行は INFO レベルで出る。接続先の
			// `~/.ssh/config` が LogLevel を絞っていても、コマンドライン引数は config より優先されるので
			// ここで強制する
			'-o', 'LogLevel=INFO',
			'-o', 'ServerAliveInterval=30',
			'-o', 'ServerAliveCountMax=3',
			entry.host,
		];

		let child: ChildProcess;
		try {
			child = this.spawnSsh(args);
		} catch (error) {
			this.logService.warn(`[paradis] could not start the return tunnel to ${entry.host}`, error);
			// 呼び出し元が来た結果を無期限に待つ状態のまま entry だけ残ることを防ぐ。
			// 呼び出し元自身が今後 ensure() し直せば、既定のクールダウン後にまた試せる
			entry.exhausted = true;
			entry.exhaustedAt = Date.now();
			this.settle(entry, undefined);
			return;
		}
		entry.child = child;

		// 割り当て通知が来ないまま（LogLevel が絞られている等）待たせ続けない。番号が分かるか
		// 接続が終わるかのどちらかが先に起きるので、ここでは「終わらせる」側を受け持つ
		entry.allocationTimer = setTimeout(() => {
			entry.allocationTimer = undefined;
			if (!entry.disposed && entry.remotePort === undefined) {
				entry.child?.kill();
			}
		}, ALLOCATION_TIMEOUT_MS);

		// spawn は起動できなくても例外を投げず、この event でだけ知らせてくる。購読しないと
		// 「ssh が PATH に無い」が黙って捨てられ、張れていないのに何も分からなくなる。
		// spawn 失敗時は 'exit' が発火しないことがあるため、後始末は 'close' 側でまとめて行う
		child.on('error', error => {
			this.logService.warn(`[paradis] the return tunnel to ${entry.host} could not start (is ssh on PATH?)`, error);
		});

		// ssh の stderr は失敗理由（鍵無し等）に加え、動的ポートで割り当てられた番号
		// （`Allocated port <N> for remote forward to 127.0.0.1:<port>`）が出る唯一の場所なので拾っておく。
		// チャンクは行境界と無関係に届くため、行単位に組み直してから調べる
		let stderrBuffer = '';
		const allocatedPortPattern = new RegExp(`^Allocated port (\\d+) for remote forward to 127\\.0\\.0\\.1:${port}$`);
		child.stderr?.on('data', (chunk: Buffer) => {
			stderrBuffer += chunk.toString();
			let newlineIndex: number;
			while ((newlineIndex = stderrBuffer.indexOf('\n')) >= 0) {
				const line = stderrBuffer.slice(0, newlineIndex).trim();
				stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
				if (line.length === 0) {
					continue;
				}
				const allocated = allocatedPortPattern.exec(line);
				if (allocated !== null) {
					this.logService.info(`[paradis] return tunnel (${entry.host}): ${line}`);
					const remotePort = Number(allocated[1]);
					if (Number.isInteger(remotePort) && remotePort > 0 && remotePort <= 65535) {
						entry.retries = 0; // 一度でも張れたら、次に切れたときはまた最初から数え直す
						this.settle(entry, remotePort);
					}
				} else {
					this.logService.warn(`[paradis] return tunnel (${entry.host}): ${line}`);
				}
			}
		});

		child.on('close', code => {
			if (entry.allocationTimer !== undefined) {
				clearTimeout(entry.allocationTimer);
				entry.allocationTimer = undefined;
			}
			entry.child = undefined;
			// 張れていた経路が死んだ。古い番号のまま使わせない
			entry.remotePort = undefined;
			// マスターが死ぬと `-L` の転送も道連れになる。次のマスターは何も引き継いでいないので、
			// 「張れている」控えを空にして、繋がり直したときに全部張り直させる
			entry.openedSocketForwards.clear();
			entry.inFlightSocketForwards.clear();
			if (entry.disposed) {
				return;
			}
			if (entry.retries >= MAX_RETRIES) {
				this.logService.warn(`[paradis] gave up on the return tunnel to ${entry.host} (last exit code ${code})`);
				entry.exhausted = true;
				entry.exhaustedAt = Date.now();
				this.settle(entry, undefined);
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
	 * ここだけ ssh を短く1回叩く。
	 *
	 * **渡した引数はシェルを経由する**。ssh クライアントは残りの引数を空白で繋いで1本の文字列に
	 * してから送り、接続先の sshd がそれをログインシェルに実行させるため、パスは単語分割も
	 * メタ文字の解釈も受ける。接続先のホームが `/Users/john doe` のような場所だと、素で渡すと
	 * 別のファイルを触る（多くは何も見つからず失敗する）ので、必ずクォートしてから渡す。
	 */
	async chmodExecutable(remoteAuthority: string, path: string): Promise<boolean> {
		const host = paradisSshHostFromAuthority(remoteAuthority);
		if (host === undefined || !path.startsWith('/')) {
			return false;
		}
		const result = await this.runOneShotSsh([host, 'chmod', '+x', paradisShellQuote(path)], false, `chmod ${path} on ${host}`);
		return result.code === 0;
	}

	/**
	 * 単発の ssh を起こし、**終了か時間切れのどちらかで必ず**決着させる。
	 *
	 * 呼び出し元はこれを await しているので、戻らないと hook 設置のループごと止まる。TCP が
	 * 張れたあとに経路だけ消えた ssh は何も言わずぶら下がり続けるため、時間切れで殺して先へ進む。
	 */
	private runOneShotSsh(args: readonly string[], captureOutput: boolean, what: string): Promise<{ readonly code: number | null; readonly output: string }> {
		return new Promise(resolve => {
			let settled = false;
			let output = '';
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (code: number | null) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				resolve({ code, output: output.trim() });
			};
			let child: ChildProcess;
			try {
				child = this.spawnSsh([...ONE_SHOT_SSH_OPTIONS, ...args], captureOutput);
			} catch (error) {
				this.logService.warn(`[paradis] could not ${what}`, error);
				settle(null);
				return;
			}
			timer = setTimeout(() => {
				this.logService.warn(`[paradis] gave up waiting for ssh to ${what}`);
				child.kill();
				settle(null);
			}, ONE_SHOT_SSH_TIMEOUT_MS);
			child.on('error', error => {
				this.logService.warn(`[paradis] could not ${what}`, error);
				settle(null);
			});
			child.stdout?.on('data', (chunk: Buffer) => {
				// 版の1行だけが要る。想定外に流れ続けても持ち続けない
				output = (output + chunk.toString()).slice(0, 1000);
			});
			child.on('exit', code => settle(code));
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
	 * 戻り経路がまだ無いときは要求を覚えるだけにして、張れた時点でまとめて引き込む。
	 *
	 * @param owner どのウィンドウの要求か。ウィンドウは同じ接続先へ何枚でも開けるので、
	 * 自分の要求だけを差し替える（他のウィンドウのぶんまで畳むと、相手のペインが黙って死ぬ）。
	 */
	syncSocketForwards(owner: string, remoteAuthority: string, wanted: ReadonlyMap<string, string>): void {
		if (wanted.size > MAX_SOCKET_FORWARDS_PER_WINDOW) {
			this.logService.warn(`[paradis] too many Codex panes to forward (${wanted.size}); keeping the first ${MAX_SOCKET_FORWARDS_PER_WINDOW}`);
			wanted = new Map([...wanted].slice(0, MAX_SOCKET_FORWARDS_PER_WINDOW));
		}
		// 要求はトンネルが張れているかに関わらず覚えておく。張れていない間に捨ててしまうと、
		// 繋がったあとに誰も張り直さない（ペインが増減するまで直らない）
		if (wanted.size === 0) {
			this.socketForwardOwners.delete(owner);
		} else {
			this.socketForwardOwners.set(owner, { remoteAuthority, wanted: new Map(wanted) });
		}
		const entry = this.tunnels.get(remoteAuthority);
		if (entry !== undefined) {
			this.applySocketForwards(entry);
		}
	}

	/**
	 * そのウィンドウが持っていたものを全て手放す（ウィンドウが destroy された）。
	 *
	 * 取り下げの知らせはウィンドウ側の dispose から投げっぱなしで送られるだけなので、クラッシュや
	 * 終了中の切断では普通に届かない。届かないまま希望一覧に残ると、次に同じ接続先へ別のウィンドウが
	 * 繋いだ瞬間、**死んだウィンドウのソケットまで張り直してしまう**（枠も食う）。所有者が消えたことが
	 * 確かに分かった時点で、ここから一括で外す。
	 */
	releaseWindow(owner: string): void {
		this.releaseSocketForwards(owner);
		for (const [remoteAuthority, entry] of [...this.tunnels]) {
			if (entry.owners.has(owner)) {
				this.close(remoteAuthority, owner);
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
		const entry = this.tunnels.get(previous.remoteAuthority);
		if (entry !== undefined) {
			this.applySocketForwards(entry);
		}
	}

	/**
	 * 「欲しがられている転送」と「実際に張れている転送」の差を埋める。
	 *
	 * 基準を希望一覧の差分に置くと、`ssh -O forward` が失敗しても希望一覧には載ってしまい、
	 * 以後まったく同じ希望が来ても差分ゼロで再発行されない。マスターが張り直されたあとも同じで、
	 * 転送が全部消えているのに誰も気付けない。**実際に張れている一覧**を基準にすればどちらも直る。
	 */
	private applySocketForwards(entry: ITunnelEntry): void {
		// 接続そのものが無い間は頼む先も無い（再試行の待ち時間中など）。要求は覚えたままなので、
		// 繋がった時点の settle() からここへ戻ってきてまとめて張られる
		if (entry.disposed || entry.controlPath === undefined || entry.child === undefined) {
			return;
		}
		const desired = new Map<string, string>();
		for (const owner of this.socketForwardOwners.values()) {
			if (owner.remoteAuthority !== entry.remoteAuthority) {
				continue;
			}
			for (const [localPath, remotePath] of owner.wanted) {
				desired.set(localPath, remotePath);
			}
		}
		for (const [localPath, remotePath] of [...entry.openedSocketForwards]) {
			if (desired.get(localPath) !== remotePath) {
				this.dropSocketForward(entry, localPath);
			}
		}
		for (const [localPath, remotePath] of desired) {
			if (entry.openedSocketForwards.get(localPath) === remotePath || entry.inFlightSocketForwards.has(localPath)) {
				continue;
			}
			this.openSocketForward(entry, localPath, remotePath);
		}
	}

	private openSocketForward(entry: ITunnelEntry, localPath: string, remotePath: string): void {
		// ssh は既にあるファイルへは listen しない。前回の残骸を先に片付ける
		try {
			mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
			unlinkSync(localPath);
		} catch {
			// 無ければそれでよい
		}
		entry.inFlightSocketForwards.add(localPath);
		this.controlCommand(entry, ['forward', '-L', `${localPath}:${remotePath}`], 'forward the Codex socket', code => {
			entry.inFlightSocketForwards.delete(localPath);
			if (code !== 0) {
				// 張れなかったものは控えない。ここで張り直しに戻ると失敗し続ける相手を叩き続けるので、
				// やり直しは次の同期かマスターの張り直しに任せる
				return;
			}
			// 張れたものだけを控える
			entry.openedSocketForwards.set(localPath, remotePath);
			// 返事を待っている間にペインが閉じた／別の宛先に変わったかもしれない。待っている転送は
			// 取り下げの判断材料（`openedSocketForwards`）に載っていないので、ここで見直さないと
			// 誰も欲しがっていない転送が張られたまま残る
			this.applySocketForwards(entry);
		});
	}

	private dropSocketForward(entry: ITunnelEntry, localPath: string): void {
		const remotePath = entry.openedSocketForwards.get(localPath);
		if (remotePath !== undefined) {
			this.controlCommand(entry, ['cancel', '-L', `${localPath}:${remotePath}`], 'stop forwarding the Codex socket');
			entry.openedSocketForwards.delete(localPath);
		}
		try {
			unlinkSync(localPath);
		} catch {
			// 既に無ければそれでよい
		}
	}

	/**
	 * 戻り経路の接続へ、転送の足し引きを頼む（`ssh -O ...`）。
	 * @param onSettled 終了コード。起こせなかった・'error' で終わった場合は null（一度だけ呼ばれる）
	 */
	private controlCommand(entry: ITunnelEntry, command: readonly string[], what: string, onSettled?: (code: number | null) => void): void {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settle = (code: number | null) => {
			if (!settled) {
				settled = true;
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				onSettled?.(code);
			}
		};
		if (entry.controlPath === undefined) {
			settle(null);
			return;
		}
		let child: ChildProcess;
		try {
			child = this.spawnSsh(['-S', entry.controlPath, '-O', ...command, entry.host]);
		} catch (error) {
			this.logService.warn(`[paradis] could not ${what} on ${entry.host}`, error);
			settle(null);
			return;
		}
		// マスターが詰まると `-O` も返ってこない。返事待ちのまま抱え込むと、その転送は二度と
		// 張り直されないので、有限時間で諦めて次の同期に委ねる
		timer = setTimeout(() => {
			this.logService.warn(`[paradis] gave up waiting for ssh to ${what} on ${entry.host}`);
			child.kill();
			settle(null);
		}, ONE_SHOT_SSH_TIMEOUT_MS);
		child.on('error', error => {
			this.logService.warn(`[paradis] could not ${what} on ${entry.host}`, error);
			settle(null);
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text.length > 0) {
				this.logService.warn(`[paradis] ${what} (${entry.host}): ${text}`);
			}
		});
		child.on('exit', code => settle(code));
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
	 * ただし**そのシェルが bash とは限らない**。zsh / fish を使う接続先で `bash -lc` に決め打つと、
	 * PATH がそちらの rc にしか無いために毎回引けない。接続先が自分で名乗るシェル（`$SHELL`）を
	 * 先に試し、そこから素の実行まで順に落として、どれかで引けたらそれを使う。
	 *
	 * 分からなければ undefined。その場合は「確認できた分だけ入れる」側に倒す。引けなかったことは
	 * ずっと短い時間しか覚えないが（接続先に入れた・PATH を直したのが後から効くようにする）、
	 * 何度も外したら諦める（Claude Code を入れていない接続先を延々と叩き続けないため）。
	 */
	async claudeVersion(remoteAuthority: string): Promise<string | undefined> {
		const host = paradisSshHostFromAuthority(remoteAuthority);
		if (host === undefined) {
			return undefined;
		}
		const cached = this.claudeVersions.get(remoteAuthority);
		if (cached !== undefined) {
			if (cached.version !== undefined) {
				if (Date.now() - cached.at < CLAUDE_VERSION_TTL_MS) {
					return cached.version;
				}
			} else if (cached.probes >= MAX_CLAUDE_VERSION_PROBES || Date.now() - cached.at < CLAUDE_VERSION_FAILURE_TTL_MS) {
				return undefined;
			}
		}
		const probes = (cached?.probes ?? 0) + 1;
		// 引数は固定。ホスト名は authority の検証を通ったものだけが来る
		const attempts: readonly (readonly string[])[] = [
			// 接続先のログインシェルそのもの。zsh / fish でも `-lc` は同じ意味で通る
			[host, 'sh', '-c', paradisShellQuote('exec "${SHELL:-/bin/sh}" -lc "claude --version"')],
			// $SHELL が無い・そちらでは引けない構成向け。PATH を bash のログインファイルに
			// 書いている接続先はこれで拾える
			[host, 'bash', '-lc', paradisShellQuote('claude --version')],
			// ログインファイルを読まずとも PATH に居る（システムに入れてある）場合の最後の頼み
			[host, 'claude', '--version'],
		];
		let version: string | undefined;
		for (const args of attempts) {
			const result = await this.runOneShotSsh(args, true, `ask ${host} which Claude Code it has`);
			if (result.code === 0 && result.output.length > 0) {
				version = result.output;
				break;
			}
		}
		this.claudeVersions.set(remoteAuthority, { version, at: Date.now(), probes });
		if (version === undefined && probes >= MAX_CLAUDE_VERSION_PROBES) {
			this.logService.warn(`[paradis] could not tell which Claude Code ${host} has after ${probes} tries; not asking again`);
		}
		return version;
	}

	/** テスト用。張られている接続先の一覧。 */
	get authorities(): readonly string[] {
		return [...this.tunnels.keys()];
	}
}

export function createParadisRemoteAgentTunnels(logService: ILogService, runtimeDirectory?: string, resolveSshEnv?: () => Promise<NodeJS.ProcessEnv>): ParadisRemoteAgentTunnels & IDisposable {
	return new ParadisRemoteAgentTunnels(logService, undefined, runtimeDirectory, resolveSshEnv);
}
