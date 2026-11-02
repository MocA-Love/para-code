/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// rtk の履歴の DB（`history.db` の `commands` 表）を読み取り専用で開き、期間を指定して数える（Q537 の 15 B）。
// `rtk gain` のコマンド別の表は全期間しか出せず、作業フォルダ別も出せないため、DB を直接読む。
// DB は rtk の内部の形なので、表や列が無い・開けないときは undefined を返し、呼び出し側は従来の `rtk gain` の取得に戻す。
//
// node:sqlite は同期の API で、90 日分（10 万行ほど）を数えると 2 秒ほどかかる。shared process（と接続先の REH）を
// 止めないよう、読み取りは使い捨ての worker スレッドで行う。

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { Worker } from 'worker_threads';
import { join } from '../../../../base/common/path.js';

/** 履歴の DB の置き場の候補（rtk は OS のデータ用フォルダの下の `rtk/history.db` に書く）。 */
export function paradisRtkHistoryDbCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
	switch (platform) {
		case 'darwin':
			return [join(home, 'Library', 'Application Support', 'rtk', 'history.db')];
		case 'win32':
			return env.APPDATA ? [join(env.APPDATA, 'rtk', 'history.db')] : [];
		default:
			return [join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'rtk', 'history.db')];
	}
}

/** 最初に見つかった DB（無ければ undefined）。 */
export async function paradisFindRtkHistoryDb(candidates: readonly string[] = paradisRtkHistoryDbCandidates()): Promise<string | undefined> {
	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// 次の候補へ
		}
	}
	return undefined;
}

/** ローカル日付（YYYY-MM-DD）の 0 時を、DB の時刻の並び（UTC の `YYYY-MM-DDTHH:MM:SS`）にする。 */
export function paradisRtkUtcStamp(localDay: string, addDays: number): string {
	const [y, m, d] = localDay.split('-').map(Number);
	return new Date(y, m - 1, d + addDays).toISOString().slice(0, 19);
}

export interface IParadisRtkHistoryRawStats {
	readonly totals: { readonly commands: number; readonly inputTokens: number; readonly savedTokens: number; readonly execMs: number };
	readonly commands: readonly { readonly command: string; readonly count: number; readonly inputTokens: number; readonly savedTokens: number; readonly execMs: number }[];
	/** 作業フォルダ（記録が無ければ空文字）ごとの回数と節約量。 */
	readonly projects: readonly { readonly path: string; readonly count: number; readonly savedTokens: number }[];
}

/** 読み取りの上限時間。超えたら worker を止めて従来の取得に戻す。 */
const READ_TIMEOUT_MS = 30_000;

/**
 * worker で走らせるコード（素の JavaScript）。コマンドは引数ごとではなく、先頭の 2 語（git・gh などは 3 語）で
 * まとめる。引数には URL やパスがそのまま入っていて（署名付きの URL など）、画面に出すと漏れるうえ、
 * 同じ使い方が細かく割れて内訳として読めないため。
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const num = value => typeof value === 'number' && isFinite(value) ? value : typeof value === 'bigint' ? Number(value) : 0;
let db;
try {
	const { DatabaseSync } = require('node:sqlite');
	db = new DatabaseSync(workerData.dbPath, { readOnly: true });
	const columns = new Set(db.prepare('PRAGMA table_info(commands)').all().map(row => String(row.name)));
	for (const required of ['timestamp', 'rtk_cmd', 'input_tokens', 'saved_tokens']) {
		if (!columns.has(required)) {
			throw new Error('missing column ' + required);
		}
	}
	const ms = columns.has('exec_time_ms') ? 'exec_time_ms' : '0';
	const project = columns.has('project_path') ? "COALESCE(project_path, '')" : "''";
	const where = 'timestamp >= ? AND timestamp < ?';
	const bounds = [workerData.since, workerData.until];
	const totals = db.prepare('SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(saved_tokens) AS saved, SUM(' + ms + ') AS ms FROM commands WHERE ' + where).get(...bounds) || {};
	const commands = db.prepare(
		"WITH base AS (SELECT rtk_cmd || ' ' AS w, input_tokens AS input, saved_tokens AS saved, " + ms + " AS ms FROM commands WHERE " + where + "), " +
		"s1 AS (SELECT substr(w, 1, instr(w, ' ') - 1) AS w1, substr(w, instr(w, ' ') + 1) AS r1, input, saved, ms FROM base), " +
		"s2 AS (SELECT w1, substr(r1, 1, instr(r1, ' ') - 1) AS w2, substr(r1, instr(r1, ' ') + 1) AS r2, input, saved, ms FROM s1), " +
		"s3 AS (SELECT w1, w2, substr(r2, 1, instr(r2, ' ') - 1) AS w3, input, saved, ms FROM s2) " +
		"SELECT CASE WHEN w2 = '' OR substr(w2, 1, 1) IN ('-', '/', '.', '~') THEN w1 " +
		"WHEN w2 IN ('git', 'gh', 'cargo', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl', 'go') AND w3 <> '' AND substr(w3, 1, 1) NOT IN ('-', '/', '.', '~') THEN w1 || ' ' || w2 || ' ' || w3 " +
		"ELSE w1 || ' ' || w2 END AS command, COUNT(*) AS n, SUM(input) AS input, SUM(saved) AS saved, SUM(ms) AS ms " +
		"FROM s3 GROUP BY command ORDER BY saved DESC LIMIT " + workerData.limit
	).all(...bounds);
	const projects = db.prepare('SELECT ' + project + ' AS path, COUNT(*) AS n, SUM(saved_tokens) AS saved FROM commands WHERE ' + where + ' GROUP BY ' + project).all(...bounds);
	parentPort.postMessage({
		totals: { commands: num(totals.n), inputTokens: num(totals.input), savedTokens: num(totals.saved), execMs: num(totals.ms) },
		commands: commands.map(row => ({ command: String(row.command || ''), count: num(row.n), inputTokens: num(row.input), savedTokens: num(row.saved), execMs: num(row.ms) })),
		projects: projects.map(row => ({ path: String(row.path || ''), count: num(row.n), savedTokens: num(row.saved) })),
	});
} catch (error) {
	parentPort.postMessage({ error: String(error && error.message || error) });
} finally {
	try { db && db.close(); } catch { }
}
`;

/** 表に出すコマンドの数。 */
const MAX_COMMAND_ROWS = 15;

/**
 * DB を読み取り専用で開いて、ローカル日付 `since`〜`until`（含む）の記録を数える。開けない・形が違う・時間切れのときは undefined。
 */
export function paradisReadRtkHistoryStats(dbPath: string, since: string, until: string): Promise<IParadisRtkHistoryRawStats | undefined> {
	return new Promise(resolve => {
		let worker: Worker;
		try {
			worker = new Worker(WORKER_SOURCE, {
				eval: true,
				workerData: { dbPath, since: paradisRtkUtcStamp(since, 0), until: paradisRtkUtcStamp(until, 1), limit: MAX_COMMAND_ROWS },
			});
		} catch {
			resolve(undefined);
			return;
		}
		let settled = false;
		const finish = (value: IParadisRtkHistoryRawStats | undefined) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				void worker.terminate();
				resolve(value);
			}
		};
		const timer = setTimeout(() => finish(undefined), READ_TIMEOUT_MS);
		worker.once('message', (message: IParadisRtkHistoryRawStats & { readonly error?: string }) => finish(message.error !== undefined ? undefined : message));
		worker.once('error', () => finish(undefined));
		worker.once('exit', () => finish(undefined));
	});
}
