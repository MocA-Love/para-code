/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH で繋いだ先のエージェントが書く transcript を、手元へ写して読めるようにする台帳。
//
// なぜ要るか: 会話の本文は transcript（JSONL）を tail して読んでいる。読み手は shared process
// なので、接続先のディスクには手が届かない。hook は戻り経路のおかげで届くようになったが、
// 本文だけが来ないまま残っていた（実行状態は出るのに、モバイルにも詳細画面にも会話が出ない）。
//
// 方針: transcript を接続先から手元へ写し、**tailer には写しの方を読ませる**。写しは追記だけで
// 育つので、tailer 側（6000行の巨大ファイル）には一切手を入れずに済む。
//  - 写す作業そのものは、接続先を唯一見られる側であるウィンドウ（renderer）がやる
//  - この台帳は「どれを写すか」「どこまで写したか」を持ち、追記の実行だけを引き受ける
//  - hook で届いたパスは入口でここを通し、写し先のパスへ差し替える。以降の経路は
//    ローカルの transcript と全く同じ扱いになる
//
// 写し先はディレクトリ構成を保つ（`/home/u/.claude/projects/x/y.jsonl` →
// `<root>/home/u/.claude/projects/x/y.jsonl`）。エージェント種別の判定も、SubAgent の
// 兄弟ファイル探索も、パスの形に依存しているため。
//
// 写しは接続先の「末尾の窓」。会話は 250MB を超えることがあり、先頭から全部写すと上限で止まって
// 二度と最新が出なくなっていた。写し始めは接続先の末尾から {@link MIRROR_WINDOW_BYTES} 手前（行の境目）
// から写し、写しが {@link MIRROR_MAX_BYTES} を超えそうになったら、手元の写しの末尾の窓で作り直す
// （先頭を捨てる）。写しの位置と接続先の位置は {@link ICopyLayout} で結ぶ。作り直したことは
// {@link paradisRemoteTranscriptCopyState} の generation で tailer へ伝え、tailer は読み直す。
// Codex の rollout は先頭行（session_meta）で素性（root / SubAgent）を見分けるので、窓にしても先頭行だけは
// 写しの先頭に残す。窓より前の会話は写さない（モバイルの「さらに前を読む」も写しの先頭で止まる）。

import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, sep } from '../../../../base/common/path.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisIsAgentHookRemoteHostId } from '../../agentBrowser/common/paradisAgentHooks.js';
import { paradisClaudeConfigDir, paradisCodexHomes } from '../../agentBrowser/node/paradisAgentHome.js';

/** userDataPath 直下に作る、写しの置き場の名前。 */
const MIRROR_DIR_NAME = 'paradisRemoteTranscripts';

/**
 * 1ファイルあたりの写しの上限。これを超えそうになったら、写しを末尾の窓（{@link MIRROR_WINDOW_BYTES}）で
 * 作り直して続ける（止めない）。台帳に載る写しの合計は最大で {@link MAX_ENTRIES} × これ。
 */
const MIRROR_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 写し始め・作り直しで残す、接続先の末尾の幅。tailer の初回読み（ファイルが 8MB 以下なら全部、超えたら末尾 4MB）より
 * 広く取り、再開した大きな会話でも、写し始めてすぐに最新の会話が出るようにする。
 */
const MIRROR_WINDOW_BYTES = 8 * 1024 * 1024;

/** 窓にした Codex の写しの先頭に残す先頭行（session_meta）の上限。超えたら先頭行は残さない。 */
const MIRROR_HEADER_MAX_BYTES = 1024 * 1024;

/** 作り直しの書きかけの名前に付ける接尾辞。`.jsonl` で終わらないので、tailer の兄弟ファイル探索に掛からない。 */
const REWINDOW_SUFFIX = '.paradis-rewindow';

/** 位置を覚えておく写しの数の上限（台帳から外れた後、戻ってきたときに続きから写すため）。 */
const MAX_LAYOUTS = 512;

/** 写しの担当ウィンドウが黙ってからこれを過ぎたら、担当を空けて別のウィンドウに任せる。 */
const OWNER_TTL_MS = 15_000;

/** 追いかける接続先 transcript の上限。古いものから捨てる。 */
const MAX_ENTRIES = 64;

/** ペインが見当たらなくても、これより後に hook が来ていれば追いかけ続ける。 */
const RECENTLY_NOTED_MS = 10 * 60_000;

/**
 * 終わったサブエージェントの写しを台帳から外すまでの猶予。最後の行が届くのを待ってから外す。
 * 外すのは台帳からだけで、写しはディスクに残る（一覧の補完と詳細の表示はそれを読む）。
 */
const FINISHED_SUBAGENT_GRACE_MS = 2 * 60_000;

/** 起動時の掃除で、これより古い写しは消す。 */
const PRUNE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 掃除するかを決める、写し全体の合計サイズ。台帳に載っている写し（今追いかけているもの）も合計に数えるが、
 * 消すのは載っていないものだけ。載っている分は {@link MAX_ENTRIES} × {@link MIRROR_MAX_BYTES} が上限で、
 * 実際には同時に動く会話の数（数本）× 窓の幅（8〜32MB）に収まる。
 */
