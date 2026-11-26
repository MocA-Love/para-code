/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 見つからなくなった資料の、移動先の追従と後片付け。ウィンドウで動く（ファイルを読むのはウィンドウの IFileService なので、
// SSH の窓では接続先のファイルを同じ手順で見る）。台帳を書くのは shared process で、ここは頼むだけ。
//
//  - 指紋: スペース（か開いているフォルダ）の中の資料の、大きさ・更新時刻・中身の SHA-256 を控える。書かれるたびに取り直す
//  - 追従: 資料が消えたら、同じスペースの中の html・md を 1 回だけ探し、指紋と同じ中身のファイルへ記録の場所を書き換える。
//    決めるのは中身のハッシュの一致だけ（大きさ・ファイルの変化の知らせは候補を絞るだけで、名前は見ない）。
//    一致が 2 つ以上・探しきれなかった・指紋が無い資料は決めない
//  - 後片付け: 見つからないまま {@link PARADIS_DOC_MISSING_RETENTION_MS} が過ぎた資料は、もう一度確かめてから一覧から外す
//    （数えるのは `missingCountedFrom` から。この項目の無い古い記録は、初めて見直したときから数える）

import { IParadisDocFingerprint, PARADIS_DOC_BACKGROUND_WATCH_EXCLUDES, paradisDocKey, paradisDocKind, paradisIsInsideFolder, paradisIsWatchableDocPath } from './paradisAgentDocs.js';
import { IParadisDocViewRecord } from './paradisAgentDocsView.js';

/** 見つからないままの資料を一覧から外すまでの時間（7 日）。 */
export const PARADIS_DOC_MISSING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 指紋を取るファイルの大きさの上限。これより大きい資料は追従しない。 */
export const PARADIS_DOC_FINGERPRINT_MAX_BYTES = 8 * 1024 * 1024;
/** 1 回の探索で受け取るファイルの数の上限。超えたら探しきれなかったものとして決めない。 */
export const PARADIS_DOC_RELOCATE_MAX_FOUND = 20_000;
/** 1 件の資料につき大きさを確かめる候補（同じ種類のファイル）の数の上限。超えたら決めない。 */
export const PARADIS_DOC_RELOCATE_MAX_STATS = 2_000;
/** 1 件の資料につき中身を読む候補の数の上限（同じ大きさのもの）。超えたら決めない。 */
export const PARADIS_DOC_RELOCATE_MAX_HASHES = 8;
/**
 * 探索が降りないフォルダ（見張りが拾わないもの、ビルドの出力、エージェントが作るワークツリー）。消した資料の写しが
 * ここに残っていても、移動先にはしない。
 */
export const PARADIS_DOC_RELOCATE_EXCLUDES: readonly string[] = [...PARADIS_DOC_BACKGROUND_WATCH_EXCLUDES, '**/out/**', '**/dist/**', '**/build/**', '**/.claude/worktrees/**'];

/** 1 回の見直しで指紋を取る資料の数の上限（残りは次の見直しで取る）。 */
const FINGERPRINTS_PER_PASS = 200;
/** 1 回の見直しで後片付けを確かめる資料の数の上限。 */
const PRUNES_PER_PASS = 200;
/** 同時に確かめるファイルの数。 */
const CONCURRENCY = 4;
/** 1 回の知らせで見る、消えたパスの数の上限（ブランチの切り替えなど。超えた分は、一覧を開いたときの確かめに任せる）。 */
const MAX_DELETED_PER_EVENT = 200;
/** 見直しを待つ、現れたファイルの数の上限。 */
const MAX_PENDING_ADDED = 2_000;
/** 探索に失敗した（探す係がまだ居ない・締め切り・つながらない）スペースを、次に探すまでの間。 */
export const PARADIS_DOC_RELOCATE_RETRY_MS = 30_000;
/** 後片付けで「まだ無い」と確かめられなかった資料を、次に確かめるまでの間。 */
const PRUNE_RECHECK_MS = 60 * 60 * 1000;

