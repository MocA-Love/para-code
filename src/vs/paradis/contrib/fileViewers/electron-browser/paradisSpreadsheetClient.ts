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
import { IParadisDrawingData, IParadisSemanticDiagnosticsSummary, IParadisSheetData, IParadisSpreadsheetMetafileImages, IParadisWorkbookData, PARADIS_SPREADSHEET_CHANNEL } from '../common/paradisSpreadsheet.js';
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
	/** ブックで描く画像の画素の合計の上限。比較は左右で半分ずつ渡す。無ければ既定値。 */
	imagePixelBudget?: number,
): Promise<IParadisWorkbookData> {
	const content = await fileService.readFile(resource, { limits: { size: PARADIS_SPREADSHEET_MAX_BYTES } });
	onSourceBytes?.(content.value.byteLength, content.value);
	throwIfNotWorkbook(resource, content.value);
	const base64 = encodeBase64(content.value);
	const raw = await sharedProcessService.getChannel(PARADIS_SPREADSHEET_CHANNEL).call<IParadisWorkbookData>('parseWorkbook', imagePixelBudget === undefined ? [base64] : [base64, imagePixelBudget]);

	const drawings = raw.drawingsBySheet;
	if (!drawings) {
		return raw;
	}
	// drawings は「表示順(1始まり)」でキーされている。renderer 側 DOMParser で図形/画像へ変換して付与する。
	// schemeClr の解決にはブック固有のテーマパレット(theme1.xml 由来)を使う。
	const sheets: IParadisSheetData[] = raw.sheets.map((sheet, idx) => withDrawings(sheet, drawings[idx + 1], raw.themeColors));
	// まだ描いていない EMF・WMF があるときだけ、差し替えのために drawing の XML を残す。
	const pendingMetafiles = Object.values(drawings).some(list => list.some(drawing => drawing.metafileMedia && Object.keys(drawing.metafileMedia).length > 0));
	return { sheets, themeColors: raw.themeColors, ...(pendingMetafiles ? { drawingsBySheet: drawings } : {}) };
}

function withDrawings(sheet: IParadisSheetData, drawings: readonly IParadisDrawingData[] | undefined, themeColors: IParadisWorkbookData['themeColors']): IParadisSheetData {
	const { shapes, undrawn } = parseDrawingObjects(drawings, themeColors);
	const { shapes: _shapes, undrawnObjects: _undrawn, ...rest } = sheet;
	return shapes.length > 0 || undrawn.length > 0
		? { ...rest, ...(shapes.length > 0 ? { shapes } : {}), ...(undrawn.length > 0 ? { undrawnObjects: undrawn } : {}) }
		: rest;
}

/** まだ描いていない EMF・WMF が残っているか（`convertSpreadsheetMetafiles` を頼む意味があるか）。 */
export function hasPendingSpreadsheetMetafiles(workbook: IParadisWorkbookData): boolean {
	return !!workbook.drawingsBySheet;
}

/**
 * 表示を描いた後で、EMF・WMF を SVG にしてもらう。変換は shared process の worker で走る。表示のために
 * 読んだバイト列をそのまま渡す（読み直さず、base64 にもしない）。`token` を取り消すと worker からも外れる。
 */
export async function convertSpreadsheetMetafiles(
	sharedProcessService: ISharedProcessService,
	content: VSBuffer,
	token: CancellationToken,
): Promise<IParadisSpreadsheetMetafileImages> {
	return sharedProcessService.getChannel(PARADIS_SPREADSHEET_CHANNEL).call<IParadisSpreadsheetMetafileImages>('convertMetafiles', [content], token);
}

const SVG_DATA_URL = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * 変換できた EMF・WMF を drawing に入れ、図形を読み直したブックを返す。変わったシートだけを作り直し、
 * ほかのシートはそのまま使う。変換できなかったものは代替表示の箱のまま。差し替えた後は drawing の XML を手放す。
 */
export function applySpreadsheetMetafiles(workbook: IParadisWorkbookData, converted: IParadisSpreadsheetMetafileImages): IParadisWorkbookData {
	const drawings = workbook.drawingsBySheet;
	if (!drawings) {
		return workbook;
	}
	const images = converted.images && typeof converted.images === 'object' ? converted.images : {};
	const imageFor = (name: string) => Object.hasOwn(images, name) && typeof images[name] === 'string' && SVG_DATA_URL.test(images[name]) ? images[name] : undefined;
	const sheets = workbook.sheets.map((sheet, index) => {
		const list = drawings[index + 1];
		if (!list?.some(drawing => drawing.metafileMedia && Object.keys(drawing.metafileMedia).some(rid => imageFor(drawing.metafileMedia![rid])))) {
			return sheet;
		}
		const updated = list.map((drawing): IParadisDrawingData => {
			if (!drawing.metafileMedia) {
				return drawing;
			}
			const media = { ...drawing.media };
			const rejectedMedia = { ...drawing.rejectedMedia };
			for (const rid of Object.keys(drawing.metafileMedia)) {
				const href = imageFor(drawing.metafileMedia[rid]);
				if (href) {
					media[rid] = href;
					delete rejectedMedia[rid];
				}
			}
			const { metafileMedia: _pending, rejectedMedia: _rejected, ...rest } = drawing;
			return { ...rest, media, ...(Object.keys(rejectedMedia).length > 0 ? { rejectedMedia } : {}) };
		});
		return withDrawings(sheet, updated, workbook.themeColors);
	});
	const { drawingsBySheet: _drawings, ...rest } = workbook;
	return { ...rest, sheets };
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
