/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の Excel パーサを呼ぶクライアントヘルパー。
// 対象リソース(file: / git: / vscode-remote:)のバイト列を IFileService で読み、base64化して
// パースチャネルへ渡す。git: スキーム(差分の旧版)も IFileService 経由で読めるため差分でも共用できる。

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisSemanticDiagnosticsSummary, IParadisSheetData, IParadisWorkbookData, PARADIS_SPREADSHEET_CHANNEL } from '../common/paradisSpreadsheet.js';
import { parseDrawingObjects } from './paradisSpreadsheetDrawings.js';

/** ビューア/差分が扱う最大ファイルサイズ(これを超える xlsx はエラー表示にする)。 */
export const PARADIS_SPREADSHEET_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 指定リソースの xlsx を読み込み、shared process でパースした構造化データを返す。
 * 図形(斜線コネクタ等)は shared process から渡る drawing XML を renderer 側の DOMParser で解析して各シートに付与する。
 */
export async function parseSpreadsheetResource(
	fileService: IFileService,
	sharedProcessService: ISharedProcessService,
	resource: URI,
	// PARA-CODE: 読み出した大きさは呼び出し側の観測（時間切れの予算・失敗イベントの大きさ段階）に要る。
	// 返り値ではなくコールバックにしてあるのは、既存の呼び出し側の戻り値の形を変えないため。
	// 読んだバイト列も渡す（詳しい解析へ、読み直さずにそのまま渡すため）。
	onSourceBytes?: (totalBytes: number, content: VSBuffer) => void,
): Promise<IParadisWorkbookData> {
	const content = await fileService.readFile(resource, { limits: { size: PARADIS_SPREADSHEET_MAX_BYTES } });
	onSourceBytes?.(content.value.byteLength, content.value);
	throwIfNotWorkbook(resource, content.value);
	const base64 = encodeBase64(content.value);
	const raw = await sharedProcessService.getChannel(PARADIS_SPREADSHEET_CHANNEL).call<IParadisWorkbookData>('parseWorkbook', [base64]);

	const drawings = raw.drawingsBySheet;
	if (!drawings) {
		return raw;
	}
	// drawings は「表示順(1始まり)」でキーされている。renderer 側 DOMParser で図形/画像へ変換して付与する。
	// schemeClr の解決にはブック固有のテーマパレット(theme1.xml 由来)を使う。
	const sheets: IParadisSheetData[] = raw.sheets.map((sheet, idx) => {
		const { shapes, undrawn } = parseDrawingObjects(drawings[idx + 1], raw.themeColors);
		return shapes.length > 0 || undrawn.length > 0
			? { ...sheet, ...(shapes.length > 0 ? { shapes } : {}), ...(undrawn.length > 0 ? { undrawnObjects: undrawn } : {}) }
			: sheet;
	});
	return { sheets, themeColors: raw.themeColors };
}

/**
 * xlsx（ZIP）ではないファイルを開こうとした。Excel が編集中に置く所有者ファイル（`~$` で始まる名前、
 * 中身は ZIP ではない）がよく当たる。壊れたブックではなく利用者が選んだファイルの種類の問題なので、
 * 失敗の報告（Sentry）には送らない。
 */
export class ParadisSpreadsheetNotWorkbookError extends Error {
	constructor(readonly ownerFile: boolean) {
		super(ownerFile
			? localize('paradis.spreadsheet.ownerFile', "Excel が編集中に作る一時ファイルです。元のブックを開いてください。")
			: localize('paradis.spreadsheet.notWorkbook', "xlsx 形式のファイルではないため開けません。Excel が編集中に作る一時ファイルの可能性があります。"));
	}
}

/** ZIP のローカルファイルヘッダー（PK\x03\x04）。パスワード付きのブック（CFB、D0 CF 11 E0）は shared process が理由を返す。 */
function throwIfNotWorkbook(resource: URI, content: VSBuffer): void {
	const bytes = content.buffer;
	const zip = bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
	const compoundFile = bytes.byteLength >= 4 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0;
	if (!zip && !compoundFile) {
		// 所有者ファイルの文は、名前が `~$` で始まり、中身も ZIP でないときだけ出す。
		throw new ParadisSpreadsheetNotWorkbookError(basename(resource).startsWith('~$'));
	}
}

/**
 * 意味解析の到達度を、表示とは別の呼び出しで取る。表示（`parseSpreadsheetResource`）を描いた後に、
 * 表示のために読んだバイト列をそのまま渡す（読み直さず、base64 にもしない）。解析は shared process の
 * worker で 1 件ずつ走り、`token` を取り消すと待ち行列からも worker からも外れる。
 */
export async function collectSpreadsheetSemanticDiagnostics(
	sharedProcessService: ISharedProcessService,
	content: VSBuffer,
	token: CancellationToken,
): Promise<IParadisSemanticDiagnosticsSummary> {
	return sharedProcessService.getChannel(PARADIS_SPREADSHEET_CHANNEL).call<IParadisSemanticDiagnosticsSummary>('collectSemanticDiagnostics', [content], token);
}
