/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 記憶の整理の写しと取り消し。整理（Bot が MEMORY.md と memory/ を書き直す会話）を始める前に、記憶のファイルを
// `<userData>/paradis/bots/memory-snapshots/<Bot の id>/<時刻>.json` へ写す。写しは専用フォルダの外に置く
// （専用フォルダは Bot が自由に書けるので、写しを書き換えられないように）。取り消しは一番新しい写しの中身を
// 書き戻す。整理で新しくできたファイルは消さず、`added` で知らせる。書き戻すのは記憶のファイル（`MEMORY.md` と
// `memory/` の直下）だけで、写しに別のパス（`SOUL.md`・`AGENTS.md` など）があっても書かない（`skipped` で知らせる）。
// Bot を消したら写しも消す。

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { isRecord } from '../../../common/paradisGuards.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { PARADIS_BOT_MEMORY_FILE, PARADIS_BOT_MEMORY_FOLDER } from '../common/paradisBotHome.js';
import { IParadisBot } from '../common/paradisBots.js';
import { ParadisBotHomeError, ParadisBotHomes } from './paradisBotHomes.js';

/** 1 Bot が残す写しの数（自動の写しと、明示に取った写しのそれぞれ）。 */
export const PARADIS_BOT_MEMORY_SNAPSHOTS_KEEP = 5;

/**
 * 写しの種類。`auto` は会話の起動のたびに本体が取る写し、`manual` は記憶の整理の前などに明示に取った写し
 * （`snapshotMemory`）。上限はそれぞれに数え、自動の写しで明示の写しを押し出さない。種類を持たない古い写しは `manual`。
 */
export type ParadisBotMemorySnapshotKind = 'auto' | 'manual';
/** 1 つの写しの大きさの上限（バイト）。超えると写しを取らずに断る（一部だけの写しで取り消すと記憶が欠ける）。 */
export const PARADIS_BOT_MEMORY_SNAPSHOT_LIMIT = 16 * 1024 * 1024;

type SnapshotBot = Pick<IParadisBot, 'id' | 'name' | 'folder'>;

export interface IParadisBotMemoryUndo {
	/** 書き戻したファイル。 */
	readonly restored: readonly string[];
	/** 写しの後にできたファイル（消していない）。 */
	readonly added: readonly string[];
	/** 写しを取った時刻。 */
	readonly takenAt: number;
	/** 写しにあったが、記憶のファイルではないので書き戻さなかったパス。 */
	readonly skipped: readonly string[];
}

export interface IParadisBotMemorySnapshot {
	readonly takenAt: number;
	/** 写したファイルの数。 */
	readonly files: number;
	/** 記憶のファイルの数（上限で打ち切る前）。 */
	readonly total: number;
	/** 上限で打ち切り、一部だけを写したか。 */
	readonly partial: boolean;
	readonly kind: ParadisBotMemorySnapshotKind;
}

/** 書き戻してよい記憶のファイルか（`MEMORY.md` か、`memory/` の直下のファイル）。 */
function isMemoryPath(path: string): boolean {
	if (path === PARADIS_BOT_MEMORY_FILE) {
		return true;
	}
	const name = path.startsWith(`${PARADIS_BOT_MEMORY_FOLDER}/`) ? path.slice(PARADIS_BOT_MEMORY_FOLDER.length + 1) : '';
	return /^[^/\\]+$/.test(name) && name !== '.' && name !== '..';
}

