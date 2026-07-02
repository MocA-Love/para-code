/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の Excel パーサを呼ぶクライアントヘルパー。
// 対象リソース(file: / git: / vscode-remote:)のバイト列を IFileService で読み、base64化して
// パースチャネルへ渡す。git: スキーム(差分の旧版)も IFileService 経由で読めるため差分でも共用できる。

import { encodeBase64 } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisSheetData, IParadisWorkbookData, PARADIS_SPREADSHEET_CHANNEL } from '../common/paradisSpreadsheet.js';
import { parseDrawingShapes } from './paradisSpreadsheetDrawings.js';

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
): Promise<IParadisWorkbookData> {
	const content = await fileService.readFile(resource, { limits: { size: PARADIS_SPREADSHEET_MAX_BYTES } });
	const base64 = encodeBase64(content.value);
	const raw = await sharedProcessService.getChannel(PARADIS_SPREADSHEET_CHANNEL).call<IParadisWorkbookData>('parseWorkbook', [base64]);

	const drawings = raw.drawingsBySheet;
	if (!drawings) {
		return raw;
	}
	// drawings は「表示順(1始まり)」でキーされている。renderer 側 DOMParser で図形/画像へ変換して付与する。
	const sheets: IParadisSheetData[] = raw.sheets.map((sheet, idx) => {
		const shapes = parseDrawingShapes(drawings[idx + 1]);
		return shapes.length > 0 ? { ...sheet, shapes } : sheet;
	});
	return { sheets };
}