/** ファイルの大きさと更新時刻。 */
export interface IParadisDocFileStat {
	readonly size: number;
	readonly mtime: number;
}

/** 台帳へ頼む指紋 1 件。 */
export interface IParadisDocFingerprintUpdate {
	readonly path: string;
	readonly fingerprint: IParadisDocFingerprint;
}

/** ファイルの変化の知らせ（このウィンドウの機械の、正規化した絶対パス）。 */
export interface IParadisDocFileChanges {
	readonly added: readonly string[];
	readonly updated: readonly string[];
	readonly deleted: readonly string[];
}

/** 追従が使う、ウィンドウと台帳の部分（テストでは差し替える）。パスはどれもこのウィンドウの機械の絶対パス。 */
export interface IParadisDocRelocatorHost {
	/** このウィンドウの接続先の印（手元は空文字）。 */
	readonly hostId: string;
	now(): number;
	/** 台帳の全件。 */
	list(): Promise<readonly IParadisDocViewRecord[]>;
	/** スペースと開いているフォルダ（このウィンドウの機械のもの）。 */
	roots(): readonly string[];
	/** ファイルの大きさと更新時刻。無ければ 'missing'、確かめられなければ（読めない・つながらない・フォルダだった）undefined。 */
	stat(path: string): Promise<IParadisDocFileStat | 'missing' | undefined>;
	/** 中身の SHA-256 と、読んだ大きさ。読めなければ undefined。 */
	hash(path: string): Promise<{ readonly hash: string; readonly size: number } | undefined>;
	/** フォルダの中の html・md（{@link PARADIS_DOC_RELOCATE_EXCLUDES} を除く）。`complete` が false なら上限で打ち切った。探せなければ undefined。 */
	findDocs(root: string): Promise<{ readonly paths: readonly string[]; readonly complete: boolean } | undefined>;
	setFingerprints(updates: readonly IParadisDocFingerprintUpdate[]): Promise<void>;
	setMissing(path: string, missing: boolean): Promise<void>;
	/** 記録の場所を書き換える。`hash` は確かめた中身のハッシュ。台帳が断ったら false。 */
	relocate(from: string, to: string, hash: string): Promise<boolean>;
	remove(paths: readonly string[]): Promise<void>;
}

/** 資料が入っているスペース（いちばん深いもの）。どのスペースの中でもなければ undefined。 */
export function paradisDocRootOf(path: string, roots: readonly string[]): string | undefined {
	let best: string | undefined;
	for (const root of roots) {
		if (paradisIsInsideFolder(path, root) && (best === undefined || root.length > best.length)) {
			best = root;
		}
	}
	return best;
}

/**
 * 取り外しのできる記憶装置の置き場所（macOS の `/Volumes/<名前>`、Linux の `/mnt/<名前>`・`/media/<利用者>/<名前>`・
 * `/run/media/<利用者>/<名前>`）。その上のパスでなければ undefined。
 */
export function paradisDocMountPoint(path: string): string | undefined {
	return /^(?<mount>\/(?:Volumes|mnt)\/[^/]+|\/(?:run\/)?media\/[^/]+\/[^/]+)\//.exec(path)?.groups?.mount;
}

/**
 * その記録を、移動先の記録として上書きしてよいか（ウィンドウの側の見立て。決めるのは台帳）。見張りが拾っただけ・
 * 利用者が開いただけの記録は、移ってきたファイルを見張りが先に載せたものでありうる。
 */
function isWeakRecord(record: IParadisDocViewRecord): boolean {
	return (record.owner === undefined || record.owner.via === 'watch') && (record.registeredBy === 'watch' || record.registeredBy === 'user_opened');
}