const PRUNE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/**
 * 掃除を回す間隔。shared process は再起動せず何週間も動き続けるので、起動時の1回だけだと
 * 取りこぼした写し（削除に失敗した分、前回の異常終了で残った分）がずっと残る。
 */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 台帳が使えないことを担当ウィンドウへ伝える戻り値（担当を失った・上限に達した）。 */
export const PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE = -1;

let mirrorRoots: readonly string[] = [];
let catchUpEndLookup: ((localPath: string) => number | undefined) | undefined;
let copyStateLookup: ((localPath: string) => IParadisRemoteTranscriptCopyState | undefined) | undefined;

/** 手元の写しの今の形（tailer が読み直すかを決めるのに使う）。 */
export interface IParadisRemoteTranscriptCopyState {
	/** 写しを作り直す（中身を置き換える）たびに変わる番号。0 は作り直していない。 */
	readonly generation: number;
	/** 接続先の会話の先頭を写していない（末尾の窓だけ）。 */
	readonly partial: boolean;
}

/**
 * 手元の写しの今の形。写しではない・台帳が位置を覚えていないなら undefined。
 *
 * 写しは上限に近づくと末尾の窓で作り直す。作り直した後の写しは前より大きいことがあり、tailer の「縮んだら
 * 読み直す」だけでは気付けない（別の中身を前の位置から続けて読み、会話が混ざる）。generation が変わったら読み直す。
 */
export function paradisRemoteTranscriptCopyState(localPath: string): IParadisRemoteTranscriptCopyState | undefined {
	return copyStateLookup?.(localPath);
}

/**
 * 手元の写しのうち、接続先へ追いつくために写した（写し始めた時点で接続先に既にあった）部分の終わり（バイト位置）。
 * 追いつく分を写していない・写しではない・台帳から外れたなら undefined。
 *
 * 写しは会話を先頭から追記で育てるので、読み手から見ると過去の行も追記に見える。この位置より前の行は、追記で
 * 読んでも新しい出来事ではない（質問の通知・ターンの終わりを鳴らさない）。時刻で比べないのは、行の時刻が
 * 接続先の時計で、手元の時計とずれていることがあるため。
 */
export function paradisRemoteTranscriptCatchUpEnd(localPath: string): number | undefined {
	return catchUpEndLookup?.(localPath);
}

/**
 * 写しの置き場。{@link ParadisRemoteTranscriptMirrorStore} が作られるまでは空。
 *
 * transcript の許可ディレクトリ判定（paradisMobileAgentChat.ts）から参照する。写しは
 * 私たちしか書かないので、許可 root に加えても hook を騙った任意ファイル読みには繋がらない。
 *
 * 実体を辿った後の綴りも併せて返す。判定は symlink を解いた結果も許可 root 内かを見るため、
 * user-data が symlink 越しにある場合（macOS の `/tmp` など）に字面だけだと自分の写しを弾く。
 */
export function paradisRemoteTranscriptMirrorRoots(): readonly string[] {
	return mirrorRoots;
}

/**
 * 写し置き場の中のパスか（＝接続先の transcript の写しか）。
 *
 * 写しを作るのは私たちだけなので、置き場の中にあること自体が「元は接続先のもの」の証拠になる。
 * hook に付く接続先の印は shared process の再起動で失われるが、こちらは復元したセッションの
 * transcript の綴りだけで判る（手元の設定を接続先のセッションへ当てないための拠り所）。
 */
export function paradisIsRemoteAgentTranscriptMirrorPath(path: string | undefined): boolean {
	if (typeof path !== 'string' || path.length === 0) {
		return false;
	}
	return mirrorRoots.some(root => path.startsWith(root + sep) || (sep !== '/' && path.startsWith(root + '/')));
}

/**
 * 接続先のエージェントが書いた transcript のパスか。
 *
 * 判定の根拠は **hook が接続先から届いたという事実**（{@link paradisIsAgentHookRemoteHostId} が
 * 通る印が付いていたか）で、パスの綴りではない。綴りだけで見分けていた頃は、手元と接続先で
 * ユーザー名が同じ構成（Linux から同名ユーザーのサーバーへ ssh する、macOS 同士など）で
 * `/home/alice/.claude/...` が手元のホーム配下と一致してしまい、写しが作られず会話が
 * どこにも出なかった。
 *
 * `remoteHostId` が無いときは従来どおり綴りで見分ける。手元の hook と、印を持たない旧版の
 * スクリプトが残っている接続先の両方が、これまでと同じ扱いになる（安全側）。
 *
 * パスの安全確認（`..` や `\`、`:` を弾く）は印の有無に関わらず必ず通す。あれは写し先を
 * 組み立てる前に字面を信用しないための別の防御で、こちらの判定とは目的が違う。
 */
