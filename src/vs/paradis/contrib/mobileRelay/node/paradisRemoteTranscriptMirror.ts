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

import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, sep } from '../../../../base/common/path.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisClaudeConfigDir, paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';

/** userDataPath 直下に作る、写しの置き場の名前。 */
const MIRROR_DIR_NAME = 'paradisRemoteTranscripts';

/**
 * 1ファイルあたりの写しの上限。これを超えたら追記をやめる（会話は止まるが、
 * 手元のディスクを無制限に食うよりまし）。tailer の初回読みが末尾4MBなので、
 * 実用上ここに届くのは相当な長時間セッションだけ。
 */
const MIRROR_MAX_BYTES = 64 * 1024 * 1024;

/** 写しの担当ウィンドウが黙ってからこれを過ぎたら、担当を空けて別のウィンドウに任せる。 */
const OWNER_TTL_MS = 15_000;

/** 追いかける接続先 transcript の上限。古いものから捨てる。 */
const MAX_ENTRIES = 64;

/** ペインが見当たらなくても、これより後に hook が来ていれば追いかけ続ける。 */
const RECENTLY_NOTED_MS = 10 * 60_000;

/** 起動時の掃除で、これより古い写しは消す。 */
const PRUNE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** 掃除するかを決める、写し全体の合計サイズ。 */
const PRUNE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/** 台帳が使えないことを担当ウィンドウへ伝える戻り値（担当を失った・上限に達した）。 */
export const PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE = -1;

let mirrorRoots: readonly string[] = [];

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
 * 接続先のエージェントが書いた transcript のパスか。
 *
 * 「手元では開けない」ことが本質なので、まず手元のエージェントホーム配下かを見る。同じ機械へ
 * ssh したときは本当にローカルのファイルなので、ここで false になり写しは作られない（そのまま
 * 直接読める）。
 */
