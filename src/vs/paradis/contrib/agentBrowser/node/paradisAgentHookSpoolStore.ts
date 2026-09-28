/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// hook の控え（W2-20）の読み取りと掃除。書くのは notify スクリプトで、ここは読むだけ。
// 判断は common の `paradisAgentHookSpool.ts`。

import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { IParadisSpooledAgentHook, PARADIS_AGENT_HOOK_SPOOL_MAX_AGE_MS, PARADIS_AGENT_HOOK_SPOOL_MAX_FILE_BYTES, paradisParseAgentHookSpool } from '../common/paradisAgentHookSpool.js';

/** ペイントークンのハッシュ（控えのファイル名と照合に使う）。スクリプトの `shasum -a 256` と同じ。 */
export function paradisAgentHookSpoolHash(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

function spoolFile(dir: string, token: string): string {
	return join(dir, `pane-${paradisAgentHookSpoolHash(token)}.jsonl`);
}

/**
 * そのペインの控えを取り出して消す（1 度だけ読む）。無ければ空。
 *
 * 先に名前を変えてから読む。読んでいる間にスクリプトが書き足した分は、元の名前の新しいファイルに
 * 入るので失われない（次の同期で読む）。
 */
export async function paradisTakeAgentHookSpool(dir: string, token: string, now: number = Date.now()): Promise<IParadisSpooledAgentHook[]> {
	const file = spoolFile(dir, token);
	const claimed = `${file}.replaying-${randomBytes(4).toString('hex')}`;
	try {
		await fs.rename(file, claimed);
	} catch {
		return [];
	}
	try {
		const stat = await fs.stat(claimed);
		// 上限はスクリプトが守るが、壊れた・細工されたファイルで大きな読み込みをしない。
		if (stat.size > PARADIS_AGENT_HOOK_SPOOL_MAX_FILE_BYTES * 2) {
			return [];
		}
		return paradisParseAgentHookSpool(await fs.readFile(claimed, 'utf8'), now);
	} catch {
		return [];
	} finally {
		await fs.unlink(claimed).catch(() => undefined);
	}
}

/**
 * 古い控えと、読みかけで残った控えを消す。起動時に 1 回呼ぶ。
 * ファイルの更新時刻で判断する（中身を読まない）。
 */
export async function paradisPruneAgentHookSpool(dir: string, now: number = Date.now()): Promise<number> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	await Promise.all(names.map(async name => {
		if (!/^pane-[0-9a-f]{64}\.jsonl(?:\.replaying-[0-9a-f]+)?$/.test(name)) {
			return;
		}
		const path = join(dir, name);
		try {
			const stat = await fs.stat(path);
			if (name.includes('.replaying-') || now - stat.mtimeMs > PARADIS_AGENT_HOOK_SPOOL_MAX_AGE_MS) {
				await fs.unlink(path);
				removed++;
			}
		} catch {
			// 消えていた・消せない。次の起動でまた試す。
		}
	}));
	return removed;
}
