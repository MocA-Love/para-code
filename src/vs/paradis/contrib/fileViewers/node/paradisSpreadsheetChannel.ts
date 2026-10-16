/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench(renderer) ⇔ shared process 間の Excel パース用IPCチャネル。paradisNotificationsChannel.ts と
// 同じ薄いディスパッチャ方式(switch文でサービスメソッドへ委譲するだけ)。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { PARADIS_SPREADSHEET_CHANNEL, type IParadisSemanticDiagnosticsSummary, type IParadisSpreadsheetMetafileImages, type IParadisSpreadsheetService, type IParadisWorkbookData } from '../common/paradisSpreadsheet.js';
import type { IParadisPackedWorkbookData } from '../common/spreadsheet/paradisSpreadsheetStyleTable.js';
import type { ParadisSpreadsheetParseWorkerResult } from './spreadsheet/paradisSpreadsheetParseWorkerBackend.js';

/** 詳しい解析を受け持つ口（テストで差し替えられるように）。 */
export interface IParadisSpreadsheetDiagnosticsBackend {
	collect(bytes: Uint8Array, token: CancellationToken): Promise<IParadisSemanticDiagnosticsSummary>;
}

/** EMF・WMF の変換を受け持つ口（テストで差し替えられるように）。 */
export interface IParadisSpreadsheetMetafileBackend {
	convert(bytes: Uint8Array, token: CancellationToken): Promise<IParadisSpreadsheetMetafileImages>;
}

/** 表示用の解析を受け持つ worker の口（テストで差し替えられるように）。 */
export interface IParadisSpreadsheetParseBackend {
	parse(bytes: Uint8Array, imagePixelBudget: number | undefined, token: CancellationToken): Promise<ParadisSpreadsheetParseWorkerResult>;
	warm(token: CancellationToken): Promise<ParadisSpreadsheetParseWorkerResult>;
}

/** ビューアが読む上限（PARADIS_SPREADSHEET_MAX_BYTES）と同じ。これより大きいものは worker へ送らない。 */
const MAX_DIAGNOSTICS_BYTES = 20 * 1024 * 1024;

function unavailable(reason: string): IParadisSemanticDiagnosticsSummary {
	return {
		available: false, terminal: false, expectedParts: 0, parsedParts: 0, expectedSheets: 0, parsedSheets: 0,
		expectedCells: 0, parsedCells: 0, unknownElements: 0, unresolvedReferences: 0, mismatchCount: 0, unavailableReason: reason,
	};
}

/**
 * 詳しい解析は worker（別スレッド・ヒープの上限つき）で行う。shared process 本体を止めず、壊れたブックで
 * 本体ごと落ちないようにするため。worker で解析できないときも、本体では解析せずに理由だけを返す。
 */
async function createWorkerBackend(): Promise<IParadisSpreadsheetDiagnosticsBackend & IDisposable> {
	const { ParadisSpreadsheetSemanticWorkerBackend } = await import('./spreadsheet/paradisSpreadsheetSemanticWorkerBackend.js');
	const workerPath = FileAccess.asFileUri('vs/paradis/contrib/fileViewers/node/spreadsheet/paradisSpreadsheetSemanticWorkerMain.js').fsPath;
	return new ParadisSpreadsheetSemanticWorkerBackend(ParadisSpreadsheetSemanticWorkerBackend.workerFactory(workerPath));
}

/** EMF・WMF の変換も worker で行う。変換は記録 1 件の中で長く止まることがあり、本体で走らせると他のチャネルが待たされるため。 */
async function createMetafileWorkerBackend(): Promise<IParadisSpreadsheetMetafileBackend & IDisposable> {
	const { ParadisSpreadsheetMetafileWorkerBackend } = await import('./spreadsheet/paradisSpreadsheetMetafileWorkerBackend.js');
	const workerPath = FileAccess.asFileUri('vs/paradis/contrib/fileViewers/node/spreadsheet/paradisSpreadsheetMetafileWorkerMain.js').fsPath;
	return new ParadisSpreadsheetMetafileWorkerBackend(ParadisSpreadsheetMetafileWorkerBackend.workerFactory(workerPath));
}