/** 写しの中身（パスと文の組）のハッシュ。並びに依らない。 */
function contentHash(files: Record<string, unknown>): string {
	const hash = createHash('sha256');
	for (const path of Object.keys(files).sort()) {
		const text = files[path];
		if (typeof text === 'string') {
			hash.update(JSON.stringify([path, text]));
		}
	}
	return hash.digest('hex');
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export class ParadisBotMemorySnapshots {

	constructor(
		private readonly root: string,
		private readonly homes: ParadisBotHomes,
		private readonly now: () => number = Date.now,
	) { }

	private folder(bot: SnapshotBot): string {
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(bot.id)) {
			throw new ParadisBotHomeError('outside', 'The bot id cannot name a folder.');
		}
		return join(this.root, bot.id);
	}

	/** 写しの時刻（新しい順）。 */
	async list(bot: SnapshotBot): Promise<number[]> {
		const names = await fs.readdir(this.folder(bot)).catch(error => {
			if (missing(error)) {
				return [];
			}
			throw error;
		});
		return names.map(name => /^(?<time>\d+)\.json$/.exec(name)?.groups?.time).filter((time): time is string => time !== undefined).map(Number).sort((a, b) => b - a);
	}

	/**
	 * 記憶のファイルを写す。写したファイルの数と、上限で打ち切って一部だけになったかを返す。同じ種類の古い写しは
	 * {@link PARADIS_BOT_MEMORY_SNAPSHOTS_KEEP} 件を残して消す（ほかの種類の写しは消さない）。中身が同じ写しは新しく
	 * 取らず、その写しを返す。比べる相手は、自動の写しなら直前の写し（種類を問わない）、明示の写しなら直前の明示の写し
	 * （記憶の変わらない会話を開くたびに、戻したい古い写しが押し出されないように）。
	 */
	async take(bot: SnapshotBot, kind: ParadisBotMemorySnapshotKind = 'manual'): Promise<IParadisBotMemorySnapshot> {
		const files: Record<string, string> = {};
		let size = 0;
		const listed = await this.homes.memoryFilesWithTotal(bot);
		for (const path of listed.files) {
			const text = await this.homes.read(bot, path);
			if (text === undefined) {
				continue;
			}
			size += Buffer.byteLength(text, 'utf8');
			if (size > PARADIS_BOT_MEMORY_SNAPSHOT_LIMIT) {
				throw new ParadisBotHomeError('too_large', 'The memory is too large to keep a copy, so Para Code does not start the tidy-up.');
			}
			files[path] = text;
		}
		const folder = this.folder(bot);
		const existing = await this.list(bot);
		const snapshots = (await Promise.all(existing.map(takenAt => this.read(bot, takenAt)))).filter(snapshot => snapshot !== undefined);
		const previous = kind === 'auto' ? snapshots[0] : snapshots.find(snapshot => snapshot.record.kind === 'manual');
		if (previous !== undefined && contentHash(previous.files) === contentHash(files)) {
			return previous.record;
		}
		await fs.mkdir(folder, { recursive: true, mode: 0o700 });
		let takenAt = this.now();
		// 同じミリ秒に 2 回取っても上書きしない
		while (existing.includes(takenAt)) {
			takenAt++;
		}
		const partial = listed.files.length < listed.total;
		// 件数と「一部だけか」も写しに残す（画面が写しの一覧に出す）
		await paradisWriteFileAtomic(join(folder, `${takenAt}.json`), JSON.stringify({ version: 1, takenAt, kind, files, total: listed.total, partial }), { rejectSymlink: true });
		const sameKind = [takenAt, ...snapshots.filter(snapshot => snapshot.record.kind === kind).map(snapshot => snapshot.record.takenAt)].sort((a, b) => b - a);
		for (const old of sameKind.slice(PARADIS_BOT_MEMORY_SNAPSHOTS_KEEP)) {
			await fs.unlink(join(folder, `${old}.json`)).catch(() => undefined);
		}
		return { takenAt, files: Object.keys(files).length, total: listed.total, partial, kind };
	}

	/**
	 * 写しの一覧（新しい順）。時刻・写したファイルの数・記憶のファイルの数・一部だけか・種類。`total`・`partial` を
	 * 持たない古い写しは、写した数を `total` にし、一部だけではないとみなす。読めない写しは飛ばす。
	 */
	async listSnapshots(bot: SnapshotBot): Promise<IParadisBotMemorySnapshot[]> {
		const result: IParadisBotMemorySnapshot[] = [];
		for (const takenAt of await this.list(bot)) {
			const snapshot = await this.read(bot, takenAt);
			if (snapshot !== undefined) {
				result.push(snapshot.record);
			}
		}
		return result;
	}

	/** 写しを 1 つ読む。消えた・壊れた写しは undefined。 */
	private async read(bot: SnapshotBot, takenAt: number): Promise<{ readonly record: IParadisBotMemorySnapshot; readonly files: Record<string, unknown> } | undefined> {
		try {
			const value: unknown = JSON.parse(await fs.readFile(join(this.folder(bot), `${takenAt}.json`), 'utf8'));
			const files = isRecord(value) && isRecord(value.files) ? value.files : {};
			const count = Object.values(files).filter(text => typeof text === 'string').length;
			const total = isRecord(value) && typeof value.total === 'number' && Number.isSafeInteger(value.total) && value.total >= count ? value.total : count;
			const kind: ParadisBotMemorySnapshotKind = isRecord(value) && value.kind === 'auto' ? 'auto' : 'manual';
			return { record: { takenAt, files: count, total, partial: isRecord(value) && value.partial === true, kind }, files };
		} catch {
			return undefined;
		}
	}

	/** その Bot の写しを全部消す（Bot を消したとき）。 */
	async remove(bot: Pick<IParadisBot, 'id'>): Promise<void> {
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(bot.id)) {
			return;
		}
		await fs.rm(join(this.root, bot.id), { recursive: true, force: true });
	}

	/** 選んだ写し（{@link listSnapshots} の `takenAt`）を書き戻す。その写しが無い（消えた・古すぎる）なら undefined。 */
	async undo(bot: SnapshotBot, takenAt: number): Promise<IParadisBotMemoryUndo | undefined> {
		if (!Number.isSafeInteger(takenAt) || !(await this.list(bot)).includes(takenAt)) {
			return undefined;
		}
		const snapshot = await this.read(bot, takenAt);
		if (snapshot === undefined) {
			return undefined;
		}
		const latest = takenAt;
		const files = snapshot.files;
		const restored: string[] = [];
		const skipped: string[] = [];
		for (const [path, text] of Object.entries(files)) {
			if (!isMemoryPath(path)) {
				// 写しのファイルが書き換えられていても、人格メモや指示文を上書きしない
				skipped.push(path);
				continue;
			}
			if (typeof text === 'string') {
				// 専用フォルダへの書き込みは、いつもと同じ検査（フォルダの外・symlink・持ち主の印）を通す
				await this.homes.write(bot, path, text);
				restored.push(path);
			}
		}
		const added = (await this.homes.memoryFiles(bot)).filter(path => !restored.includes(path));
		return { restored, added, takenAt: latest, skipped };
	}
}
