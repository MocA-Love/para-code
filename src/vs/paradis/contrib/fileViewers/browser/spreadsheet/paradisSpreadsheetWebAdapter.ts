/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { ownSpreadsheetSemanticAdapterInput, parseSpreadsheetSemantic, sanitizeSpreadsheetPackageError, type ParadisSpreadsheetSemanticParseOptions } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';
import type { ParadisSpreadsheetSnapshot } from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';
import { createParadisOfficeWebArchive } from '../office/paradisOfficeWebArchive.js';

/** Owns caller bytes before crossing into the Worker/browser ZIP runtime and common parser. */
export async function parseSpreadsheetSemanticWeb(
	bytes: Uint8Array,
	inventory: ParadisOfficeInventory,
	token?: CancellationToken,
	options: ParadisSpreadsheetSemanticParseOptions = {},
): Promise<ParadisSpreadsheetSnapshot> {
	try {
		const input = ownSpreadsheetSemanticAdapterInput(bytes, inventory, options, token, 'browser');
		return parseSpreadsheetSemantic(await createParadisOfficeWebArchive(input.bytes), input.inventory, token, input.options);
	} catch (error) {
		throw sanitizeSpreadsheetPackageError(error);
	}
}
