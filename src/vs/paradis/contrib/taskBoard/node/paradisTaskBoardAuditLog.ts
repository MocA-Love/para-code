/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードの SSH 中継の監査ログ（設計書 G8）。shared process が書く（接続口の鍵と pid で断った依頼まで残せるため。
// 設計書の「窓が書く」から置き場を変えた）。
//
//  - `<userData>/paradis/taskBoardRelay/audit-YYYY-MM.jsonl`。フォルダ 0700・ファイル 0600、1 操作 1 行
//  - 残すのは操作の名前・結果・理由・時間など。出力・env・ファイルの中身・鍵は残さない
//  - 90 日より前の月のファイルは、立ち上げのときに消す

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisTaskBoardAuditEntry } from '../common/paradisTaskBoardRelay.js';

const FILE = /^audit-(?<year>\d{4})-(?<month>\d{2})\.jsonl$/;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** 1 行の上限（壊れた入力で大きな行を書かない）。 */
const MAX_LINE_CHARS = 4096;

export class ParadisTaskBoardAuditLog {

	private queue: Promise<void> = Promise.resolve();
	private pruned = false;

	constructor(
		private readonly directory: string,
		private readonly logService: ILogService,
		private readonly now: () => number = Date.now,
	) { }

	/** 1 行足す。失敗してもログに出すだけ（中継そのものは止めない）。 */
	append(entry: Omit<IParadisTaskBoardAuditEntry, 'time'>): Promise<void> {
		const time = new Date(this.now());
		const line = JSON.stringify({ time: time.toISOString(), ...entry }).slice(0, MAX_LINE_CHARS);
		this.queue = this.queue.then(() => this.write(time, line)).catch(error => this.logService.warn('[ParadisTaskBoardAudit] could not write the audit log', String(error)));
		return this.queue;
	}

	private async write(time: Date, line: string): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
		await fs.chmod(this.directory, 0o700);
		if (!this.pruned) {
			this.pruned = true;
			await this.prune();
		}
		const name = `audit-${time.getUTCFullYear()}-${String(time.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
		const handle = await fs.open(join(this.directory, name), 'a', 0o600);
		try {
			await handle.chmod(0o600);
			await handle.write(`${line}\n`);
		} finally {
			await handle.close();
		}
	}

	/** 月の終わりが 90 日より前のファイルを消す。 */
	private async prune(): Promise<void> {
		for (const name of await fs.readdir(this.directory)) {
			const groups = FILE.exec(name)?.groups;
			if (!groups) {
				continue;
			}
			const endOfMonth = Date.UTC(Number(groups.year), Number(groups.month), 1);
			if (this.now() - endOfMonth > RETENTION_MS) {
				await fs.unlink(join(this.directory, name)).catch(() => undefined);
			}
		}
	}
}