export function paradisIsRemoteAgentTranscriptPath(path: string | undefined, remoteHostId?: string): path is string {
	// 接続先は Linux / macOS のみ。Windows 表記や相対パスは扱わない
	if (path === undefined || !path.startsWith('/') || !path.endsWith('.jsonl')) {
		return false;
	}
	// `..` はもちろん、`\` と `:` も弾く。写し先は接続先のパスを繋いで組み立てるので、Windows で
	// 動く shared process では `a\..\..\x` のような一片が写し置き場の外へ抜けてしまう
	// （hook は端末の子プロセスなら誰でも名乗れる前提なので、字面は信用しない）。
	if (path.includes('\0') || path.includes('\\') || path.includes(':')) {
		return false;
	}
	if (path.split('/').some(segment => segment === '..' || segment === '.')) {
		return false;
	}
	// エージェントの設定ホーム配下だと分かる形だけを受ける。CLAUDE_CONFIG_DIR / CODEX_HOME を
	// 接続先で移している場合は対象外になるが、素性の分からないパスを写しに行くよりは安全側に倒す
	// Codex はアカウントごとのホーム（`/.codex-2/` 等）も受ける。
	if (!path.includes('/.claude/') && !/\/\.codex(?:-[\w.]+)?\//.test(path)) {
		return false;
	}
	// 接続先から届いたと分かっている hook は、綴りが手元のホームと重なっていても接続先のもの。
	// ここで手元のホーム配下かを見てしまうと、ユーザー名が同じ機械では必ず取りこぼす
	if (paradisIsAgentHookRemoteHostId(remoteHostId)) {
		return true;
	}
	for (const root of [paradisClaudeConfigDir(), ...paradisCodexHomes()]) {
		if (path === root || path.startsWith(root + sep) || (sep !== '/' && path.startsWith(root + '/'))) {
			return false;
		}
	}
	return true;
}

/**
 * 接続先のパスに対応する、手元の写しのパス。ディレクトリ構成をそのまま残す。
 *
 * 別々のホストで同じ絶対パスが使われると写し先がぶつかるが、ファイル名は Claude も Codex も
 * UUID を含むため実際には起こらない。念のため担当は1ウィンドウに限っており、二重書きにはならない。
 */
export function paradisRemoteTranscriptMirrorPathFor(root: string, remotePath: string, remoteHostId?: string): string | undefined {
	if (!paradisIsRemoteAgentTranscriptPath(remotePath, remoteHostId) || !isAbsolute(root)) {
		return undefined;
	}
	return join(root, ...remotePath.split('/').filter(segment => segment.length > 0));
}

/**
 * 手元の写しと接続先の位置の対応。台帳の項目（{@link IMirrorEntry}）より長く持つ（ペインを退避して台帳から
 * 外れた後に戻ってきても、続きから写せるように）。shared process を立て直すと失われ、そのときは写しを取り直す
 * （位置の分からない写しに続けて書くと、中身が混ざる）。
 */
interface ICopyLayout {
	/** 写しの先頭に残した、接続先の先頭行（Codex の session_meta）のバイト数。残していなければ 0。 */
	header: number;
	/** この shared process が写しを作った（位置の対応を知っている）。false なら写しがあっても位置は分からない。 */
	known: boolean;
	/** 写しの位置 {@link header} が指す、接続先の位置。先頭から写していれば 0。 */
	base: number;
	generation: number;
	partial: boolean;
	/**
	 * 窓の始まりをそろえている途中。
	 * `header`: 接続先の先頭行を読んでいる（読み終えたら `windowStart` から写す）。
	 * `align`: `base` から読んだ最初の改行までを捨てる（行の途中から写さない）。
	 */
	pending?: { readonly kind: 'header'; readonly windowStart: number; readonly chunks: Buffer[]; bytes: number } | { readonly kind: 'align' };
}

interface IMirrorEntry {
	readonly remotePath: string;
	readonly localPath: string;
	/** 写しの現在のバイト数。 */
	size: number;
	readonly layout: ICopyLayout;
	/** 写しを担当しているウィンドウ。空いていれば undefined。 */
	owner: string | undefined;
	ownerSeenAt: number;
	/** 最後に hook でこのパスが現れた時刻。古いものから捨てるときの基準。 */
	notedAt: number;
	/** このパスを名乗ったペイン。ペインが消えたら追いかけるのをやめる。 */
	token: string;
	/** 写しを続けられていない理由（手元へ書けない・接続先を読めない）。続けられたら消える。 */
	failure?: 'write' | 'read';
	/** サブエージェントの終わりを知った時刻。再開（同じパスが再び現れる）で消える。 */
	finishedAt?: number;
	/** 同じファイルへの追記を直列化する。 */
	chain: Promise<void>;
	/** 追いつくために写した部分の終わり（写しの位置。{@link paradisRemoteTranscriptCatchUpEnd}）。 */
	catchUpEnd?: number;
	/** 会話を再開した（SessionStart の source が resume）hook で知ったか。 */
	resumed?: boolean;
	/**
	 * 担当を取ったときに、追いつく分の印を受け付けると決めたか。写しを一から作るときのうち、再開した会話・
	 * 接続先の末尾の窓から写し始めた・位置の分からない写しを取り直した、のどれか（どれも過去の会話）。
	 * 写しの途中から続ける（再接続・再読み込み）ときと新しい会話は、切れていた間・最初の出来事を鳴らす。
	 */
	catchUpAllowed?: boolean;
}

