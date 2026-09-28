/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult } from '../../../../../platform/files/common/files.js';
import { paradisShouldReportViewModeError } from '../../browser/paradisRenderedFileEditor.js';

suite('ParadisRenderedFileEditor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a view-mode failure is reported unless the file is missing or renderResource already reported it', () => {
		const reported = new WeakSet<object>();
		const alreadyReported = new Error('render failed');
		reported.add(alreadyReported);

		assert.deepStrictEqual({
			missingFile: paradisShouldReportViewModeError(new FileOperationError('gone', FileOperationResult.FILE_NOT_FOUND), reported),
			alreadyReported: paradisShouldReportViewModeError(alreadyReported, reported),
			permissionDenied: paradisShouldReportViewModeError(new FileOperationError('denied', FileOperationResult.FILE_PERMISSION_DENIED), reported),
			other: paradisShouldReportViewModeError(new Error('other'), reported),
			nonError: paradisShouldReportViewModeError('text', reported),
		}, {
			missingFile: false,
			alreadyReported: false,
			permissionDenied: true,
			other: true,
			nonError: true,
		});
	});
});
