/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { errorHandler, setUnexpectedErrorHandler } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { reportParadisDiagnosticError } from '../common/paradisSentryDiagnostics.js';

/**
 * upstream の `Workbench`（`workbench/browser/workbench.ts`）は起動時に `setUnexpectedErrorHandler`
 * を自前のハンドラ（`logService.error()` するだけ）で上書きする。結果、`onUnexpectedError` 経由の
 * 例外は最初から Sentry に届く経路が無い（2026-08、ローカルログには数百件出ている
 * `TypeError: Cannot read properties of undefined (reading 'terminalInstance')` が
 * Sentry 側には 0 件だったことで発覚）。
 *
 * upstream ファイルは直接改変せず、`setUnexpectedErrorHandler` が「後勝ちの単純代入」であることを
 * 利用して、既存ハンドラをさらに一段ラップする形で Sentry 送信を足す。scope は明示的に `patched` を
 * 渡す — `paradisClassifySentryEvent` は `para.scope` タグの無い自動キャプチャを
 * `/vs/paradis/` を含まないスタックだと問答無用で捨てるため、upstream 由来の例外はタグなしでは
 * 一切届かない。
 */
class ParadisUnhandledErrorReporterContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisUnhandledErrorReporter';

	constructor() {
		super();
		const previousHandler = errorHandler.getUnexpectedErrorHandler();
		setUnexpectedErrorHandler(error => {
			previousHandler(error);
			try {
				reportParadisDiagnosticError('patched', 'unhandled-error', 'on-unexpected-error', error);
			} catch {
				// Reporting must never break the handler chain it is piggybacking on.
			}
		});
	}
}

registerWorkbenchContribution2(ParadisUnhandledErrorReporterContribution.ID, ParadisUnhandledErrorReporterContribution, WorkbenchPhase.AfterRestored);
