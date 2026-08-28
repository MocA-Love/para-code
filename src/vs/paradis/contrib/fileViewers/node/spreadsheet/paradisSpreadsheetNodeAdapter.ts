/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { ownSpreadsheetSemanticAdapterInput, parseSpreadsheetSemantic, sanitizeSpreadsheetPackageError, type ParadisSpreadsheetSemanticParseOptions } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';
import type { ParadisSpreadsheetSnapshot } from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';
import { createParadisOfficeNodeArchive } from '../office/paradisOfficeNodeArchive.js';

/** Owns caller bytes before crossing into the Node ZIP runtime and common semantic parser. */
export async function parseSpreadsheetSemanticNode(
	bytes: Uint8Array,
	inventory: ParadisOfficeInventory,
	token?: CancellationToken,
	options: ParadisSpreadsheetSemanticParseOptions = {},
	executionProfile: Exclude<ParadisOfficeInventory['budgetProfile'], 'browser'> = 'desktopLocal',
): Promise<ParadisSpreadsheetSnapshot> {
	try {
		const input = ownSpreadsheetSemanticAdapterInput(bytes, inventory, options, token, executionProfile);
		return parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(input.bytes), input.inventory, token, input.options);
	} catch (error) {
		throw sanitizeSpreadsheetPackageError(error);
	}
}
