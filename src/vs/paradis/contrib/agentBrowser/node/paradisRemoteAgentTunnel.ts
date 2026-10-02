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
import { existsSync } from 'fs';
import { hostname, userInfo } from 'os';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisSshHostFromAuthority } from '../../../common/paradisHostPath.js';

// かつてこのファイルにあった paradisSshHostFromAuthority は、browser 側（コマンドプリセットの
// 実行環境条件）でも必要になったため common へ移した。既存の import 経路を壊さないよう再エクスポートする。
export { paradisSshHostFromAuthority };

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
 * 確認（動的なら `Allocated port ...`、固定候補なら `remote forward success for: ...`）が
 * 来ないまま待たせない上限。TCP 接続や認証に時間がかかる（到達性の悪い回線・鍵の解決待ち）
 * だけでなく、接続先の `~/.ssh/config` に `LogLevel ERROR`/`QUIET` があると
 * （`-o LogLevel=...` で通常は上書きされるが、念のため）ssh が正常に繋がったまま何も書かない
 * こともある。確認が無い間は「まだ張れていない」として扱い、有限時間で諦めて再試行の輪へ戻す
 * （＝確認が無いことを「張れた」とはみなさない）。
 */
const ALLOCATION_TIMEOUT_MS = 10_000;

/** 使い切って諦めてから、また試していいと判断するまでの待ち時間。 */
const EXHAUSTED_RETRY_COOLDOWN_MS = 30_000;

/**
 * 決定的候補ポートの範囲。Linux の既定の ephemeral 範囲（`net.ipv4.ip_local_port_range`
 * の既定値 32768-60999）と重ねると、接続先の無関係な outbound 接続に一時的に取られて
 * bind に失敗する頻度が上がってしまう。well-known（0-1023）でも Linux の既定 ephemeral でも
 * ない帯を使う（IANA registered の帯なので、開発機で使われがちな個別のサービスのポートと
 * 当たる余地は残るが、その場合も動的割当てへフォールバックするだけで実害は無い）。
 */
const CANDIDATE_PORT_BASE = 20_000;
const CANDIDATE_PORT_RANGE = 32_768 - CANDIDATE_PORT_BASE;

/**
 * 接続先で優先的に使う戻りトンネルのリッスンポートを、ローカルのユーザー名・ホスト名と
 * 接続先のホストから決定的に計算する。
 *
 * 毎回 sshd に選ばせる完全動的な番号だと、SSH の張り直しのたびに番号が変わり、接続先の
 * MCP / hook 設定ファイルの書き換えと、それを読んでいる側（エージェントCLI）の再接続が
 * そのたびに必要になる。同じユーザーが同じホストへ繋ぐ限り毎回同じ番号になれば、番号が変わるのは
 * 「他の誰か（別ユーザー・別プロセス）が偶然同じ番号を先に取っていた」ときだけに減らせる。
 * 衝突したときは start() 側が動的割当てへフォールバックする（下記 useDynamicPort 参照）。
 *
 * ローカルのホスト名も混ぜているのは、ユーザー名だけだと `ubuntu` / `dev` のような使われがちな
 * 名前で別のマシンの利用者同士が毎回確実に衝突してしまうため。ホスト名が加われば、同じユーザー名
 * でもマシンが違えば別の候補になり、衝突は「本当に同じマシン・同じユーザーが二重に繋いだ」場合に
 * ほぼ限られる。
 *
 * 注意: macOS の `os.hostname()` は DHCP 由来（`Foo.local` 等）でネットワークを移ると変わる
 * ことがある。変わればこの関数の返り値も変わり、「番号を安定させる」という狙いは部分的に崩れるが、
 * それでも動的割当てへのフォールバックが必ず効くので、張れなくなることはない。
 */
export function computeCandidateRemotePort(host: string): number {
	// uid に対応する passwd エントリが無い環境（コンテナの --user 指定等）では os.userInfo() が、
	// まれに uv_os_gethostname が失敗する環境では os.hostname() も例外を投げうる。
	// この関数は ensure() からの同期呼びだけでなく retryTimer のコールバックからも呼ばれるため
	// （後者で投げると未捕捉例外として shared process へ上がる）、丸ごと守る。
	// 「失敗しても投げない」という設計を守るため、代わりの手がかりで我慢する
	// （決定的でありさえすればよく、一意性は必須ではない）
	let identity: string;
	try {
		identity = `${userInfo().username}@${hostname()}`;
	} catch {
		identity = `${process.env['USER'] ?? process.env['LOGNAME'] ?? 'para-code'}@${process.env['HOSTNAME'] ?? 'para-code'}`;
	}
	const digest = createHash('sha256').update(`${identity}@${host}`).digest();
	return CANDIDATE_PORT_BASE + (digest.readUInt16BE(0) % CANDIDATE_PORT_RANGE);
}