/**
 * 表示用の解析も worker で行う（shared process 本体を止めないため）。worker の入口を同梱していない環境
 * （SSH の接続先のサーバーなど）では `undefined` を返し、本体で解析する。
 */
async function createParadisSpreadsheetParseWorkerBackend(): Promise<(IParadisSpreadsheetParseBackend & IDisposable) | undefined> {
	const { ParadisSpreadsheetParseWorkerBackend } = await import('./spreadsheet/paradisSpreadsheetParseWorkerBackend.js');
	const workerPath = FileAccess.asFileUri('vs/paradis/contrib/fileViewers/node/spreadsheet/paradisSpreadsheetParseWorkerMain.js').fsPath;
	const factory = await ParadisSpreadsheetParseWorkerBackend.workerFactory(workerPath);
	return factory ? new ParadisSpreadsheetParseWorkerBackend(factory) : undefined;
}

/** 暗号化されたブック（CFB の入れ物）か。断る文言の翻訳は本体にしか無いので、worker へ送らず本体で解析する。 */
function isCompoundFile(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0;
}

export class ParadisSpreadsheetChannel implements IServerChannel<string>, IDisposable {

	private servicePromise: Promise<IParadisSpreadsheetService> | undefined;
	private diagnosticsPromise: Promise<IParadisSpreadsheetDiagnosticsBackend & Partial<IDisposable>> | undefined;
	private metafilePromise: Promise<IParadisSpreadsheetMetafileBackend & Partial<IDisposable>> | undefined;
	private parsePromise: Promise<(IParadisSpreadsheetParseBackend & Partial<IDisposable>) | undefined> | undefined;
	private disposed = false;

	constructor(
		private readonly serviceFactory: () => Promise<IParadisSpreadsheetService> = async () => {
			const { ParadisSpreadsheetService } = await import('./paradisSpreadsheetService.js');
			return new ParadisSpreadsheetService();
		},
		private readonly diagnosticsFactory: () => Promise<IParadisSpreadsheetDiagnosticsBackend & Partial<IDisposable>> = createWorkerBackend,
		private readonly metafileFactory: () => Promise<IParadisSpreadsheetMetafileBackend & Partial<IDisposable>> = createMetafileWorkerBackend,
		/** 表示用の解析の worker。既定では使わず、本体で解析する（shared process だけが worker を渡す）。 */
		private readonly parseFactory: () => Promise<(IParadisSpreadsheetParseBackend & Partial<IDisposable>) | undefined> = async () => undefined,
	) { }

