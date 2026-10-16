/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 実行したコマンドの記録（Q372）を読み書きする。
//
// - スペースのターミナルは、スペースの履歴フォルダの `commands.jsonl` に書く。フォルダとこのファイルは
//   シェル統合スクリプトが本人だけ読める形（700・600）で作る。Para Code はどちらも作らず、無ければ
//   書かない（IFileService で作ると 644 になり、コマンドの中の秘密が見える）。接続先（SSH）では接続先の
//   `~/.para-code/terminal-history` に書く（パスの変換は履歴の提供元と同じ）
// - スペースの履歴フォルダを持たないターミナル（スペースごとの履歴がオフ、下部パネルの共通ターミナル）は、
//   このマシンのユーザーデータの記録に書く。ファイルは main プロセスが 700・600 で用意する
//   （{@link paradisRegisterCommonCommandRecordsFile}。Web では用意する口が無いので書かない）
// - 書き込みはファイルごとに 1 秒まとめ、順番に行う。ふだんは追記し（別のウィンドウが書いた分を消さない）、
//   件数が上限を超えたときだけ読み直して縮めて書き直す。既にあるファイルへの書き込みは権限を変えない

import { RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisTerminalHistoryProvider } from '../../terminalHistorySuggest/browser/paradisTerminalHistoryCompletion.contribution.js';
import { IParadisCommandRecord, PARADIS_COMMAND_RECORDS_FILE, paradisAppendCommandRecords, paradisParseCommandRecords, paradisPlanCommandRecordsWrite, paradisSerializeCommandRecord } from '../common/paradisTerminalCommandRecords.js';

/** 読んだ記録を使い回す時間。 */
const READ_TTL_MS = 30_000;
/** 書き込みをまとめる時間。 */
const FLUSH_DELAY_MS = 1_000;
/** スペースの履歴フォルダを持たないターミナルの記録を表すキー（シェルから見たパスは空にならない）。 */
const COMMON_KEY = '';

/** スペースの履歴フォルダを持たないターミナルの記録のファイルを、本人だけが読める形で用意して返す。 */
export type ParadisCommonCommandRecordsFile = () => Promise<URI | undefined>;
let commonRecordsFile: ParadisCommonCommandRecordsFile | undefined;

/** 共通の記録のファイルを用意する口を登録する（デスクトップ版の electron-browser が 1 つ登録する）。 */
export function paradisRegisterCommonCommandRecordsFile(file: ParadisCommonCommandRecordsFile): IDisposable {
	commonRecordsFile = file;
	return toDisposable(() => {
		if (commonRecordsFile === file) {
			commonRecordsFile = undefined;
		}
	});
}

export const IParadisTerminalCommandRecordService = createDecorator<IParadisTerminalCommandRecordService>('paradisTerminalCommandRecordService');

export interface IParadisTerminalCommandRecordService {
	readonly _serviceBrand: undefined;
	/**
	 * `directory`（シェルから見たスペースの履歴フォルダ）へ記録を 1 件足す。書くのは少し後。
	 * undefined なら、スペースの履歴フォルダを持たないターミナルの共通の記録へ足す。
	 */
	record(directory: string | undefined, record: IParadisCommandRecord): void;
	/** `directory` の記録（書いた順）。まだ書いていない分も含める。undefined は共通の記録。 */
	read(directory: string | undefined, token: CancellationToken): Promise<readonly IParadisCommandRecord[]>;
}

class DirectoryRecords extends Disposable {
	cached: { readonly records: readonly IParadisCommandRecord[]; readonly readAt: number } | undefined;
	pending: IParadisCommandRecord[] = [];
	/** ファイルにある件数（このウィンドウが知っている分。まだ読んでいなければ undefined）。 */
	lineCount: number | undefined;
	/** 共通の記録のファイル（一度用意したら使い回す）。 */
	commonResource: URI | undefined;
	readonly flushScheduler: RunOnceScheduler;

	constructor(flush: () => void) {
		super();
		this.flushScheduler = this._register(new RunOnceScheduler(flush, FLUSH_DELAY_MS));
	}
}