interface ITunnelEntry {
	readonly remoteAuthority: string;
	readonly host: string;
	/**
	 * この接続先を欲しがっているウィンドウ。同じホストへ何枚でも開けるので、最後の1枚が
	 * 外れるまで畳まない（1枚閉じただけで全員の経路が死ぬ、を起こさない）。
	 */
	readonly owners: Set<string>;
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
	/**
	 * 直近の試行で決定的候補が使用中で弾かれ、動的割当てへ切り替えた状態なら true。
	 * 通常の切断（`retryImmediately` を伴わない close）を1回でも経ると false に戻す
	 * （一時的な ephemeral ポートの衝突だっただけかもしれないので、次の接続でまた候補から試す）。
	 */
	useDynamicPort: boolean;
	/**
	 * 決定的候補が使用中で弾かれた直後の close を、通常の切断（再試行の待ち時間を置く）と
	 * 区別するための目印。立っていれば、待たずに動的割当てで張り直す（リトライ回数も消費しない）。
	 */
	retryImmediately: boolean;
	/**
	 * 直近の試行で、確認（成功・失敗どちらの信号）も来ないまま `ALLOCATION_TIMEOUT_MS` で
	 * 諦めたなら true。次の通常リトライで動的割当てへ切り替える判断材料にする
	 * （OpenSSH 以外の実装・DEBUG1 が抑止される構成など、固定候補の正の確認信号が
	 * 構造的に得られない相手に対して、確認の出方がより確実な動的割当てへ逃がすための退路）。
	 */
	timedOutWaitingForConfirmation: boolean;
}

/**
 * 接続先ごとに `ssh -N -R <listenPort>:127.0.0.1:<gatewayPort>` を1本維持する。
 * `listenPort` は接続先で開くポート、`gatewayPort` は手元の MCP / hook ゲートウェイのポート
 * （呼び出し元が渡す `port`）で、この2つは別の値になる。
 *
 * 接続先で開くポートは、まずユーザー名とホストから決めた候補（`computeCandidateRemotePort()`）を
 * 試す。同じユーザーが同じホストへ繋ぐ限り毎回同じ番号になるので、MCP / hook 設定ファイルの
 * 書き換えとエージェントCLI側の再接続が、番号が変わるたびに必要になる事態を避けられる。
 *
 * 候補が使用中なら、`ssh -N -R <固定番号>:...` は `remote port forwarding failed for listen
 * port <固定番号>` を出して終了する（実機で確認済み）。同じ接続先ホストへ複数ユーザーの Para Code
 * が同時に SSH するとき（例: 共有の開発サーバー）、全員が同じ既定ポートで固定して戻りトンネルを
 * 張ろうとすると、先に繋いだ人だけが成功し後から繋いだ人は恒久的に失敗する事故が起きる。
 * このため候補が弾かれたら、その接続に限って `ssh -N -R 0:...` に切り替え、sshd に空いている
 * 番号を選ばせる（衝突しない代わり、毎回番号が変わる）。通常の切断を1回でも経ると、次はまた
 * 決定的候補から試す（一時的な衝突だっただけかもしれないので、粘着させすぎない）。
 *
 * 割り当てられた番号は ssh の stderr から拾う。動的割当てでは `Allocated port <N> for
 * remote forward to ...` が常に出る。固定候補は既定の LogLevel では成功時に何も出さないため、
 * 固定候補を試すときだけ `LogLevel=DEBUG1` に上げ、`remote forward success for: listen <N>` を
 * 正の確認信号として使う（「一定時間エラーが来なければ張れたとみなす」という推定はしない。
 * 到達不能なホストや認証に時間がかかる構成では、エラーが来る前に時間切れになって「張れた」と
 * 誤判定し続け、諦めるべきところで諦められなくなるため）。
 */
export class ParadisRemoteAgentTunnels extends Disposable {