/** Codex の rollout か（先頭行で素性を見分けるので、窓にしても先頭行を残す）。 */
function isCodexRolloutPath(path: string): boolean {
	return /\/\.codex(?:-[\w.]+)?\//.test(path);
}

/**
 * 接続先 transcript の写しの台帳（shared process 側）。
 *
 * 実際のファイル読みは担当ウィンドウが行い、ここは「どこまで写したか」を持って追記するだけ。
 * 担当が決まらない間も hook 側は写し先のパスで進むので、tailer は写しができ次第そのまま読み始める。
 */
export class ParadisRemoteTranscriptMirrorStore extends Disposable {

	private readonly root: string;
	private readonly entries = new Map<string, IMirrorEntry>();
	/** 写しのパス → 接続先との位置の対応（{@link ICopyLayout}）。 */
	private readonly layouts = new Map<string, ICopyLayout>();
	private generationCounter = 0;
	private disposed = false;
	private readonly windowBytes: number;

	private readonly _onDidChangeStalled = this._register(new Emitter<string>());
	/** 写しを続けられなくなった・続けられるようになった（写しのパス）。 */
	readonly onDidChangeStalled: Event<string> = this._onDidChangeStalled.event;

	private readonly _onDidAppend = this._register(new Emitter<string>());
	/** 写しに書き足した（写しのパス）。 */
	readonly onDidAppend: Event<string> = this._onDidAppend.event;

	constructor(
		userDataPath: string,
		private readonly logService: ILogService,
		/** 1ファイルあたりの写しの上限。上限に達したときの振る舞いを試すためだけに差し替える。 */
		private readonly maxBytes: number = MIRROR_MAX_BYTES,
		/** 写し始め・作り直しで残す末尾の幅。試すためだけに差し替える（上限の半分を超えない）。 */
		windowBytes: number = MIRROR_WINDOW_BYTES,
	) {
		super();
		this.windowBytes = Math.max(1, Math.min(windowBytes, Math.floor(maxBytes / 2)));
		this.root = join(userDataPath, MIRROR_DIR_NAME);
		mirrorRoots = [this.root];
		const lookup = (localPath: string) => this.catchUpEndFor(localPath);
		catchUpEndLookup = lookup;
		const stateLookup = (localPath: string) => {
			const layout = this.layouts.get(localPath);
			return layout !== undefined ? { generation: layout.generation, partial: layout.partial } : undefined;
		};
		copyStateLookup = stateLookup;
		this._register({
			dispose: () => {
				this.disposed = true;
				if (mirrorRoots.includes(this.root)) {
					mirrorRoots = [];
				}
				if (catchUpEndLookup === lookup) {
					catchUpEndLookup = undefined;
				}
				if (copyStateLookup === stateLookup) {
					copyStateLookup = undefined;
				}
			}
		});
		void this.resolveRealRoot();
		void this.prune();
		const pruneTimer = setInterval(() => void this.prune(), PRUNE_INTERVAL_MS);
		// 掃除のためにプロセスを生かし続けない。`unref` のキャストは dom/node の
		// `setInterval` 型衝突を避けるため（`wslRemoteAgentHostService.ts` と同じ書き方）。
		// 呼べるかは実行時に確かめる: 単体テストの実行環境の `setInterval` は数値を返すので、
		// 無条件に呼ぶとこのクラスを作るところで必ず落ちる
		(pruneTimer as unknown as NodeJS.Timeout).unref?.();
		this._register(toDisposable(() => clearInterval(pruneTimer)));
	}

	/** 実体を辿った綴りも許可rootに加える（user-data が symlink 越しにあるとき用）。 */
	private async resolveRealRoot(): Promise<void> {
		await fs.mkdir(this.root, { recursive: true }).catch(() => undefined);
		const real = await fs.realpath(this.root).catch(() => undefined);
		if (!this.disposed && real !== undefined && real !== this.root) {
			mirrorRoots = [this.root, real];
		}
	}

	/** テスト・診断用。 */
	get mirrorRoot(): string {
		return this.root;
	}

	/**
	 * hook で届いた transcript のパスを、手元で読めるパスへ読み替える。
	 * 接続先のものでなければ undefined（呼び出し側はそのままのパスを使う）。
	 *
	 * @param remoteHostId hook に付いていた接続先の印。これがあると、綴りが手元のホーム配下と
	 * 重なっていても接続先のものとして写す（同名ホームの別マシンを取りこぼさないため）。
	 */
	localPathForHookPath(remotePath: string | undefined, token: string, remoteHostId?: string, resumed = false): string | undefined {
		if (this.disposed || !paradisIsRemoteAgentTranscriptPath(remotePath, remoteHostId)) {
			return undefined;
		}
		const existing = this.entries.get(remotePath);
		if (existing !== undefined) {
			existing.notedAt = Date.now();
			existing.token = token;
			existing.finishedAt = undefined;
			if (resumed) {
				existing.resumed = true;
			}
			return existing.localPath;
		}
		const localPath = paradisRemoteTranscriptMirrorPathFor(this.root, remotePath, remoteHostId);
		if (localPath === undefined) {
			return undefined;
		}
		this.entries.set(remotePath, {
			remotePath,
			localPath,
			size: 0,
			layout: this.layoutFor(localPath),
			owner: undefined,
			ownerSeenAt: 0,
			notedAt: Date.now(),
			token,
			chain: Promise.resolve(),
			...(resumed ? { resumed: true } : {}),
		});
		this.evictOverflow();
		this.logService.info(`[paradisRemoteTranscript] following a transcript on the host: ${remotePath}`);
		return localPath;
	}