	dispose(): void {
		this.disposed = true;
		void this.diagnosticsPromise?.then(backend => backend.dispose?.(), () => undefined);
		void this.metafilePromise?.then(backend => backend.dispose?.(), () => undefined);
		void this.parsePromise?.then(backend => backend?.dispose?.(), () => undefined);
	}

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown, cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			// 表示の投影だけを返す。第 2 引数は画像の画素の上限（数でなければ既定値）。診断の指定は通さない。
			case 'parseWorkbook': return this.parseWorkbook(String(args[0]), typeof args[1] === 'number' ? args[1] : undefined, cancellationToken) as Promise<T>;
			case 'collectSemanticDiagnostics': return this.collectSemanticDiagnostics(args[0], cancellationToken) as Promise<T>;
			// 表示を返した後で、同じバイト列の EMF・WMF を worker で SVG にする。
			case 'convertMetafiles': return this.convertMetafiles(args[0], cancellationToken) as Promise<T>;
			// Excel のエディタを開いた・戻したときに呼ばれる。解析の worker を起動し、exceljs と jszip を読み込ませておく。
			// 待たずに返す（温め終わるのを誰も待たない）。
			case 'warmParser': this.warmParser(); return Promise.resolve(undefined as T);
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}

	private warmParser(): void {
		void this.getParseBackend().then(backend => backend?.warm(CancellationToken.None));
	}

	/**
	 * worker が使えれば worker で解析し、セルの書式を表にまとめた形で返す（renderer が元の形に戻す）。
	 * worker を起動できない・落ちた・混んでいるときは、今までどおり本体で解析する。
	 */
	private async parseWorkbook(base64: string, imagePixelBudget: number | undefined, token: CancellationToken): Promise<IParadisWorkbookData | IParadisPackedWorkbookData> {
		const backend = await this.getParseBackend();
		const bytes = backend ? Buffer.from(base64, 'base64') : undefined;
		if (backend && bytes && !isCompoundFile(bytes)) {
			const result = await backend.parse(bytes, imagePixelBudget, token);
			switch (result.kind) {
				case 'workbook':
					return result.workbook;
				case 'error':
					throw new Error(result.message);
				case 'unavailable':
					if (result.reason === 'cancelled') {
						throw new CancellationError();
					}
					// `failed`・`busy`・`limitExceeded`（締め切り・worker のヒープの上限）は、今までどおり本体で解析する。
					// worker を入れる前は本体の解析に締め切りも上限も無く、開けていたブックを断らないため。
					break;
			}
		}
		const service = await this.getService();
		return service.parseWorkbook(base64, imagePixelBudget);
	}

	private getParseBackend(): Promise<(IParadisSpreadsheetParseBackend & Partial<IDisposable>) | undefined> {
		if (this.disposed) {
			return Promise.resolve(undefined);
		}
		const parsePromise = this.parsePromise ??= this.parseFactory().catch(() => undefined);
		return parsePromise;
	}

	private async collectSemanticDiagnostics(value: unknown, token: CancellationToken): Promise<IParadisSemanticDiagnosticsSummary> {
		const bytes = value instanceof VSBuffer ? value.buffer : value instanceof Uint8Array ? value : undefined;
		if (!bytes) {
			return unavailable('invalid');
		}
		if (bytes.byteLength > MAX_DIAGNOSTICS_BYTES) {
			return unavailable('tooLarge');
		}
		if (this.disposed) {
			return unavailable('cancelled');
		}
		let backend: IParadisSpreadsheetDiagnosticsBackend;
		try {
			backend = await (this.diagnosticsPromise ??= this.diagnosticsFactory());
		} catch {
			this.diagnosticsPromise = undefined;
			return unavailable('failed');
		}
		return backend.collect(bytes, token);
	}

	private async convertMetafiles(value: unknown, token: CancellationToken): Promise<IParadisSpreadsheetMetafileImages> {
		const bytes = value instanceof VSBuffer ? value.buffer : value instanceof Uint8Array ? value : undefined;
		if (!bytes) {
			return { images: {}, unavailableReason: 'invalid' };
		}
		if (bytes.byteLength > MAX_DIAGNOSTICS_BYTES) {
			return { images: {}, unavailableReason: 'tooLarge' };
		}
		if (this.disposed) {
			return { images: {}, unavailableReason: 'cancelled' };
		}
		let backend: IParadisSpreadsheetMetafileBackend;
		try {
			backend = await (this.metafilePromise ??= this.metafileFactory());
		} catch {
			this.metafilePromise = undefined;
			return { images: {}, unavailableReason: 'failed' };
		}
		return backend.convert(bytes, token);
	}

	private getService(): Promise<IParadisSpreadsheetService> {
		const servicePromise = this.servicePromise ??= this.serviceFactory();
		return servicePromise.catch(error => {
			if (this.servicePromise === servicePromise) {
				this.servicePromise = undefined;
			}
			throw error;
		});
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisSpreadsheet(server: IPCServer<string>): IDisposable {
	const channel = new ParadisSpreadsheetChannel(undefined, undefined, undefined, createParadisSpreadsheetParseWorkerBackend);
	server.registerChannel(PARADIS_SPREADSHEET_CHANNEL, channel);
	return toDisposable(() => channel.dispose());
}