async function forEachLimited<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			await run(items[next++]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/** 1 回の探索の間だけ使う、大きさとハッシュの控え。 */
class Probe {

	private readonly _sizes = new Map<string, Promise<number | undefined>>();
	private readonly _hashes = new Map<string, Promise<string | undefined>>();

	constructor(private readonly _host: IParadisDocRelocatorHost) { }

	size(path: string): Promise<number | undefined> {
		let size = this._sizes.get(path);
		if (size === undefined) {
			size = this._host.stat(path).then(stat => typeof stat === 'object' ? stat.size : undefined, () => undefined);
			this._sizes.set(path, size);
		}
		return size;
	}

	hash(path: string): Promise<string | undefined> {
		let hash = this._hashes.get(path);
		if (hash === undefined) {
			hash = this._host.hash(path).then(result => result?.hash, () => undefined);
			this._hashes.set(path, hash);
		}
		return hash;
	}
}

export class ParadisDocRelocator {

	private _running: Promise<void> | undefined;
	private _again = false;
	/** 指紋を取ろうとした資料（キー → そのときの最後の動き）。取れなかった資料を見直しのたびに読み直さない。 */
	private readonly _fingerprintTried = new Map<string, number>();
	/** ファイルが変わったと知らされた資料（指紋を取り直す）。 */
	private readonly _dirty = new Set<string>();
	/** 移動先を探し終えた、見つからない資料。また見つかるまで探し直さない。 */
	private readonly _scanned = new Set<string>();
	/** 後片付けで確かめた時刻（キー → 時刻）。 */
	private readonly _pruneChecked = new Map<string, number>();
	/** 数え始め（`missingCountedFrom`）を台帳に頼んだ資料（数え始めを書かない古い台帳へ、見直しのたびに頼み直さない）。 */
	private readonly _countRequested = new Set<string>();
	/** 探索に失敗したスペース（フォルダ → 失敗した時刻）。 */
	private readonly _searchFailed = new Map<string, number>();
	private _pendingAdded = new Set<string>();
	private _pendingDeleted = new Set<string>();
	/** 前の見直しで台帳にあった、このウィンドウの機械の資料（パス → 見つからない資料か）。知らせを選ぶのに使う。 */
	private _known = new Map<string, boolean>();

	constructor(private readonly _host: IParadisDocRelocatorHost) { }

	/** 探索に失敗して、探し直しを待っている資料があるか（呼び出し側が {@link PARADIS_DOC_RELOCATE_RETRY_MS} の後にもう一度 sync する）。 */
	get needsRetry(): boolean {
		return this._searchFailed.size > 0;
	}

	/** 台帳を読み直して、指紋・追従・後片付けを進める。動いている間に呼ばれたら、終わってからもう 1 回だけ回る。 */
	sync(): Promise<void> {
		if (this._running !== undefined) {
			this._again = true;
			return this._running;
		}
		const run = async () => {
			do {
				this._again = false;
				try {
					await this._pass();
				} catch {
					// 台帳に頼めなかった（shared process の再起動など）。次の知らせでやり直す
				}
			} while (this._again);
		};
		this._running = run().finally(() => this._running = undefined);
		return this._running;
	}

	/**
	 * ファイルの変化の知らせ。台帳の資料に関わるものだけを控えて見直す: 消えた資料（フォルダごと消えたものも）、
	 * 変わった資料、見つからない資料があるときに現れた html・md。
	 */
	filesChanged(changes: IParadisDocFileChanges): Promise<void> {
		let relevant = false;
		const deleted = changes.deleted.slice(0, MAX_DELETED_PER_EVENT);
		for (const [path, missing] of this._known) {
			if (!missing && deleted.some(gone => paradisIsInsideFolder(path, gone))) {
				this._pendingDeleted.add(path);
				relevant = true;
			}
		}
		const waiting = [...this._known.values()].some(missing => missing);
		for (const path of changes.added) {
			if (this._known.has(path)) {
				this._dirty.add(paradisDocKey(this._host.hostId, path));
				relevant = true;
			}
			if (waiting && this._pendingAdded.size < MAX_PENDING_ADDED && paradisIsWatchableDocPath(path)) {
				this._pendingAdded.add(path);
				relevant = true;
			}
		}
		for (const path of changes.updated) {
			if (this._known.get(path) === false) {
				this._dirty.add(paradisDocKey(this._host.hostId, path));
				relevant = true;
			}
		}
		return relevant ? this.sync() : Promise.resolve();
	}

	private _key(record: IParadisDocViewRecord): string {
		return paradisDocKey(record.hostId, record.path);
	}

	private async _pass(): Promise<void> {
		const host = this._host;
		const added = [...this._pendingAdded];
		const deleted = this._pendingDeleted;
		this._pendingAdded = new Set();
		this._pendingDeleted = new Set();
		const records = (await host.list()).filter(record => record.hostId === host.hostId);
		const roots = host.roots();
		const known = new Set<string>();
		this._known = new Map(records.map(record => [record.path, record.missingSince !== undefined]));
		for (const record of records) {
			const key = this._key(record);
			known.add(key);
			if (record.missingSince === undefined) {
				this._scanned.delete(key);
				this._pruneChecked.delete(key);
				this._countRequested.delete(key);
			}
		}
		for (const tracked of [this._fingerprintTried, this._pruneChecked]) {
			for (const key of [...tracked.keys()]) {
				if (!known.has(key)) {
					tracked.delete(key);
				}
			}
		}
		for (const key of [...this._dirty, ...this._scanned, ...this._countRequested]) {
			if (!known.has(key)) {
				this._dirty.delete(key);
				this._scanned.delete(key);
				this._countRequested.delete(key);
			}
		}

		// 消えたと知らされた資料を確かめる
		const gone: IParadisDocViewRecord[] = [];
		await forEachLimited(records.filter(record => record.missingSince === undefined && deleted.has(record.path)), async record => {
			if (await host.stat(record.path).catch(() => undefined) === 'missing') {
				gone.push(record);
			}
		});
		const goneKeys = new Set(gone.map(record => this._key(record)));
		await this._fingerprint(records.filter(record => !goneKeys.has(this._key(record))), roots, gone);

		// 移動先を探す: 今消えたと分かった資料と、台帳で見つからないままの、まだ探していない資料
		const relocated = new Set<string>();
		const searching = [...gone, ...records.filter(record => record.missingSince !== undefined && !this._scanned.has(this._key(record)))];
		// 探索に失敗したスペースの資料は「探し終えた」にせず、間を置いて探し直す
		const unsearched = new Set<string>();
		for (const [root, wanted] of this._byRoot(searching.filter(record => record.fingerprint !== undefined), roots)) {
			const failedAt = this._searchFailed.get(root);
			const found = failedAt !== undefined && host.now() - failedAt < PARADIS_DOC_RELOCATE_RETRY_MS ? undefined : await host.findDocs(root).catch(() => undefined);
			if (found === undefined) {
				if (failedAt === undefined || host.now() - failedAt >= PARADIS_DOC_RELOCATE_RETRY_MS) {
					this._searchFailed.set(root, host.now());
				}
				wanted.forEach(record => unsearched.add(this._key(record)));
				continue;
			}
			this._searchFailed.delete(root);
			if (found.complete) {
				await this._relocate(wanted, this._inRoot(found.paths, root, roots), records, relocated);
			}
		}
		for (const root of [...this._searchFailed.keys()]) {
			if (!roots.includes(root)) {
				this._searchFailed.delete(root);
			}
		}
		for (const record of searching) {
			const key = this._key(record);
			if (!relocated.has(key)) {
				if (!unsearched.has(key)) {
					this._scanned.add(key);
				}
				if (record.missingSince === undefined) {
					await host.setMissing(record.path, true);
				}
			}
		}

		// 後から現れたファイル: 元の場所へ戻ったものは印を外し、ほかは探し終えた資料の移動先の候補にする
		if (added.length > 0) {
			const waiting = records.filter(record => record.missingSince !== undefined && !relocated.has(this._key(record)));
			for (const record of waiting) {
				if (added.includes(record.path) && typeof await host.stat(record.path).catch(() => undefined) === 'object') {
					relocated.add(this._key(record));
					await host.setMissing(record.path, false);
				}
			}
			for (const [root, wanted] of this._byRoot(waiting.filter(record => record.fingerprint !== undefined && !relocated.has(this._key(record))), roots)) {
				await this._relocate(wanted, this._inRoot(added, root, roots), records, relocated);
			}
		}

		await this._prune(records.filter(record => record.missingSince !== undefined && !relocated.has(this._key(record))));
	}

	/** そのスペースのファイルだけ（中に入れ子になった別のスペース、たとえば git のワークツリーのファイルは、同じ中身の別物）。 */
	private _inRoot(paths: readonly string[], root: string, roots: readonly string[]): string[] {
		return paths.filter(path => paradisDocRootOf(path, roots) === root);
	}

	private _byRoot(records: readonly IParadisDocViewRecord[], roots: readonly string[]): Map<string, IParadisDocViewRecord[]> {
		const byRoot = new Map<string, IParadisDocViewRecord[]>();
		for (const record of records) {
			const root = paradisDocRootOf(record.path, roots);
			if (root !== undefined) {
				byRoot.set(root, [...(byRoot.get(root) ?? []), record]);
			}
		}
		return byRoot;
	}

	/** スペースの中の、指紋が無い・書かれた後に取っていない・変わったと知らされた資料の指紋を取る。無かった資料は `gone` へ足す。 */
	private async _fingerprint(records: readonly IParadisDocViewRecord[], roots: readonly string[], gone: IParadisDocViewRecord[]): Promise<void> {
		const host = this._host;
		const wanted = records.filter(record => {
			if (record.missingSince !== undefined || paradisDocRootOf(record.path, roots) === undefined) {
				return false;
			}
			const key = this._key(record);
			if (this._dirty.has(key)) {
				return true;
			}
			return (record.fingerprint === undefined || record.lastActivity > record.fingerprint.at) && this._fingerprintTried.get(key) !== record.lastActivity;
		});
		if (wanted.length > FINGERPRINTS_PER_PASS) {
			this._again = true;
		}
		const updates: IParadisDocFingerprintUpdate[] = [];
		await forEachLimited(wanted.slice(0, FINGERPRINTS_PER_PASS), async record => {
			const key = this._key(record);
			this._dirty.delete(key);
			this._fingerprintTried.set(key, record.lastActivity);
			const stat = await host.stat(record.path).catch(() => undefined);
			if (stat === 'missing') {
				gone.push(record);
				return;
			}
			if (stat === undefined || stat.size === 0 || stat.size > PARADIS_DOC_FINGERPRINT_MAX_BYTES) {
				return;
			}
			// 行の時刻が進んだ時計のものでも、取り直しを繰り返さないようにする
			const at = Math.max(host.now(), record.lastActivity);
			const previous = record.fingerprint;
			if (previous !== undefined && previous.size === stat.size && previous.mtime === stat.mtime) {
				if (record.lastActivity > previous.at) {
					updates.push({ path: record.path, fingerprint: { ...previous, at } });
				}
				return;
			}
			const read = await host.hash(record.path).catch(() => undefined);
			if (read !== undefined && read.size > 0) {
				updates.push({ path: record.path, fingerprint: { size: read.size, mtime: stat.mtime, hash: read.hash, at } });
			}
		});
		if (updates.length > 0) {
			await host.setFingerprints(updates);
		}
	}

	/** `wanted` の資料の移動先を `paths` から選び、決まったものの記録の場所を書き換える。 */
	private async _relocate(wanted: readonly IParadisDocViewRecord[], paths: readonly string[], records: readonly IParadisDocViewRecord[], relocated: Set<string>): Promise<void> {
		const host = this._host;
		// ほかの資料として載っているファイルは移動先にしない（見張りが先に載せただけの記録は除く）
		const taken = new Set(records.filter(record => record.missingSince === undefined && !isWeakRecord(record)).map(record => record.path));
		const candidates = [...new Set(paths)].filter(path => paradisIsWatchableDocPath(path) && !taken.has(path));
		const probe = new Probe(host);
		for (const record of wanted) {
			const target = await this._pick(record, candidates.filter(path => path !== record.path && !taken.has(path) && paradisDocKind(path) === record.kind), probe);
			if (target !== undefined && await host.relocate(record.path, target, record.fingerprint!.hash)) {
				taken.add(target);
				relocated.add(this._key(record));
			}
		}
	}

	/**
	 * 指紋と同じ中身の候補。スペースの中の同じ種類の候補をすべて見て、一致が 1 つだけのときに決める（名前が同じでも、
	 * 同じ中身のファイルがほかにあれば決めない）。確かめきれない数の候補があるときも決めない。
	 */
	private async _pick(record: IParadisDocViewRecord, candidates: readonly string[], probe: Probe): Promise<string | undefined> {
		const fingerprint = record.fingerprint!;
		if (candidates.length > PARADIS_DOC_RELOCATE_MAX_STATS) {
			return undefined;
		}
		const sized: string[] = [];
		await forEachLimited(candidates, async path => {
			if (await probe.size(path) === fingerprint.size) {
				sized.push(path);
			}
		});
		if (sized.length > PARADIS_DOC_RELOCATE_MAX_HASHES) {
			return undefined;
		}
		const matches: string[] = [];
		for (const path of sized) {
			if (await probe.hash(path) === fingerprint.hash) {
				matches.push(path);
			}
		}
		return matches.length === 1 ? matches[0] : undefined;
	}

	/** 見つからないまま日数の過ぎた資料を、もう一度確かめてから外す。 */
	private async _prune(missing: readonly IParadisDocViewRecord[]): Promise<void> {
		const host = this._host;
		const now = host.now();
		// 数え始めの無い記録（数え始めを書かない版が「見つからない」と記録したもの）は、ここから数える。台帳に書いてもらう
		// （メモリに持つと、開き直すたびに数え直しになる）。古い `missingSince` からは数えない: 更新した直後の最初の見直しで、
		// 前の版の間に 7 日を過ぎていた資料がまとめて外れるため
		await forEachLimited(missing.filter(record => record.missingCountedFrom === undefined && !this._countRequested.has(this._key(record))), async record => {
			this._countRequested.add(this._key(record));
			await host.setMissing(record.path, true);
		});
		const due = missing.filter(record => record.missingCountedFrom !== undefined && now - record.missingCountedFrom >= PARADIS_DOC_MISSING_RETENTION_MS && now - (this._pruneChecked.get(this._key(record)) ?? Number.NEGATIVE_INFINITY) >= PRUNE_RECHECK_MS);
		const removals: string[] = [];
		await forEachLimited(due.slice(0, PRUNES_PER_PASS), async record => {
			this._pruneChecked.set(this._key(record), now);
			const stat = await host.stat(record.path).catch(() => undefined);
			if (stat === 'missing') {
				// 外した外付けの記憶装置の上の資料は、ファイルが消えたのではない
				const mount = paradisDocMountPoint(record.path);
				if (mount !== undefined && await host.stat(mount).catch(() => undefined) === 'missing') {
					return;
				}
				removals.push(record.path);
			} else if (stat !== undefined) {
				await host.setMissing(record.path, false);
			}
		});
		if (removals.length > 0) {
			await host.remove(removals);
		}
	}
}