	/** 位置の対応を引く。無ければ「まだ位置が分からない」形で作る（{@link begin} が決める）。 */
	private layoutFor(localPath: string): ICopyLayout {
		const existing = this.layouts.get(localPath);
		if (existing !== undefined) {
			// 新しく使った順に並べ直す（上限で古いものから外す）
			this.layouts.delete(localPath);
			this.layouts.set(localPath, existing);
			return existing;
		}
		const layout: ICopyLayout = { header: 0, known: false, base: 0, generation: 0, partial: false };
		this.layouts.set(localPath, layout);
		const tracked = new Set([...this.entries.values()].map(entry => entry.localPath));
		for (const path of this.layouts.keys()) {
			if (this.layouts.size <= MAX_LAYOUTS) {
				break;
			}
			if (!tracked.has(path) && path !== localPath) {
				this.layouts.delete(path);
			}
		}
		return layout;
	}

	/** 接続先の、次に読む位置。 */
	private remotePosition(entry: IMirrorEntry): number {
		const pending = entry.layout.pending;
		if (pending?.kind === 'header') {
			return pending.bytes;
		}
		return entry.layout.base + entry.size - entry.layout.header;
	}

	/**
	 * 担当ウィンドウが写すべきパスの一覧。空いているものと、自分が担当しているものを返す。
	 * 呼ぶこと自体が「まだ生きている」の合図になる。
	 */
	list(ownerId: string): readonly string[] {
		const now = Date.now();
		const paths: string[] = [];
		for (const entry of this.entries.values()) {
			if (entry.owner === ownerId) {
				entry.ownerSeenAt = now;
				paths.push(entry.remotePath);
			} else if (entry.owner === undefined || now - entry.ownerSeenAt >= OWNER_TTL_MS) {
				paths.push(entry.remotePath);
			}
		}
		return paths;
	}

	/**
	 * 写しを始める（担当を取る）。
	 * @param remoteSize 担当ウィンドウが見た接続先の大きさ。窓より大きければ、写しを一から作るときは末尾の窓から写す
	 * @returns 接続先の次に読む位置。担当を取れなければ {@link PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE}
	 */
	async begin(ownerId: string, remotePath: string, remoteSize?: number): Promise<number> {
		const entry = this.entries.get(remotePath);
		if (entry === undefined) {
			return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
		}
		const now = Date.now();
		if (entry.owner !== undefined && entry.owner !== ownerId && now - entry.ownerSeenAt < OWNER_TTL_MS) {
			return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
		}
		entry.owner = ownerId;
		entry.ownerSeenAt = now;
		return this.enqueue(entry, async () => {
			await fs.mkdir(dirname(entry.localPath), { recursive: true });
			const stat = await fs.stat(entry.localPath).catch(() => undefined);
			const localSize = stat?.isFile() === true ? stat.size : 0;
			const layout = entry.layout;
			// 位置の分かっている写しなら続きから写す（ウィンドウを開き直した・ペインを戻した）
			if (localSize > 0 && layout.known && layout.pending?.kind !== 'header') {
				entry.size = localSize;
				entry.catchUpAllowed = false;
				return this.remotePosition(entry);
			}
			// 写しを一から作る。位置の分からない写し（shared process を立て直す前のもの）は、続きに書くと
			// 中身が混ざるので取り直す
			const hadCopy = localSize > 0;
			if (hadCopy) {
				await fs.writeFile(entry.localPath, '');
			}
			entry.size = 0;
			entry.catchUpEnd = undefined;
			const windowStart = remoteSize !== undefined && remoteSize > this.windowBytes ? remoteSize - this.windowBytes : 0;
			layout.known = true;
			layout.header = 0;
			layout.partial = windowStart > 0;
			if (hadCopy) {
				layout.generation = ++this.generationCounter;
			}
			entry.catchUpAllowed = entry.resumed === true || windowStart > 0 || hadCopy;
			if (windowStart === 0) {
				layout.base = 0;
				layout.pending = undefined;
				return 0;
			}
			if (isCodexRolloutPath(entry.remotePath)) {
				// 先頭行を先に読み、読み終えたら窓から写す
				layout.base = 0;
				layout.pending = { kind: 'header', windowStart, chunks: [], bytes: 0 };
				return 0;
			}
			layout.base = windowStart;
			layout.pending = { kind: 'align' };
			return windowStart;
		});
	}

	private catchUpEndFor(localPath: string): number | undefined {
		for (const entry of this.entries.values()) {
			if (entry.localPath === localPath) {
				return entry.catchUpEnd;
			}
		}
		return undefined;
	}