export function paradisIsRemoteAgentTranscriptPath(path: string | undefined): path is string {
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
	if (!path.includes('/.claude/') && !path.includes('/.codex/')) {
		return false;
	}
	for (const root of [paradisClaudeConfigDir(), paradisCodexHome()]) {
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
export function paradisRemoteTranscriptMirrorPathFor(root: string, remotePath: string): string | undefined {
	if (!paradisIsRemoteAgentTranscriptPath(remotePath) || !isAbsolute(root)) {
		return undefined;
	}
	return join(root, ...remotePath.split('/').filter(segment => segment.length > 0));
}

interface IMirrorEntry {
	readonly remotePath: string;
	readonly localPath: string;
	/** 写しの現在のバイト数。接続先の次に読む位置でもある。 */
	size: number;
	/** 写しを担当しているウィンドウ。空いていれば undefined。 */
	owner: string | undefined;
	ownerSeenAt: number;
	/** 最後に hook でこのパスが現れた時刻。古いものから捨てるときの基準。 */
	notedAt: number;
	/** このパスを名乗ったペイン。ペインが消えたら追いかけるのをやめる。 */
	token: string;
	/** 上限に達したことを一度だけ記録するための目印。 */
	capped: boolean;
	/** 同じファイルへの追記を直列化する。 */
	chain: Promise<void>;
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
	private disposed = false;

	constructor(
		userDataPath: string,
		private readonly logService: ILogService,
		/** 1ファイルあたりの写しの上限。上限に達したときの振る舞いを試すためだけに差し替える。 */
		private readonly maxBytes: number = MIRROR_MAX_BYTES,
	) {
		super();
		this.root = join(userDataPath, MIRROR_DIR_NAME);
		mirrorRoots = [this.root];
		this._register({
			dispose: () => {
				this.disposed = true;
				if (mirrorRoots.includes(this.root)) {
					mirrorRoots = [];
				}
			}
		});
		void this.resolveRealRoot();
		void this.prune();
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
	 */
	localPathForHookPath(remotePath: string | undefined, token: string): string | undefined {
		if (this.disposed || !paradisIsRemoteAgentTranscriptPath(remotePath)) {
			return undefined;
		}
		const existing = this.entries.get(remotePath);
		if (existing !== undefined) {
			existing.notedAt = Date.now();
			existing.token = token;
			return existing.localPath;
		}
		const localPath = paradisRemoteTranscriptMirrorPathFor(this.root, remotePath);
		if (localPath === undefined) {
			return undefined;
		}
		this.entries.set(remotePath, {
			remotePath,
			localPath,
			size: 0,
			owner: undefined,
			ownerSeenAt: 0,
			notedAt: Date.now(),
			token,
			capped: false,
			chain: Promise.resolve(),
		});
		this.evictOverflow();
		this.logService.info(`[paradisRemoteTranscript] following a transcript on the host: ${remotePath}`);
		return localPath;
	}

	/**
	 * 担当ウィンドウが写すべきパスの一覧。空いているものと、自分が担当しているものを返す。
	 * 呼ぶこと自体が「まだ生きている」の合図になる。
	 */
	list(ownerId: string): readonly string[] {
		const now = Date.now();
		const paths: string[] = [];
		for (const entry of this.entries.values()) {
			if (entry.capped) {
				// 上限に達したものを返し続けると、担当ウィンドウが取り直して読んでは捨てる、を
				// 延々と繰り返すことになる（接続先を無駄に読み続ける）
				continue;
			}
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
	 * @returns 接続先の次に読む位置。担当を取れなければ {@link PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE}
	 */
	async begin(ownerId: string, remotePath: string): Promise<number> {
		const entry = this.entries.get(remotePath);
		if (entry === undefined || entry.capped) {
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
			// ウィンドウを開き直しても続きから写せるよう、実ファイルの大きさを正とする
			const stat = await fs.stat(entry.localPath).catch(() => undefined);
			entry.size = stat?.isFile() === true ? stat.size : 0;
			return entry.size;
		});
	}

	/**
	 * 接続先から読んだ続きを写しへ足す。
	 * @returns 次に読む位置。担当を失った・上限に達したときは {@link PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE}
	 */
	async append(ownerId: string, remotePath: string, data: Uint8Array): Promise<number> {
		const entry = this.entries.get(remotePath);
		if (entry === undefined || entry.owner !== ownerId) {
			return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
		}
		entry.ownerSeenAt = Date.now();
		if (data.byteLength === 0) {
			return entry.size;
		}
		return this.enqueue(entry, async () => {
			// 順番待ちの間に担当が変わっていることがある。書く直前にもう一度確かめる
			// （空いた隙に別のウィンドウが取り直して写しを捨てていると、混ざった中身になる）
			if (entry.owner !== ownerId) {
				return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
			}
			if (entry.size + data.byteLength > this.maxBytes) {
				if (!entry.capped) {
					entry.capped = true;
					this.logService.warn(`[paradisRemoteTranscript] stopped following ${entry.remotePath}; the copy reached its size limit`);
				}
				return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
			}
			await fs.appendFile(entry.localPath, data);
			entry.size += data.byteLength;
			return entry.size;
		});
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
			return 0;
		});
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
	 */
	retainLiveTokens(isLive: (token: string) => boolean): void {
		const now = Date.now();
		for (const [remotePath, entry] of [...this.entries]) {
			if (!isLive(entry.token) && now - entry.notedAt > RECENTLY_NOTED_MS) {
				this.entries.delete(remotePath);
			}
		}
	}

	private enqueue(entry: IMirrorEntry, work: () => Promise<number>): Promise<number> {
		const result = entry.chain.then(work);
		// 失敗しても次の追記は続けられる。取りこぼした分は担当ウィンドウが次の周期で読み直す
		entry.chain = result.then(() => undefined, () => undefined);
		return result.catch(error => {
			this.logService.warn(`[paradisRemoteTranscript] could not write the copy of ${entry.remotePath}`, error);
			return PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE;
		});
	}

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
	 * 起動時の掃除。使わなくなった写しがディスクに残り続けないようにする。
	 * 古いものから消し、それでも大きすぎるときは合計が収まるまで消す。
	 */
	private async prune(): Promise<void> {
		const files: { path: string; size: number; mtime: number }[] = [];
		const walk = async (dir: string, depth: number): Promise<void> => {
			if (depth > 12) {
				return;
			}
			const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined);
			for (const entry of entries ?? []) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					await walk(path, depth + 1);
				} else if (entry.isFile()) {
					const stat = await fs.stat(path).catch(() => undefined);
					if (stat !== undefined) {
						files.push({ path, size: stat.size, mtime: stat.mtimeMs });
					}
				}
			}
		};
		await walk(this.root, 0);
		if (this.disposed || files.length === 0) {
			return;
		}
		const now = Date.now();
		const doomed = new Set(files.filter(file => now - file.mtime > PRUNE_MAX_AGE_MS).map(file => file.path));
		let total = files.filter(file => !doomed.has(file.path)).reduce((sum, file) => sum + file.size, 0);
		if (total > PRUNE_MAX_TOTAL_BYTES) {
			for (const file of files.filter(file => !doomed.has(file.path)).sort((a, b) => a.mtime - b.mtime)) {
				if (total <= PRUNE_MAX_TOTAL_BYTES) {
					break;
				}
				doomed.add(file.path);
				total -= file.size;
			}
		}
		for (const path of doomed) {
			await fs.rm(path, { force: true }).catch(() => undefined);
		}
		if (doomed.size > 0) {
			this.logService.info(`[paradisRemoteTranscript] removed ${doomed.size} stale copies`);
		}
	}
}
