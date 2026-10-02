/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先で動く Codex の rollout を、hook が来なくても見つける（ウィンドウ側）。
//
// 接続先の会話は hook の `transcript_path` から写し始める（paradisRemoteTranscriptMirror）。hook が
// 1 件も届かない（接続先の Codex が hook を信頼していない・戻り経路が張れない・curl が無い等）と、
// 会話も状態も手元へ来ない。ここでは、ターミナルで `codex` の起動を見たら、接続先の Codex のホーム
// （`~/.codex` とアカウント用のホーム）の `sessions/<年>/<月>/<日>/` を見て rollout を探し、shared
// process へ知らせる（写しの対象に加わる）。
//
// 選び方:
//  - 新しく始めた会話（`codex`・`codex fork`）: 作業ディレクトリが同じ root の会話で、起動より後に
//    作られたもののうち一番新しいもの。一度受け付けた後は、それより後に作られた会話（/new 等）にだけ
//    乗り換える
//  - 再開（`codex resume <id>`）: 名前の末尾の thread id が一致する rollout だけ。id の無い再開
//    （一覧から選ぶ・`--last`）は取り違えるので探さない（hook に任せる）
//
// hook が届いているペインでは shared process が「hook がある」と答えるので、そこで探すのをやめる。

import { streamToBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { paradisParseCodexSessionMeta } from '../../sessionResume/common/paradisSessionTranscript.js';

/** 探し直す間隔。rollout は最初のターンで初めて作られるので、起動から作られるまでの間も探し続ける。 */
const POLL_INTERVAL_MS = 5_000;

/** 受け付けた後の間隔。/new で別の会話に移ったか、hook が届き始めたかを見るだけなので間を空ける。 */
const ACCEPTED_POLL_INTERVAL_MS = 60_000;

/** 起動より少し前に書かれたものまで受け付ける（時計のずれ）。 */
const START_TOLERANCE_MS = 15_000;

/** 先頭行（session_meta）を読む上限。base_instructions を含むと 20KB を超える。 */
const FIRST_LINE_MAX_BYTES = 512 * 1024;

/** 1 回に先頭行を読む rollout の上限（新しい順。子の会話と分かっているものは数えない）。 */
const MAX_CANDIDATES_PER_POLL = 8;

/** 再開する会話を id で探すとき、ホームごとに遡る日付のフォルダの上限。 */
const MAX_RESUME_DAY_FOLDERS = 120;

/**
 * 再開する会話が見つからなかった回数ごとの、次に探すまでの間隔。見つからない間に深い走査を繰り返して
 * 接続先を叩き続けないよう、間を空けていく。
 */
const RESUME_MISS_INTERVALS_MS = [5_000, 30_000, 120_000];

/** 深い走査（古い日付まで遡る）を試す回数。これを過ぎたら、今日の前後のフォルダだけを見る。 */
const MAX_DEEP_RESUME_SCANS = 3;

/** 接続先の地方時が取りうる UTC からのずれ（UTC-12 〜 UTC+14）。 */
const MIN_UTC_OFFSET_MS = -12 * 60 * 60 * 1000;
const MAX_UTC_OFFSET_MS = 14 * 60 * 60 * 1000;

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_NAME_PATTERN = /^rollout-.+-(?<threadId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** 見つけた rollout を知らせた返事。 */
export type ParadisRemoteRolloutReport = 'accepted' | 'ignored' | 'hooked' | 'stale';

export interface IParadisRemoteCodexRolloutDiscoveryHost {
	readonly fileService: Pick<IFileService, 'resolve' | 'readFileStream'>;
	/** 接続先の Codex のホーム（`~/.codex`・`$CODEX_HOME`・アカウント用のホーム）。まだ分からなければ空。 */
	resolveCodexHomes(): Promise<readonly URI[]>;
	/** 見つけた rollout（接続先のパス）を shared process へ知らせる。 */
	report(token: string, remotePath: string, commandStartedAt: number): Promise<ParadisRemoteRolloutReport>;
	/** 探してよいか（モバイル連携が無効なら写しは要らない）。 */
	readonly isActive?: () => boolean;
	readonly now?: () => number;
	readonly schedule?: (callback: () => void, delayMs: number) => { dispose(): void };
}

interface IWatch {
	readonly cwd: string;
	readonly mode: 'new' | 'resume' | 'fork';
	/** 再開の対象（`codex resume <id>`）。 */
	readonly threadId: string | undefined;
	readonly startedAt: number;
	/** 受け付けた rollout と、その作成時刻。 */
	reported?: { readonly path: string; readonly createdAt: number | undefined };
	/** 再開の対象を見つけたパス（見つけたら二度と探さない）。 */
	resumePath?: string;
	/** 再開の対象を探して見つからなかった回数。 */
	resumeMisses: number;
	timer?: { dispose(): void };
	polling: boolean;
}

interface IRolloutMeta {
	readonly cwd: string;
	readonly subagent: boolean;
	readonly createdAt?: number;
	/** 対話の TUI 以外（`codex exec`・MCP サーバー・内部の会話）が作ったもの。 */
	readonly nonInteractive: boolean;
}

/** 末尾の `/` を落とす（ルートはそのまま）。 */
function trimTrailingSlash(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function twoDigits(value: number): string {
	return String(value).padStart(2, '0');
}

/** session_meta の作成時刻（`payload.timestamp`、UTC の ISO 文字列）。読めなければ undefined。 */
function sessionMetaCreatedAt(firstLine: string): number | undefined {
	try {
		const parsed: unknown = JSON.parse(firstLine);
		const payload = typeof parsed === 'object' && parsed !== null ? (parsed as { payload?: unknown }).payload : undefined;
		const timestamp = typeof payload === 'object' && payload !== null ? (payload as { timestamp?: unknown }).timestamp : undefined;
		const value = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * session_meta が対話の TUI 以外で作られたものか（`source` が `exec`・`mcp`・内部用、または
 * `originator` が `codex_exec`）。`source` の無い古い rollout は対話として扱う。
 */
function sessionMetaIsNonInteractive(firstLine: string): boolean {
	try {
		const parsed: unknown = JSON.parse(firstLine);
		const payload = typeof parsed === 'object' && parsed !== null ? (parsed as { payload?: unknown }).payload : undefined;
		if (typeof payload !== 'object' || payload === null) {
			return false;
		}
		const { source, originator } = payload as { source?: unknown; originator?: unknown };
		if (originator === 'codex_exec' || source === 'exec' || source === 'mcp') {
			return true;
		}
		return typeof source === 'object' && source !== null && (source as { internal?: unknown }).internal !== undefined;
	} catch {
		return false;
	}
}

/**
 * 見るべき日付のフォルダ（`年/月/日`）。Codex は接続先の地方時の日付でフォルダを切るが、その時差は
 * 分からない。起動から今までの各時刻について、地方時が取りうる範囲（UTC-12 〜 UTC+14）の両端を UTC で
 * 日付にする。日付の境目から遠い間は、UTC の前後 1 日のうち要るほうだけが加わる。
 */
export function paradisRolloutDayFolders(from: number, to: number): string[] {
	const days = new Set<string>();
	const addUtcDay = (time: number) => {
		const date = new Date(time);
		days.add(`${date.getUTCFullYear()}/${twoDigits(date.getUTCMonth() + 1)}/${twoDigits(date.getUTCDate())}`);
	};
	const add = (time: number) => {
		addUtcDay(time + MIN_UTC_OFFSET_MS);
		addUtcDay(time);
		addUtcDay(time + MAX_UTC_OFFSET_MS);
	};
	const step = 6 * 60 * 60 * 1000;
	for (let time = from; time < to; time += step) {
		add(time);
	}
	add(to);
	return [...days];
}

/**
 * 接続先の Codex の rollout を、ペインごとに探し続ける。
 */
export class ParadisRemoteCodexRolloutDiscovery extends Disposable {

	private readonly watches = new Map<string, IWatch>();
	/** rollout の先頭行の読み取り結果（URI → 中身）。読めないもの（形が違う）は null。読みかけは覚えない。 */
	private readonly metaCache = new Map<string, IRolloutMeta | null>();

	constructor(private readonly host: IParadisRemoteCodexRolloutDiscoveryHost) {
		super();
		this._register({ dispose: () => { for (const token of [...this.watches.keys()]) { this.stop(token); } } });
	}

	private now(): number {
		return (this.host.now ?? Date.now)();
	}

	/**
	 * ターミナルで `codex` が起動した。cwd は接続先のパス。
	 * @param threadId `codex resume <id>` の id（無ければ undefined）
	 */
	start(token: string, cwd: string, mode: 'new' | 'resume' | 'fork', threadId?: string): void {
		this.stop(token);
		if (this._store.isDisposed || !cwd.startsWith('/') || this.host.isActive?.() === false) {
			return;
		}
		const validThreadId = threadId !== undefined && THREAD_ID_PATTERN.test(threadId) ? threadId.toLowerCase() : undefined;
		if (mode === 'resume' && validThreadId === undefined) {
			// 何を再開したか分からない。同じ場所の別の会話を取り違えるより、hook を待つ
			return;
		}
		const watch: IWatch = { cwd: trimTrailingSlash(cwd), mode, threadId: mode === 'resume' ? validThreadId : undefined, startedAt: this.now(), polling: false, resumeMisses: 0 };
		this.watches.set(token, watch);
		this.scheduleNext(token, watch, 2_000);
	}

	/** Codex が終わった（またはペインが消えた）。 */
	stop(token: string): void {
		const watch = this.watches.get(token);
		watch?.timer?.dispose();
		this.watches.delete(token);
	}

	/** 全て止める（モバイル連携が無効になった）。 */
	stopAll(): void {
		for (const token of [...this.watches.keys()]) {
			this.stop(token);
		}
	}

	/** 探しているペイン（テスト用）。 */
	get watchedTokens(): readonly string[] {
		return [...this.watches.keys()];
	}

	private scheduleNext(token: string, watch: IWatch, delayMs: number): void {
		const schedule = this.host.schedule ?? ((callback: () => void, ms: number) => {
			const handle = setTimeout(callback, ms);
			return { dispose: () => clearTimeout(handle) };
		});
		watch.timer = schedule(() => void this.pollWatch(token, watch), delayMs);
	}

	/** 1 回探す（テスト用。普段は一定の間隔で自分から探す）。 */
	poll(token: string): Promise<void> {
		const watch = this.watches.get(token);
		watch?.timer?.dispose();
		return watch === undefined ? Promise.resolve() : this.pollWatch(token, watch);
	}

	private async pollWatch(token: string, watch: IWatch): Promise<void> {
		if (this.watches.get(token) !== watch || watch.polling) {
			return;
		}
		if (this.host.isActive?.() === false) {
			this.stop(token);
			return;
		}
		watch.polling = true;
		let keepWatching = true;
		try {
			const found = await this.findRollout(watch, token);
			if (this.watches.get(token) === watch) {
				// 何も見つからなくても、受け付けた後は hook が届き始めたかを確かめる（届いていれば止める）
				const target = found ?? watch.reported;
				if (target !== undefined) {
					const answer = await this.host.report(token, target.path, watch.startedAt);
					if (answer === 'accepted') {
						watch.reported = target;
					} else if (answer === 'hooked' || answer === 'stale') {
						keepWatching = false;
					}
				}
			}
		} catch {
			// 接続先が一時的に読めない。次の周回で試す
		} finally {
			watch.polling = false;
		}
		if (this.watches.get(token) !== watch) {
			return;
		}
		if (!keepWatching) {
			this.stop(token);
			return;
		}
		// 再開の会話は id で決まるので、受け付けた後に探し直す理由は hook の確認だけ。見つからない間は
		// 間を空けていく
		const delay = watch.reported !== undefined
			? ACCEPTED_POLL_INTERVAL_MS
			: watch.mode === 'resume'
				? RESUME_MISS_INTERVALS_MS[Math.min(watch.resumeMisses, RESUME_MISS_INTERVALS_MS.length) - 1] ?? POLL_INTERVAL_MS
				: POLL_INTERVAL_MS;
		this.scheduleNext(token, watch, delay);
	}

	/** 他のペインが知らせ済みの rollout（同じ作業ディレクトリの別の Codex を取らない）。 */
	private claimedByOthers(token: string): Set<string> {
		const claimed = new Set<string>();
		for (const [other, watch] of this.watches) {
			if (other !== token && watch.reported !== undefined) {
				claimed.add(watch.reported.path);
			}
		}
		return claimed;
	}

	/** 今回知らせるべき rollout。受け付け済みのものから変える理由が無ければ undefined。 */
	private async findRollout(watch: IWatch, token: string): Promise<{ readonly path: string; readonly createdAt: number | undefined } | undefined> {
		const homes = await this.host.resolveCodexHomes();
		if (homes.length === 0) {
			return undefined;
		}
		if (watch.mode === 'resume') {
			if (watch.reported !== undefined) {
				return undefined;
			}
			// 古い日付まで遡る走査は数回だけ。それでも見つからなければ、今日の前後のフォルダだけを見る
			const path = watch.resumePath ?? (watch.resumeMisses < MAX_DEEP_RESUME_SCANS
				? await this.findByThreadId(homes, watch.threadId!)
				: await this.findByThreadIdInRecentDays(homes, watch.threadId!, watch.startedAt - START_TOLERANCE_MS));
			if (path === undefined) {
				watch.resumeMisses++;
				return undefined;
			}
			watch.resumePath = path;
			const meta = await this.readMeta(URI.from({ scheme: homes[0].scheme, authority: homes[0].authority, path }));
			return meta === undefined || meta === null || meta.subagent || meta.nonInteractive ? undefined : { path, createdAt: meta.createdAt };
		}
		const minTime = watch.startedAt - START_TOLERANCE_MS;
		const candidates: { readonly uri: URI; readonly mtime: number }[] = [];
		for (const home of homes) {
			for (const day of paradisRolloutDayFolders(minTime, this.now())) {
				const directory = joinPath(home, 'sessions', ...day.split('/'));
				const stat = await this.host.fileService.resolve(directory, { resolveMetadata: true }).catch(() => undefined);
				for (const child of stat?.children ?? []) {
					if (!child.isFile || !ROLLOUT_NAME_PATTERN.test(child.name) || child.mtime < minTime) {
						continue;
					}
					candidates.push({ uri: child.resource, mtime: child.mtime });
				}
			}
		}
		const claimed = this.claimedByOthers(token);
		candidates.sort((a, b) => b.mtime - a.mtime);
		let read = 0;
		// 起動後に作られたうちで一番古いもの（受け付けた後は、受け付けたものより後に作られたうちで一番古いもの）。
		// 一番新しいものを選ぶと、同じ場所で後から起動した別の Codex の会話を取りうる
		const after = watch.reported?.createdAt ?? Number.NEGATIVE_INFINITY;
		let best: { readonly path: string; readonly createdAt: number } | undefined;
		for (const candidate of candidates) {
			const path = candidate.uri.path;
			if (claimed.has(path) || path === watch.reported?.path) {
				continue;
			}
			const cached = this.metaCache.get(candidate.uri.toString());
			if (cached === null || cached?.subagent === true || cached?.nonInteractive === true) {
				// 子の会話・対話以外・形の違うものは件数に入れない（それらが上位を埋めて親が漏れないように）
				continue;
			}
			if (cached === undefined) {
				if (read >= MAX_CANDIDATES_PER_POLL) {
					continue;
				}
				read++;
			}
			const meta = cached ?? await this.readMeta(candidate.uri);
			if (meta === undefined || meta === null || meta.subagent || meta.nonInteractive || trimTrailingSlash(meta.cwd) !== watch.cwd) {
				continue;
			}
			// 起動より後に作られたものだけ（同じ場所の古い会話を取らない）。作成時刻が読めないものは取らない
			if (meta.createdAt === undefined || meta.createdAt < minTime) {
				continue;
			}
			// 受け付けた後は、それより後に作られた会話（/new 等）にだけ乗り換える
			if (meta.createdAt <= after || (watch.reported !== undefined && watch.reported.createdAt === undefined)) {
				continue;
			}
			if (best === undefined || meta.createdAt < best.createdAt) {
				best = { path, createdAt: meta.createdAt };
			}
		}
		return best;
	}

	/** thread id が名前の末尾に付いた rollout を、新しい日付のフォルダから順に探す。 */
	private async findByThreadId(homes: readonly URI[], threadId: string): Promise<string | undefined> {
		const suffix = `-${threadId}.jsonl`;
		const children = async (uri: URI) => {
			const stat = await this.host.fileService.resolve(uri).catch(() => undefined);
			return stat?.children ?? [];
		};
		const byNameDescending = <T extends { readonly name: string }>(entries: readonly T[]) => [...entries].sort((a, b) => b.name.localeCompare(a.name));
		for (const home of homes) {
			// 上限はホームごとに数える（1 つ目のホームの走査で、ほかのホームを見ないまま諦めない）
			let visited = 0;
			homeScan: for (const year of byNameDescending((await children(joinPath(home, 'sessions'))).filter(entry => entry.isDirectory && /^\d{4}$/.test(entry.name)))) {
				for (const month of byNameDescending((await children(year.resource)).filter(entry => entry.isDirectory && /^\d{2}$/.test(entry.name)))) {
					for (const day of byNameDescending((await children(month.resource)).filter(entry => entry.isDirectory && /^\d{2}$/.test(entry.name)))) {
						if (++visited > MAX_RESUME_DAY_FOLDERS) {
							break homeScan;
						}
						const match = (await children(day.resource)).find(entry => entry.isFile && entry.name.toLowerCase().endsWith(suffix) && ROLLOUT_NAME_PATTERN.test(entry.name));
						if (match !== undefined) {
							return match.resource.path;
						}
					}
				}
			}
		}
		return undefined;
	}

	/** thread id が名前の末尾に付いた rollout を、起動から今までの日付のフォルダだけで探す。 */
	private async findByThreadIdInRecentDays(homes: readonly URI[], threadId: string, from: number): Promise<string | undefined> {
		const suffix = `-${threadId}.jsonl`;
		for (const home of homes) {
			for (const day of paradisRolloutDayFolders(from, this.now())) {
				const stat = await this.host.fileService.resolve(joinPath(home, 'sessions', ...day.split('/'))).catch(() => undefined);
				const match = stat?.children?.find(entry => entry.isFile && entry.name.toLowerCase().endsWith(suffix) && ROLLOUT_NAME_PATTERN.test(entry.name));
				if (match !== undefined) {
					return match.resource.path;
				}
			}
		}
		return undefined;
	}

	private async readMeta(uri: URI): Promise<IRolloutMeta | null | undefined> {
		const key = uri.toString();
		const cached = this.metaCache.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const stream = await this.host.fileService.readFileStream(uri, { position: 0, length: FIRST_LINE_MAX_BYTES }).catch(() => undefined);
		if (stream === undefined) {
			return undefined;
		}
		const text = (await streamToBuffer(stream.value)).toString();
		const newline = text.indexOf('\n');
		if (newline < 0) {
			// まだ書きかけか、上限より長い。覚えずに次の周回で読み直す
			return undefined;
		}
		const firstLine = text.slice(0, newline);
		const meta = paradisParseCodexSessionMeta(firstLine);
		const result = meta === undefined ? null : { cwd: meta.cwd, subagent: meta.subagent, createdAt: sessionMetaCreatedAt(firstLine), nonInteractive: sessionMetaIsNonInteractive(firstLine) };
		if (this.metaCache.size > 500) {
			this.metaCache.clear();
		}
		this.metaCache.set(key, result);
		return result;
	}
}
