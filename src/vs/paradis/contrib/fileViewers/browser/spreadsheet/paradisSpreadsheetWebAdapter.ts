/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { ownSpreadsheetSemanticInput, parseSpreadsheetSemantic, sanitizeSpreadsheetPackageError, type ParadisSpreadsheetSemanticParseOptions } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';
import type { ParadisSpreadsheetSnapshot } from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';
import { createParadisOfficeWebArchive } from '../office/paradisOfficeWebArchive.js';

const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;

/** Owns caller bytes before crossing into the Worker/browser ZIP runtime and common parser. */
export async function parseSpreadsheetSemanticWeb(
	bytes: Uint8Array,
	inventory: ParadisOfficeInventory,
	token?: CancellationToken,
	options: ParadisSpreadsheetSemanticParseOptions = {},
): Promise<ParadisSpreadsheetSnapshot> {
	try {
		const byteLength = trustedUint8ArrayByteLength(bytes);
		if (!Number.isSafeInteger(byteLength)) {
			throw new ParadisOfficePackageError('invalid');
		}
		if (byteLength > PARADIS_OFFICE_BUDGET_PROFILES.browser.compressedInputBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const input = ownSpreadsheetSemanticInput(inventory, options, token, 'browser');
		return parseSpreadsheetSemantic(await createParadisOfficeWebArchive(bytes), input.inventory, token, input.options);
	} catch (error) {
		throw sanitizeSpreadsheetPackageError(error);
	}
}

function trustedUint8ArrayByteLength(bytes: Uint8Array): number {
	if (Object.getPrototypeOf(bytes) !== Uint8Array.prototype
		|| Object.hasOwn(bytes, 'byteLength')
		|| Object.hasOwn(bytes, 'slice')) {
		throw new ParadisOfficePackageError('invalid');
	}
	return typedArrayByteLength.call(bytes);
}