	/**
	 * 接続先から読んだ続きを写しへ足す。
	 * @param catchingUp 写し始めた時点で接続先に既にあった分（過去の会話）か。読み手はこの分の質問・ターンの終わりを鳴らさない
	 * @returns 次に読む接続先の位置（窓の始まりへ飛ぶことがある）。担当を失ったときは {@link PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE}
	 */
	async append(ownerId: string, remotePath: string, data: Uint8Array, catchingUp = false): Promise<number> {
		const entry = this.entries.get(remotePath);
		if (entry === undefined || entry.owner !== ownerId) {
			return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
		}
		entry.ownerSeenAt = Date.now();
		if (data.byteLength === 0) {
			return this.remotePosition(entry);
		}
		return this.enqueue(entry, async () => {
			// 順番待ちの間に担当が変わっていることがある。書く直前にもう一度確かめる
			// （空いた隙に別のウィンドウが取り直して写しを捨てていると、混ざった中身になる）
			if (entry.owner !== ownerId) {
				return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
			}
			const layout = entry.layout;
			let bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
			const pending = layout.pending;
			if (pending?.kind === 'header') {
				const newline = bytes.indexOf(0x0a);
				if (newline < 0) {
					pending.chunks.push(Buffer.from(bytes));
					pending.bytes += bytes.length;
					if (pending.bytes > MIRROR_HEADER_MAX_BYTES) {
						// 先頭行が長すぎる。残さずに窓から写す
						layout.base = pending.windowStart;
						layout.pending = { kind: 'align' };
					}
					return this.remotePosition(entry);
				}
				const header = Buffer.concat([...pending.chunks, bytes.subarray(0, newline + 1)]);
				await fs.appendFile(entry.localPath, header);
				entry.size += header.length;
				layout.header = header.length;
				this.noteCatchUp(entry, catchingUp);
				if (pending.windowStart <= header.length) {
					// 先頭行の直後が窓の始まり（行の境目）
					layout.base = header.length;
					layout.pending = undefined;
				} else {
					layout.base = pending.windowStart;
					layout.pending = { kind: 'align' };
				}
				this.noteWritten(entry);
				return this.remotePosition(entry);
			}
			if (pending?.kind === 'align') {
				const newline = bytes.indexOf(0x0a);
				if (newline < 0) {
					layout.base += bytes.length;
					return this.remotePosition(entry);
				}
				layout.base += newline + 1;
				layout.pending = undefined;
				bytes = bytes.subarray(newline + 1);
				if (bytes.length === 0) {
					return this.remotePosition(entry);
				}
			}
			if (entry.size + bytes.length > this.maxBytes) {
				await this.rewindow(entry, bytes);
			} else {
				await fs.appendFile(entry.localPath, bytes);
				entry.size += bytes.length;
			}
			this.noteCatchUp(entry, catchingUp);
			this.noteWritten(entry);
			return this.remotePosition(entry);
		});
	}

	private noteCatchUp(entry: IMirrorEntry, catchingUp: boolean): void {
		if (catchingUp && entry.catchUpAllowed === true) {
			entry.catchUpEnd = entry.size;
		} else {
			// 追いつく分は先頭から続く分だけ。印の無い追記の後には印を受け付けない
			entry.catchUpAllowed = false;
		}
	}

	/** 書けた。止まっていた印を外し、書き足したことを知らせる。 */
	private noteWritten(entry: IMirrorEntry): void {
		if (entry.failure === 'write') {
			this.setFailure(entry, undefined);
		}
		this._onDidAppend.fire(entry.localPath);
	}

