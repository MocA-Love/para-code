/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 書いている途中の一時ファイルの控えを、保存領域（APPLICATION。どのウィンドウからも読める）に置く。
// 判断の規則は common/paradisFileTransferJournal.ts の純関数にある。

import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisTransferJournal } from './paradisFileTransferFileSystem.js';
import {
	paradisJournalAdd,
	paradisJournalCleanable,
	paradisJournalRemove,
	paradisJournalStamp,
	paradisParseJournal,
	PARADIS_FILE_TRANSFER_JOURNAL_HEARTBEAT_MS,
	PARADIS_FILE_TRANSFER_JOURNAL_KEY,
	PARADIS_FILE_TRANSFER_JOURNAL_SETTLE_MS,
} from '../common/paradisFileTransferJournal.js';

export class ParadisTransferTempJournal extends Disposable implements IParadisTransferJournal {

	/** このウィンドウが今書いている一時ファイル。 */
	private readonly own = new Set<string>();
	private readonly heartbeat = this._register(new IntervalTimer());

	constructor(
		private readonly storageService: IStorageService,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
		private readonly now: () => number = Date.now,
	) {
		super();
		this.heartbeat.cancelAndSet(() => this.beat(), PARADIS_FILE_TRANSFER_JOURNAL_HEARTBEAT_MS);
	}

	/** 心拍。自分が今書いている一時ファイルの時刻を新しくする。 */
	beat(): void {
		this.stamp(this.now());
	}

	add(temp: URI): void {
		const uri = temp.toString();
		this.own.add(uri);
		this.write(paradisJournalAdd(this.read(), uri, this.now()));
	}

	remove(temp: URI): void {
		const uri = temp.toString();
		this.own.delete(uri);
		this.write(paradisJournalRemove(this.read(), uri));
	}

	/** 閉じるときに片付けきれなかった自分の一時ファイルに印を付ける（次に開いたときにすぐ片付ける）。 */
	abandonOwn(): void {
		if (this.own.size) {
			this.stamp(0);
		}
	}

	/**
	 * 心拍の途絶えた（または印の付いた）一時ファイルを片付ける。消したものの数を返す。
	 *
	 * スリープ明けは、書いている側の心拍がまだ追いついていないだけのことがある。そこで候補を選んだ後、心拍の
	 * 間隔より長く待ってから控えを読み直し、その間に時刻が変わったもの（書いている側が生きている）は消さない。
	 */
	async cleanup(canAccess: (uri: URI) => boolean, settle: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, PARADIS_FILE_TRANSFER_JOURNAL_SETTLE_MS))): Promise<number> {
		const candidates = paradisJournalCleanable(this.read(), this.own, this.now(), canAccess);
		if (!candidates.length) {
			return 0;
		}
		const before = new Map(this.read().map(entry => [entry.uri, entry.at]));
		await settle();
		if (this._store.isDisposed) {
			return 0;
		}
		const after = new Map(this.read().map(entry => [entry.uri, entry.at]));
		let removed = 0;
		for (const uri of candidates) {
			const key = uri.toString();
			// 待っている間に心拍があった・控えから消えた・自分が書き始めた、なら触らない
			if (this.own.has(key) || !after.has(key) || after.get(key) !== before.get(key)) {
				continue;
			}
			try {
				if (await this.fileService.exists(uri)) {
					await this.fileService.del(uri, { useTrash: false });
				}
				this.write(paradisJournalRemove(this.read(), uri.toString()));
				removed++;
			} catch (error) {
				// 切れている・権限が無いなどは、次の機会にもう一度試す
				this.logService.info(`[ParadisFileTransfer] could not clean up ${uri.toString()}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return removed;
	}

	private stamp(at: number): void {
		if (this.own.size) {
			this.write(paradisJournalStamp(this.read(), this.own, at));
		}
	}

	private read() {
		return paradisParseJournal(this.storageService.get(PARADIS_FILE_TRANSFER_JOURNAL_KEY, StorageScope.APPLICATION));
	}

	private write(entries: ReturnType<typeof paradisParseJournal>): void {
		if (entries.length) {
			this.storageService.store(PARADIS_FILE_TRANSFER_JOURNAL_KEY, JSON.stringify(entries), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(PARADIS_FILE_TRANSFER_JOURNAL_KEY, StorageScope.APPLICATION);
		}
	}
}