export class ParadisTerminalCommandRecordService extends Disposable implements IParadisTerminalCommandRecordService {
	declare readonly _serviceBrand: undefined;

	private readonly _directories = this._register(new DisposableMap<string, DirectoryRecords>());
	private readonly _sequencer = new Sequencer();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	record(directory: string | undefined, record: IParadisCommandRecord): void {
		const state = this._state(directory ?? COMMON_KEY);
		state.pending.push(record);
		state.flushScheduler.schedule();
	}

	async read(directory: string | undefined, token: CancellationToken): Promise<readonly IParadisCommandRecord[]> {
		const key = directory ?? COMMON_KEY;
		const state = this._state(key);
		if (state.cached === undefined || Date.now() - state.cached.readAt > READ_TTL_MS) {
			const resource = await this._existingResource(key, state, token);
			if (resource === undefined || token.isCancellationRequested) {
				return state.pending.slice();
			}
			const records = await this._readFile(resource);
			state.cached = { records, readAt: Date.now() };
			state.lineCount = records.length;
		}
		return state.pending.length > 0 ? state.cached.records.concat(state.pending) : state.cached.records;
	}

	private _state(key: string): DirectoryRecords {
		let state = this._directories.get(key);
		if (!state) {
			state = new DirectoryRecords(() => this._flush(key));
			this._directories.set(key, state);
		}
		return state;
	}

	private _flush(key: string): void {
		void this._sequencer.queue(async () => {
			const state = this._directories.get(key);
			if (!state || state.pending.length === 0) {
				return;
			}
			const added = state.pending;
			state.pending = [];
			try {
				const resource = await this._existingResource(key, state, CancellationToken.None);
				if (resource === undefined) {
					return;
				}
				if (state.lineCount === undefined) {
					state.lineCount = (await this._readFile(resource)).length;
				}
				const canAppend = this._fileService.hasCapability(resource, FileSystemProviderCapabilities.FileAppend);
				if (paradisPlanCommandRecordsWrite(state.lineCount, added.length, canAppend) === 'append') {
					await this._fileService.writeFile(resource, VSBuffer.fromString(added.map(paradisSerializeCommandRecord).join('\n') + '\n'), { append: true });
					state.lineCount += added.length;
					if (state.cached) {
						state.cached = { records: state.cached.records.concat(added), readAt: state.cached.readAt };
					}
					return;
				}
				// 縮めるとき（と追記できないとき）だけ、読み直して書き直す。
				const next = paradisAppendCommandRecords(await this._readFile(resource), added);
				await this._fileService.writeFile(resource, VSBuffer.fromString(next.map(paradisSerializeCommandRecord).join('\n') + '\n'));
				state.lineCount = next.length;
				state.cached = { records: next, readAt: Date.now() };
			} catch (error) {
				this._logService.trace('[paradisTerminalCommandRecords] could not write the command records', error);
			}
		});
	}

	private async _readFile(resource: URI): Promise<readonly IParadisCommandRecord[]> {
		try {
			const content = await this._fileService.readFile(resource);
			return paradisParseCommandRecords(content.value.toString());
		} catch (error) {
			if (!(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this._logService.trace('[paradisTerminalCommandRecords] could not read the command records', error);
			}
			return [];
		}
	}

	/**
	 * 記録のファイル。本人だけが読める形で既にあるものだけを返す（スペースのファイルはシェル統合が、
	 * 共通のファイルは main プロセスが作る）。
	 */
	private async _existingResource(key: string, state: DirectoryRecords, token: CancellationToken): Promise<URI | undefined> {
		if (key === COMMON_KEY) {
			if (state.commonResource === undefined) {
				state.commonResource = await commonRecordsFile?.();
			}
			return state.commonResource;
		}
		const folder = await paradisTerminalHistoryProvider()?.toResource(key, token);
		if (folder === undefined || token.isCancellationRequested) {
			return undefined;
		}
		const resource = joinPath(folder, PARADIS_COMMAND_RECORDS_FILE);
		return await this._fileService.exists(resource) ? resource : undefined;
	}
}

registerSingleton(IParadisTerminalCommandRecordService, ParadisTerminalCommandRecordService, InstantiationType.Delayed);
