/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { ownSpreadsheetSemanticInput, parseSpreadsheetSemantic, type ParadisSpreadsheetSemanticParseOptions } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';
import type { ParadisSpreadsheetSnapshot } from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';
import { createParadisOfficeNodeArchive } from '../office/paradisOfficeNodeArchive.js';

/** Owns caller bytes before crossing into the Node ZIP runtime and common semantic parser. */
export async function parseSpreadsheetSemanticNode(
	bytes: Uint8Array,
	inventory: ParadisOfficeInventory,
	token?: CancellationToken,
	options: ParadisSpreadsheetSemanticParseOptions = {},
): Promise<ParadisSpreadsheetSnapshot> {
	if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(bytes.byteLength)) {
		throw new ParadisOfficePackageError('invalid');
	}
	const owned = bytes.slice();
	const input = ownSpreadsheetSemanticInput(inventory, options, token);
	return parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(owned), input.inventory, token, input.options);
}