	private readonly tunnels = new Map<string, ITunnelEntry>();
	/** 接続先ごとの Claude Code の版。ssh を毎回叩かないための控え。 */
	private readonly claudeVersions = new Map<string, { readonly version: string | undefined; readonly at: number; readonly probes: number }>();

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
			for (const authority of [...this.tunnels.keys()]) {
				this.close(authority);
			}
		}));
	}

	/** 今張れている戻り経路の、接続先で割り当てられた番号（張りには行かない）。 */
	currentPort(remoteAuthority: string): number | undefined {
		const entry = this.tunnels.get(remoteAuthority);
		return entry !== undefined && !entry.disposed ? entry.remotePort : undefined;
	}

	/**
	 * その接続先への戻り経路を張っている `ssh`（`-R` の本体）の PID。張れていなければ undefined。
	 * 戻り経路から来た接続（接続先の hook と MCP）は、手元ではこのプロセスが相手になるので、
	 * 接続元の確認はこの PID との一致で行う。
	 */
	processPidFor(remoteAuthority: string): number | undefined {
		const pid = this.tunnels.get(remoteAuthority)?.child?.pid;
		return typeof pid === 'number' && pid > 0 ? pid : undefined;
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
				// 十分に間を置いたので、決定的候補が今度は空いているかもしれない。もう一度試す
				existing.useDynamicPort = false;
				const restarted = new Promise<number | undefined>(resolve => existing.pending.push(resolve));
				this.start(remoteAuthority, existing, port);
				return restarted;
			}
			return new Promise(resolve => existing.pending.push(resolve));
		}
		const entry: ITunnelEntry = {
			remoteAuthority, host, owners: new Set(owner !== undefined ? [owner] : []),
			child: undefined, retries: 0, retryTimer: undefined,
			allocationTimer: undefined, disposed: false, remotePort: undefined, pending: [], exhausted: false, exhaustedAt: undefined,
			useDynamicPort: false, retryImmediately: false, timedOutWaitingForConfirmation: false,
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
		this.settle(entry, undefined);
		this.tunnels.delete(remoteAuthority);
	}

	private start(remoteAuthority: string, entry: ITunnelEntry, port: number): void {
		// まずユーザー×ホストから決まる候補を試す。一度でも使用中で弾かれたら、この接続に限って
		// sshd に選ばせる（同じ番号を取り合って弾かれ続けない）。通常の切断を経ると close 側で
		// false に戻すので、次の接続ではまた候補から試す
		const listenPort = entry.useDynamicPort ? 0 : computeCandidateRemotePort(entry.host);
		const args = [
			'-N',
			'-R', `${listenPort}:127.0.0.1:${port}`,
			// 利用者の ~/.ssh/config の ControlMaster に相乗りしない（相乗りすると戻り経路の接続を
			// 利用者のマスターが持ち、接続元の確認でこの ssh と一致しなくなる）
			'-o', 'ControlPath=none',
			// パスフレーズや初見ホストの確認で固まらせない。鍵は ssh-agent 側で解決される
			'-o', 'BatchMode=yes',
			// ポートを取れなかったら黙って繋がったままにせず終了させる
			'-o', 'ExitOnForwardFailure=yes',
			// 動的割当てでは `Allocated port ...` が INFO レベルで出るのでそれで十分だが、
			// 固定候補では成功時に既定の LogLevel では何も出ないため DEBUG1 まで上げ、
			// `remote forward success for: listen <N>` を正の確認信号として拾う。
			// 接続先の `~/.ssh/config` が LogLevel を絞っていても、コマンドライン引数は
			// config より優先されるのでここで強制できる。確認のためだけに要る設定だが、
			// 接続の寿命いっぱい DEBUG1 のまま残る（確認後に INFO へ戻す口は無い）ので、
			// hook / MCP のやり取りごとに `debug1: channel ...` 系の行が stderr へ流れ続ける。
			// それらは末尾の `/^debug\d?:/` 判定で trace に落として warn ログを埋めない
			'-o', listenPort === 0 ? 'LogLevel=INFO' : 'LogLevel=DEBUG1',
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

		// 確認（動的なら `Allocated port ...`、固定候補なら `remote forward success for: ...`）が
		// 来ないまま待たせ続けない。番号が分かるか接続が終わるかのどちらかが先に起きるので、
		// ここでは「終わらせる」側を受け持つ。到達不能なホストや認証待ちが長引く構成では、
		// エラーより先にここへ来ることがあるが、それは「まだ張れていない」の判定として正しい
		// （時間切れを「張れた」とみなす推定はしない）。
		// 固定候補で確認が一度も取れなかった場合は、次の通常リトライで動的割当てへ切り替える
		// （OpenSSH 以外の実装や DEBUG1 が抑止される構成など、正の確認信号が構造的に得られない
		// 相手に固定候補を延々と試し続けて、戻りトンネルが永久に張れなくなるのを避けるため）
		entry.allocationTimer = setTimeout(() => {
			entry.allocationTimer = undefined;
			if (!entry.disposed && entry.remotePort === undefined) {
				entry.timedOutWaitingForConfirmation = true;
				child.kill();
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
		// 決定的候補では、使用中で弾かれると `remote port forwarding failed for listen port <N>` が、
		// 張れると（DEBUG1 なので）`remote forward success for: listen <N>, ...` が出る。
		// チャンクは行境界と無関係に届くため、行単位に組み直してから調べる
		let stderrBuffer = '';
		const allocatedPortPattern = new RegExp(`^Allocated port (\\d+) for remote forward to 127\\.0\\.0\\.1:${port}$`);
		const fixedPortTakenPattern = new RegExp(`remote port forwarding failed for listen port ${listenPort}\\b`);
		const fixedPortSuccessPattern = new RegExp(`remote forward success for: listen [^,]*\\b${listenPort}\\b`);
		child.stderr?.on('data', (chunk: Buffer) => {
			stderrBuffer += chunk.toString();
			let newlineIndex: number;
			while ((newlineIndex = stderrBuffer.indexOf('\n')) >= 0) {
				const line = stderrBuffer.slice(0, newlineIndex).trim();
				stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
				if (line.length === 0) {
					continue;
				}
				if (listenPort === 0) {
					const allocated = allocatedPortPattern.exec(line);
					if (allocated !== null) {
						this.logService.info(`[paradis] return tunnel (${entry.host}): ${line}`);
						const remotePort = Number(allocated[1]);
						if (Number.isInteger(remotePort) && remotePort > 0 && remotePort <= 65535) {
							entry.retries = 0; // 一度でも張れたら、次に切れたときはまた最初から数え直す
							this.settle(entry, remotePort);
						}
						continue;
					}
					this.logService.warn(`[paradis] return tunnel (${entry.host}): ${line}`);
					continue;
				}
				// 決定的候補：LogLevel=DEBUG1 の副作用で `debug1: ...` の行が大量に流れる。
				// 成功／失敗の2パターンだけを個別に見て、それ以外の debug 行は warn で埋めずに
				// trace へ落とす。ただし `Permission denied` 等の本物のエラーは debug 接頭辞を
				// 持たないので、そちらは今までどおり warn に残す（診断性を落とさない）
				if (fixedPortSuccessPattern.test(line)) {
					this.logService.info(`[paradis] return tunnel (${entry.host}): preferred port ${listenPort} is up`);
					entry.retries = 0; // 一度でも張れたら、次に切れたときはまた最初から数え直す
					this.settle(entry, listenPort);
				} else if (fixedPortTakenPattern.test(line)) {
					this.logService.info(`[paradis] return tunnel (${entry.host}): preferred port ${listenPort} is taken; falling back to a dynamic one`);
					// ExitOnForwardFailure=yes によりこのプロセスはまもなく終了する。まだ生きていれば
					// 確実に close させ、そちらで待たずに動的割当てへ切り替えて張り直す
					entry.useDynamicPort = true;
					entry.retryImmediately = true;
					child.kill();
				} else if (/^debug\d?:/.test(line)) {
					this.logService.trace(`[paradis] return tunnel (${entry.host}): ${line}`);
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
			if (entry.disposed) {
				return;
			}
			if (entry.retryImmediately) {
				// 決定的候補が使用中で弾かれただけ。待たずに動的割当てで張り直す（リトライ回数は消費しない）
				entry.retryImmediately = false;
				entry.timedOutWaitingForConfirmation = false; // このケースでは意味を持たない値なので念のため揃える
				this.start(remoteAuthority, entry, port);
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
			// 通常の切断のうち、確認が一度でも取れていた（張れていた経路が後から切れた）なら、
			// それは一時的な衝突だっただけかもしれないので、次はまた決定的候補から試す。
			// 確認が一度も取れないまま時間切れになったのなら、固定候補の正の確認信号が構造的に
			// 得られない相手（OpenSSH 以外の実装等）の可能性があるので、次は動的割当てへ逃がす
			entry.useDynamicPort = entry.timedOutWaitingForConfirmation;
			entry.timedOutWaitingForConfirmation = false;
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
	 * そのウィンドウが持っていた戻り経路を手放す（ウィンドウが destroy された）。
	 *
	 * 閉じる知らせはウィンドウ側の dispose から投げっぱなしで送られるだけなので、クラッシュや
	 * 終了中の切断では普通に届かない。所有者が消えたことが確かに分かった時点で、ここから外す。
	 */
	releaseWindow(owner: string): void {
		for (const [remoteAuthority, entry] of [...this.tunnels]) {
			if (entry.owners.has(owner)) {
				this.close(remoteAuthority, owner);
			}
		}
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

export function createParadisRemoteAgentTunnels(logService: ILogService, resolveSshEnv?: () => Promise<NodeJS.ProcessEnv>): ParadisRemoteAgentTunnels & IDisposable {
	return new ParadisRemoteAgentTunnels(logService, undefined, resolveSshEnv);
}
