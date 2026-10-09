/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の詳しい解析（OOXML を直接読む意味解析）の到達度を数える。exceljs を読み込まないので、
// shared process の worker（paradisSpreadsheetSemanticWorkerMain.ts）から軽く呼べる。

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import type { IParadisSemanticDiagnosticsSummary } from '../../common/paradisSpreadsheet.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { createParadisOfficeNodeArchive } from '../office/paradisOfficeNodeArchive.js';
import { parseSpreadsheetSemanticNode } from './paradisSpreadsheetNodeAdapter.js';

/**
 * 部品一覧と意味解析をあわせた締め切り。超えたら診断は「出せなかった」として表示側へ委ねる。
 * 表示（exceljs の投影）は先に返し、診断は別の呼び出しで後から届くので、表示を待たせない。
 */
export const PARADIS_SPREADSHEET_SEMANTIC_DIAGNOSTICS_DEADLINE_MS = 20_000;

/** 解析を回せなかったときの要約。理由は IPC を越えても読めるコード（`busy`・`unsafe` など）。 */
export function unavailableParadisSpreadsheetSemanticDiagnostics(reason: string, elapsedMilliseconds?: number): IParadisSemanticDiagnosticsSummary {
	return {
		available: false, terminal: false,
		expectedParts: 0, parsedParts: 0, expectedSheets: 0, parsedSheets: 0, expectedCells: 0, parsedCells: 0,
		unknownElements: 0, unresolvedReferences: 0, mismatchCount: 0, unavailableReason: reason,
		...(elapsedMilliseconds !== undefined ? { elapsedMilliseconds } : {}),
	};
}

/**
 * ExcelJS の投影とは別に OOXML を直接読み、到達度と食い違いを数える。
 * 表示そのものは投影側が担うため、ここが失敗しても表示は変わらない(理由だけ返す)。
 */
export async function collectParadisSpreadsheetSemanticDiagnostics(bytes: Uint8Array, token: CancellationToken = CancellationToken.None): Promise<IParadisSemanticDiagnosticsSummary> {
	// 解析全体に締め切りを掛ける。パッケージ検査は自前の予算(30秒)を持っており、
	// こちらの締め切りの外側にあるため、トークンで確実に止められるようにする。
	const source = new CancellationTokenSource(token);
	const timer = setTimeout(() => source.cancel(), PARADIS_SPREADSHEET_SEMANTIC_DIAGNOSTICS_DEADLINE_MS);
	const started = Date.now();
	try {
		const archive = await createParadisOfficeNodeArchive(bytes);
		// 到達度だけを数えるので、全 XML の正規化ハッシュ（比較用）は作らない。
		const inventory = await inspectOfficePackage(archive, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, source.token, { canonicalHashes: false });
		// 投影との全件突き合わせは行わない。表示用データは非表示行・列オフセット・行数上限で
		// 意図的に間引いてあるため、差分が実質すべて「表示側に無いセル」になり上限で解析ごと落ちる。
		// ここで欲しいのは「どこまで読めたか」なので到達度だけを取る。
		const snapshot = await parseSpreadsheetSemanticNode(bytes, inventory, source.token, {
			deadlineMilliseconds: PARADIS_SPREADSHEET_SEMANTIC_DIAGNOSTICS_DEADLINE_MS,
		});
		const mismatchesByKind: Record<string, number> = {};
		for (const diagnostic of snapshot.projectionDiagnostics) {
			mismatchesByKind[diagnostic.kind] = (mismatchesByKind[diagnostic.kind] ?? 0) + 1;
		}
		const completeness = snapshot.completeness;
		return {
			available: true,
			terminal: completeness.terminal,
			expectedParts: completeness.expectedParts,
			parsedParts: completeness.parsedParts,
			expectedSheets: completeness.expectedSheets,
			parsedSheets: completeness.parsedSheets,
			expectedCells: completeness.expectedCells,
			parsedCells: completeness.parsedCells,
			unknownElements: completeness.unknownElements,
			unresolvedReferences: completeness.unresolvedReferences,
			mismatchCount: snapshot.projectionDiagnostics.length,
			...(Object.keys(mismatchesByKind).length > 0 ? { mismatchesByKind } : {}),
			elapsedMilliseconds: Date.now() - started,
		};
	} catch (error) {
		// パッケージ検査の失敗は `unsafe`・`malformed` などのコードを持つ。`error.name` は常に "Error" で役に立たない。
		// 呼び出し側の取り消しは `cancelled`、締め切りは `limitExceeded` として分ける。
		const code = token.isCancellationRequested
			? 'cancelled'
			: source.token.isCancellationRequested
				? 'limitExceeded'
				: error instanceof ParadisOfficePackageError ? error.code : 'failed';
		return unavailableParadisSpreadsheetSemanticDiagnostics(code, Date.now() - started);
	} finally {
		clearTimeout(timer);
		source.dispose();
	}
}