	/**
	 * 写しを末尾の窓で作り直して、続きを足す。接続先は読まない（手元の写しの末尾が、接続先の今の位置までの
	 * 末尾そのもの）。書きかけを別の名前で書いてから置き換えるので、tailer が途中の空の写しを読むことはない。
	 */
	private async rewindow(entry: IMirrorEntry, data: Buffer): Promise<void> {
		const layout = entry.layout;
		const keepFrom = Math.max(layout.header, entry.size - this.windowBytes);
		const handle = await fs.open(entry.localPath, 'r');
		let header: Buffer;
		let tail: Buffer;
		try {
			header = Buffer.alloc(layout.header);
			if (header.length > 0) {
				await handle.read(header, 0, header.length, 0);
			}
			tail = Buffer.alloc(entry.size - keepFrom);
			const { bytesRead } = await handle.read(tail, 0, tail.length, keepFrom);
			tail = tail.subarray(0, bytesRead);
		} finally {
			await handle.close().catch(() => undefined);
		}
		let start = keepFrom;
		if (keepFrom > layout.header) {
			// 行の途中から残さない
			const newline = tail.indexOf(0x0a);
			start = newline < 0 ? keepFrom + tail.length : keepFrom + newline + 1;
			tail = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1);
		}
		const temporary = entry.localPath + REWINDOW_SUFFIX;
		await fs.writeFile(temporary, Buffer.concat([header, tail, data]));
		await fs.rename(temporary, entry.localPath);
		layout.base += start - layout.header;
		layout.partial = true;
		layout.generation = ++this.generationCounter;
		entry.size = header.length + tail.length + data.length;
		// 残した分は過去の会話。tailer は作り直しを見て全部読み直すので、ここから先の追記だけが新しい出来事
		entry.catchUpEnd = entry.catchUpEnd !== undefined ? header.length + tail.length : undefined;
		this.logService.info(`[paradisRemoteTranscript] kept the latest ${tail.length} bytes of ${entry.remotePath}; the copy reached its size limit`);
	}

	/**
	 * 接続先のファイルが縮んだ（別セッションに置き換わった）ときに写しを捨てる。
	 * tailer 側は写しの縮小を見て epoch を切り替え、読み直す。
	 */
	async reset(ownerId: string, remotePath: string): Promise<number> {
		const entry = this.entries.get(remotePath);
		if (entry === undefined || entry.owner !== ownerId) {
			return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
		}
		entry.ownerSeenAt = Date.now();
		return this.enqueue(entry, async () => {
			if (entry.owner !== ownerId) {
				return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
			}
			await fs.mkdir(dirname(entry.localPath), { recursive: true });
			await fs.writeFile(entry.localPath, '');
			entry.size = 0;
			entry.catchUpEnd = undefined;
			entry.catchUpAllowed = false;
			const layout = entry.layout;
			layout.known = true;
			layout.header = 0;
			layout.base = 0;
			layout.partial = false;
			layout.pending = undefined;
			layout.generation = ++this.generationCounter;
			return 0;
		});
	}

	/**
	 * 担当ウィンドウが、接続先の transcript を読めなかった（failed）・また読めた（!failed）と知らせる。
	 * 読めない間はチャットに「最新を取得できていません」と出す。
	 */
	reportReadFailure(ownerId: string, remotePath: string, failed: boolean): void {
		const entry = this.entries.get(remotePath);
		if (entry === undefined || entry.owner !== ownerId) {
			return;
		}
		if (failed) {
			if (entry.failure === undefined) {
				this.setFailure(entry, 'read');
			}
		} else if (entry.failure === 'read') {
			this.setFailure(entry, undefined);
		}
	}

	/** この写しを、接続先の最新まで続けられていないか（書けない・読めない）。 */
	isStalled(localPath: string): boolean {
		for (const entry of this.entries.values()) {
			if (entry.localPath === localPath) {
				return entry.failure !== undefined;
			}
		}
		return false;
	}

	private setFailure(entry: IMirrorEntry, failure: 'write' | 'read' | undefined): void {
		if (entry.failure === failure) {
			return;
		}
		entry.failure = failure;
		this._onDidChangeStalled.fire(entry.localPath);
	}

	/**
	 * 手元の写し（tailer が読んでいるパス）を今担当しているウィンドウ。空いている・担当が黙っていれば undefined。
	 * 担当は接続先に繋いでいて、その transcript が実在すると確かめたウィンドウなので、同じ接続先のほかのファイル
	 * （バックグラウンドのシェルの出力）を読むのにも使う。
	 */
	ownerForLocalPath(localPath: string): string | undefined {
		for (const entry of this.entries.values()) {
			if (entry.localPath === localPath) {
				return entry.owner !== undefined && Date.now() - entry.ownerSeenAt < OWNER_TTL_MS ? entry.owner : undefined;
			}
		}
		return undefined;
	}

	/** ウィンドウが閉じた・接続先が変わったとき、担当を空けて他のウィンドウへ渡せるようにする。 */
	release(ownerId: string): void {
		for (const entry of this.entries.values()) {
			if (entry.owner === ownerId) {
				entry.owner = undefined;
				entry.ownerSeenAt = 0;
			}
		}
	}

	/**
	 * ペインが消えた transcript を追いかけるのをやめる。
	 *
	 * ウィンドウの再読み込み中はペインが一時的に「居ない」ことになる。そこで落とすと、次のhookが
	 * 来るまで会話が黙って止まるので、最近まで動いていたものは残す。
	 *
	 * **やめるのは「接続先を読みに行くこと」だけで、写しはディスクに残す。** ペインを退避
	 * （park）してから戻すまでの猶予は7日（paradisMobileAgentChat の退避セッションTTL）ある
	 * のに対し、こちらの猶予は10分。ここで消してしまうと、15分後に戻したペインの写しが無く
	 * なっていて会話が空になり、次のhookで {@link begin} が接続先の末尾の窓から取り直す。
	 * 写しとの位置の対応（{@link ICopyLayout}）も台帳の外に残すので、戻したときは続きから写せる。
	 * 使わなくなった写しの回収は {@link prune}（14日 / 合計512MB）に任せる。
	 */
	retainLiveTokens(isLive: (token: string) => boolean): void {
		const now = Date.now();
		for (const [remotePath, entry] of [...this.entries]) {
			if ((!isLive(entry.token) && now - entry.notedAt > RECENTLY_NOTED_MS)
				|| (entry.finishedAt !== undefined && now - entry.finishedAt > FINISHED_SUBAGENT_GRACE_MS)) {
				this.entries.delete(remotePath);
			}
		}
	}

	/**
	 * サブエージェントが終わったことを知らせる。{@link FINISHED_SUBAGENT_GRACE_MS} の後に台帳から外し、
	 * 終わった子の数だけ接続先の監視と読み取りが増え続けないようにする。
	 */
	noteSubagentFinished(remotePath: string): void {
		const entry = this.entries.get(remotePath);
		if (entry !== undefined) {
			entry.finishedAt = Date.now();
		}
	}

	private enqueue(entry: IMirrorEntry, work: () => Promise<number>): Promise<number> {
		const result = entry.chain.then(work);
		// 失敗しても次の追記は続けられる。取りこぼした分は担当ウィンドウが次の周期で読み直す
		entry.chain = result.then(() => undefined, () => undefined);
		return result.catch(error => {
			this.logService.warn(`[paradisRemoteTranscript] could not write the copy of ${entry.remotePath}`, error);
			// ログだけにしない。チャットに「最新を取得できていません」と出す（次に書けたら消える）
			this.setFailure(entry, 'write');
			return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
		});
	}

	/**
	 * 台帳に載せる本数の上限を守る。古いものから外す。
	 *
	 * 外すのは台帳からだけで、写しはディスクに残す（{@link retainLiveTokens} と同じ理由。
	 * 他のセッションが増えたせいで、退避中のペインの写しを失わせない）。回収は {@link prune}。
	 */
	private evictOverflow(): void {
		while (this.entries.size > MAX_ENTRIES) {
			let oldestPath: string | undefined;
			let oldestAt = Number.POSITIVE_INFINITY;
			for (const [remotePath, entry] of this.entries) {
				if (entry.notedAt < oldestAt) {
					oldestAt = entry.notedAt;
					oldestPath = remotePath;
				}
			}
			if (oldestPath === undefined) {
				return;
			}
			this.entries.delete(oldestPath);
		}
	}

	/**
	 * 取りこぼしの掃除。使わなくなった写しがディスクに残り続けないようにする。
	 * 古いものから消し、それでも大きすぎるときは合計が収まるまで消す。
	 *
	 * 今も台帳に載っている写しは対象外。起動時は台帳が空なので結果は変わらないが、
	 * 周期実行では「写している最中のファイル」を巻き込みうる（消えたことに気付かないまま
	 * `entry.size` を続きの位置として使い、穴の空いた写しになる）。
	 */
	private async prune(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const files: { path: string; size: number; mtime: number }[] = [];
		const directories: string[] = [];
		// 台帳に載っている写しと、その作り直しの書きかけは消さない（大きさは合計に数える）
		const tracked = new Set([...this.entries.values()].flatMap(entry => [entry.localPath, entry.localPath + REWINDOW_SUFFIX]));
		let trackedBytes = 0;
		const walk = async (dir: string, depth: number): Promise<void> => {
			if (depth > 12 || this.disposed) {
				return;
			}
			const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined);
			for (const entry of entries ?? []) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					directories.push(path);
					await walk(path, depth + 1);
				} else if (entry.isFile()) {
					const stat = await fs.stat(path).catch(() => undefined);
					if (stat === undefined) {
						continue;
					}
					if (tracked.has(path)) {
						trackedBytes += stat.size;
					} else {
						files.push({ path, size: stat.size, mtime: stat.mtimeMs });
					}
				}
			}
		};
		await walk(this.root, 0);
		if (this.disposed) {
			return;
		}
		const now = Date.now();
		const doomed = new Set(files.filter(file => now - file.mtime > PRUNE_MAX_AGE_MS).map(file => file.path));
		let total = trackedBytes + files.filter(file => !doomed.has(file.path)).reduce((sum, file) => sum + file.size, 0);
		if (total > PRUNE_MAX_TOTAL_BYTES) {
			for (const file of files.filter(file => !doomed.has(file.path)).sort((a, b) => a.mtime - b.mtime)) {
				if (total <= PRUNE_MAX_TOTAL_BYTES) {
					break;
				}
				doomed.add(file.path);
				total -= file.size;
			}
		}
		// 走査の途中で hook が来ると、写し始めたばかりのファイルが doomed に入っていることがある。
		// 消す直前の台帳でもう一度確かめる
		let removed = 0;
		for (const path of doomed) {
			if ([...this.entries.values()].some(entry => entry.localPath === path)) {
				continue;
			}
			// 消せなかったぶんを数えない。件数がずれると、ログを見て「掃除は効いている」と
			// 読んでしまい、権限などで実際には減っていないことに気付けなくなる
			const succeeded = await fs.rm(path, { force: true }).then(() => true, () => false);
			if (succeeded) {
				removed++;
				// 写しが無くなったので、位置の対応も捨てる（次は一から写す）
				this.layouts.delete(path);
			}
		}
		// 写しはディレクトリ構成を保つので、ファイルだけ消しても骨組みが残り続ける。深い方から
		// 空になったものを畳む（中身が残っていれば ENOTEMPTY で失敗し、そのまま残る）
		let removedDirectories = 0;
		for (const directory of directories.sort((a, b) => b.length - a.length)) {
			const succeeded = await fs.rmdir(directory).then(() => true, () => false);
			if (succeeded) {
				removedDirectories++;
			}
		}
		if (removed > 0 || removedDirectories > 0) {
			this.logService.info(`[paradisRemoteTranscript] removed ${removed} stale copies and ${removedDirectories} empty folders`);
		}
	}
}
