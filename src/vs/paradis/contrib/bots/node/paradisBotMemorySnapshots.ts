/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 記憶の整理の写しと取り消し。整理（Bot が MEMORY.md と memory/ を書き直す会話）を始める前に、記憶のファイルを
// `<userData>/paradis/bots/memory-snapshots/<Bot の id>/<時刻>.json` へ写す。写しは専用フォルダの外に置く
// （専用フォルダは Bot が自由に書けるので、写しを書き換えられないように）。取り消しは一番新しい写しの中身を
// 書き戻す。整理で新しくできたファイルは消さず、`added` で知らせる。

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { isRecord } from '../../../common/paradisGuards.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { IParadisBot } from '../common/paradisBots.js';
import { ParadisBotHomeError, ParadisBotHomes } from './paradisBotHomes.js';

/** 1 Bot が残す写しの数。 */
export const PARADIS_BOT_MEMORY_SNAPSHOTS_KEEP = 5;
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

	/** 記憶のファイルを写す。写したファイルの数を返す。古い写しは {@link PARADIS_BOT_MEMORY_SNAPSHOTS_KEEP} 件を残して消す。 */
	async take(bot: SnapshotBot): Promise<{ readonly takenAt: number; readonly files: number }> {
		const files: Record<string, string> = {};
		let size = 0;
		for (const path of await this.homes.memoryFiles(bot)) {
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
		await fs.mkdir(folder, { recursive: true, mode: 0o700 });
		let takenAt = this.now();
		const existing = await this.list(bot);
		// 同じミリ秒に 2 回取っても上書きしない
		while (existing.includes(takenAt)) {
			takenAt++;
		}
		await paradisWriteFileAtomic(join(folder, `${takenAt}.json`), JSON.stringify({ version: 1, takenAt, files }), { rejectSymlink: true });
		for (const old of [takenAt, ...existing].sort((a, b) => b - a).slice(PARADIS_BOT_MEMORY_SNAPSHOTS_KEEP)) {
			await fs.unlink(join(folder, `${old}.json`)).catch(() => undefined);
		}
		return { takenAt, files: Object.keys(files).length };
	}

	/** 一番新しい写しを書き戻す。写しが無ければ undefined。 */
	async undo(bot: SnapshotBot): Promise<IParadisBotMemoryUndo | undefined> {
		const [latest] = await this.list(bot);
		if (latest === undefined) {
			return undefined;
		}
		const value: unknown = JSON.parse(await fs.readFile(join(this.folder(bot), `${latest}.json`), 'utf8'));
		const files = isRecord(value) && isRecord(value.files) ? value.files : {};
		const restored: string[] = [];
		for (const [path, text] of Object.entries(files)) {
			if (typeof text === 'string') {
				// 専用フォルダへの書き込みは、いつもと同じ検査（フォルダの外・symlink・持ち主の印）を通す
				await this.homes.write(bot, path, text);
				restored.push(path);
			}
		}
		const added = (await this.homes.memoryFiles(bot)).filter(path => !restored.includes(path));
		return { restored, added, takenAt: latest };
	}
}
