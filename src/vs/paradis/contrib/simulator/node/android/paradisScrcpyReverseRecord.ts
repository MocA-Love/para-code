/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code が作った adb reverse の印（scid）を、userData の下のファイルに残す（q.html Q585 の ⑥b）。
// 通話を始める途中で Para Code が落ちると、端末に reverse が残る。次に始めるとき、ここに記録したものだけを外す
// （利用者自身の scrcpy の reverse も同じ `localabstract:scrcpy_<scid>` の形なので、形だけでは見分けない）。

import { promises as fs } from 'fs';
import { dirname } from '../../../../../base/common/path.js';
import { IParadisScrcpyReverseRecord } from './paradisScrcpySession.js';

type Record = { [serial: string]: string[] };

export class ParadisScrcpyReverseFileRecord implements IParadisScrcpyReverseRecord {

	/** 読み書きを 1 つずつにする（同じファイルを重ねて書かない）。 */
	private _queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly _file: string) { }

	list(serial: string): Promise<readonly string[]> {
		return this._run(async record => [record, record[serial] ?? []]);
	}

	async add(serial: string, scid: string): Promise<void> {
		await this._run(async record => {
			const scids = new Set(record[serial] ?? []);
			scids.add(scid);
			return [{ ...record, [serial]: [...scids] }, undefined, true];
		});
	}

	async remove(serial: string, scid: string): Promise<void> {
		await this._run(async record => {
			const scids = (record[serial] ?? []).filter(candidate => candidate !== scid);
			const next = { ...record };
			if (scids.length) {
				next[serial] = scids;
			} else {
				delete next[serial];
			}
			return [next, undefined, true];
		});
	}

	private _run<T>(step: (record: Record) => Promise<[Record, T, boolean?]>): Promise<T> {
		const result = this._queue.then(async () => {
			const record = await this._read();
			const [next, value, write] = await step(record);
			if (write) {
				await fs.mkdir(dirname(this._file), { recursive: true, mode: 0o700 });
				await fs.writeFile(this._file, JSON.stringify(next), { mode: 0o600 });
			}
			return value;
		});
		this._queue = result.catch(() => undefined);
		return result;
	}

	private async _read(): Promise<Record> {
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(this._file, 'utf8'));
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return {};
			}
			const record: Record = {};
			for (const [serial, scids] of Object.entries(parsed as { [key: string]: unknown })) {
				if (Array.isArray(scids)) {
					record[serial] = scids.filter((scid): scid is string => typeof scid === 'string' && /^[0-9a-f]{8}$/.test(scid));
				}
			}
			return record;
		} catch {
			return {};
		}
	}
}
