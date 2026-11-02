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
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

/**
 * 履歴の DB の置き場の候補。rtk は `RTK_DB_PATH` を最優先にし、無ければ `dirs::data_local_dir()` の下の
 * `rtk/history.db` に書く（rtk の src/core/tracking.rs の get_db_path と src/core/user_dirs.rs）。
 * rtk の config.toml の `tracking.database_path` は読まない（そのときは従来の取得に戻る）。
 */
export function paradisRtkHistoryDbCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
	const fromEnv = env.RTK_DB_PATH ? [env.RTK_DB_PATH] : [];
	switch (platform) {
		case 'darwin':
			return [...fromEnv, join(home, 'Library', 'Application Support', 'rtk', 'history.db')];
		case 'win32':
			return [...fromEnv, ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'rtk', 'history.db')] : [])];
		default:
			return [...fromEnv, join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'rtk', 'history.db')];
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
// 語として残すのは ^[a-z][a-z0-9_-]*$ に当たるものだけ（GLOB は大文字小文字を区別する）。
const word = column => column + " GLOB '[a-z]*' AND " + column + " NOT GLOB '*[^a-z0-9_-]*'";
const THREE_WORD_TOOLS = "'git', 'gh', 'cargo', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl', 'go'";
let db;
try {
	const { DatabaseSync } = require('node:sqlite');
	db = new DatabaseSync(workerData.dbPath, { readOnly: true });
	const columns = new Set(db.prepare('PRAGMA table_info(commands)').all().map(row => String(row.name)));
	for (const required of ['timestamp', 'rtk_cmd', 'input_tokens', 'saved_tokens']) {
		if (!columns.has(required)) {
			// 表が無い（PRAGMA が空）か列が無い: rtk の版が違うだけなので、報告せずに戻す
			throw Object.assign(new Error('shape'), { paradisExpected: true });
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
		"SELECT CASE WHEN NOT (" + word('w1') + ") THEN '' " +
		"WHEN NOT (" + word('w2') + ") THEN w1 " +
		"WHEN w2 IN (" + THREE_WORD_TOOLS + ") AND " + word('w3') + " THEN w1 || ' ' || w2 || ' ' || w3 " +
		"ELSE w1 || ' ' || w2 END AS command, COUNT(*) AS n, SUM(input) AS input, SUM(saved) AS saved, SUM(ms) AS ms " +
		"FROM s3 GROUP BY command ORDER BY saved DESC, n DESC, command LIMIT " + workerData.limit
	).all(...bounds);
	const projects = db.prepare('SELECT ' + project + ' AS path, COUNT(*) AS n, SUM(saved_tokens) AS saved FROM commands WHERE ' + where + ' GROUP BY ' + project).all(...bounds);
	parentPort.postMessage({
		totals: { commands: num(totals.n), inputTokens: num(totals.input), savedTokens: num(totals.saved), execMs: num(totals.ms) },
		commands: commands.map(row => ({ command: String(row.command || ''), count: num(row.n), inputTokens: num(row.input), savedTokens: num(row.saved), execMs: num(row.ms) })),
		projects: projects.map(row => ({ path: String(row.path || ''), count: num(row.n), savedTokens: num(row.saved) })),
	});
} catch (error) {
	parentPort.postMessage(error && error.paradisExpected
		? { expected: true }
		// 報告に載せるのは種類だけ（メッセージには DB のパスが入りうる）
		: { error: String(error && error.name || 'Error') + (error && error.code ? ' ' + String(error.code) : '') });
} finally {
	try { db && db.close(); } catch { }
}
`;

/** 表に出すコマンドの数。 */
const MAX_COMMAND_ROWS = 15;

/** 想定外の失敗（worker・node:sqlite・時間切れ）を報告したか。毎回の取得で連打しないよう、1 回だけ報告する。 */
let reportedUnexpected = false;

function reportUnexpectedOnce(reason: string): void {
	if (reportedUnexpected) {
		return;
	}
	reportedUnexpected = true;
	reportParadisDiagnosticError('owned', 'rtk', 'history-db-read', new Error(`rtk history DB could not be read (${reason})`), { reason });
}

/**
 * DB を読み取り専用で開いて、ローカル日付 `since`〜`until`（含む）の記録を数える。読めないときは undefined。
 *
 * DB が無い・表や列が無い（rtk の版が違う）ときは想定内として黙って戻す。それ以外（worker が起動できない・
 * node:sqlite が読めない・DB が開けない・時間切れ）は、配布版でだけ壊れる形を見逃さないよう `onUnexpected` に知らせる
 * （既定は 1 回だけ Sentry へ報告）。
 */
export async function paradisReadRtkHistoryStats(dbPath: string, since: string, until: string, onUnexpected: (reason: string) => void = reportUnexpectedOnce): Promise<IParadisRtkHistoryRawStats | undefined> {
	try {
		await fs.access(dbPath);
	} catch {
		return undefined;
	}
	return new Promise(resolve => {
		let worker: Worker;
		try {
			worker = new Worker(WORKER_SOURCE, {
				eval: true,
				workerData: { dbPath, since: paradisRtkUtcStamp(since, 0), until: paradisRtkUtcStamp(until, 1), limit: MAX_COMMAND_ROWS },
			});
		} catch (error) {
			onUnexpected(`worker-start ${error instanceof Error ? error.name : typeof error}`);
			resolve(undefined);
			return;
		}
		let settled = false;
		const finish = (value: IParadisRtkHistoryRawStats | undefined, unexpected?: string) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				void worker.terminate();
				if (unexpected !== undefined) {
					onUnexpected(unexpected);
				}
				resolve(value);
			}
		};
		const timer = setTimeout(() => finish(undefined, 'timeout'), READ_TIMEOUT_MS);
		worker.once('message', (message: IParadisRtkHistoryRawStats & { readonly error?: string; readonly expected?: boolean }) => {
			if (message.expected) {
				finish(undefined);
			} else if (message.error !== undefined) {
				finish(undefined, `read ${message.error}`);
			} else {
				finish(message);
			}
		});
		worker.once('error', error => finish(undefined, `worker-error ${error.name}`));
		worker.once('exit', code => finish(undefined, `worker-exit ${code}`));
	});
}
