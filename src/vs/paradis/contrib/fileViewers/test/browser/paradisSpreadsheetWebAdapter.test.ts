/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisOfficeWebArchive } from '../../browser/office/paradisOfficeWebArchive.js';
import { parseSpreadsheetSemanticWeb } from '../../browser/spreadsheet/paradisSpreadsheetWebAdapter.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import type { IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

suite('ParadisSpreadsheetWebAdapter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('owns inventory and projection deeply before opening its archive', async () => {
		const bytes = await spreadsheetFixture();
		const inventory = await inspectOfficePackage(
			await createParadisOfficeWebArchive(bytes),
			PARADIS_OFFICE_BUDGET_PROFILES.browser,
			CancellationToken.None,
		);
		const mutableInventory: ParadisOfficeInventory = {
			...inventory,
			relationships: inventory.relationships.map(relationship => ({ ...relationship })),
		};
		const projectedCell = { value: '1', style: {} };
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Sheet1', minCol: 1, columnCount: 1, columnWidths: [64], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [projectedCell] }],
			}],
		};

		const parsing = parseSpreadsheetSemanticWeb(bytes, mutableInventory, CancellationToken.None, { projection });
		Object.defineProperty(mutableInventory, 'relationships', {
			configurable: true,
			value: mutableInventory.relationships.map(relationship => relationship.id === 'rIdSheet1'
				? { ...relationship, target: '/xl/worksheets/missing.xml' }
				: relationship),
		});
		Object.defineProperty(projectedCell, 'value', { configurable: true, value: 'mutated-after-call' });

		const snapshot = await parsing;
		deepStrictEqual(snapshot.sheets[0].cells.get('A1')?.rawValue, { present: true, text: '1' });
		strictEqual(snapshot.projectionDiagnostics.some(diagnostic => diagnostic.kind === 'valueMismatch' && diagnostic.cellAddress === 'A1'), false);
	});

	test('owns stable bytes before any inventory reflection and never calls ownKeys', async () => {
		const bytes = await spreadsheetFixture();
		const inventory = await inspectOfficePackage(
			await createParadisOfficeWebArchive(bytes), PARADIS_OFFICE_BUDGET_PROFILES.browser, CancellationToken.None,
		);
		const callerBytes = bytes.slice();
		let mutated = false;
		let ownKeysCalls = 0;
		const observedInventory = new Proxy(inventory, {
			ownKeys: () => { ownKeysCalls++; throw new Error('/private/unbounded-web-own-keys'); },
			getOwnPropertyDescriptor: (target, property) => {
				if (!mutated) {
					mutated = true;
					callerBytes[0] ^= 0xff;
				}
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});

		const snapshot = await parseSpreadsheetSemanticWeb(callerBytes, observedInventory, CancellationToken.None);
		deepStrictEqual(snapshot.sheets[0].cells.get('A1')?.rawValue, { present: true, text: '1' });
		strictEqual(mutated, true);
		strictEqual(ownKeysCalls, 0);
	});

	test('sanitizes ownership errors before raw Proxy details escape', async () => {
		const bytes = await spreadsheetFixture();
		const inventory = await inspectOfficePackage(
			await createParadisOfficeWebArchive(bytes),
			PARADIS_OFFICE_BUDGET_PROFILES.browser,
			CancellationToken.None,
		);
		const unsafeInventory = new Proxy(inventory, {
			getOwnPropertyDescriptor: (target, property) => {
				if (property === 'format') { throw new Error('/private/web/ownership-secret'); }
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});

		await rejects(
			parseSpreadsheetSemanticWeb(bytes, unsafeInventory, CancellationToken.None),
			error => error instanceof ParadisOfficePackageError
				&& error.message === 'invalid'
				&& !error.stack?.includes('ownership-secret'),
		);

		const poisoned = new ParadisOfficePackageError('zipBomb');
		poisoned.stack = '/private/web/poisoned-package-error';
		Object.defineProperty(poisoned, 'secret', { value: '/private/web/custom-field' });
		const poisonedInventory = new Proxy(inventory, {
			getOwnPropertyDescriptor: (target, property) => {
				if (property === 'format') { throw poisoned; }
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		await rejects(
			parseSpreadsheetSemanticWeb(bytes, poisonedInventory, CancellationToken.None),
			error => error instanceof ParadisOfficePackageError
				&& error !== poisoned
				&& error.code === 'zipBomb'
				&& !error.stack?.includes('poisoned-package-error')
				&& !Object.hasOwn(error, 'secret'),
		);
	});

	test('binds parsing to browser profile and rejects its exact entry limit plus one', async () => {
		const bytes = await spreadsheetFixture();
		const inventory = await inspectOfficePackage(
			await createParadisOfficeWebArchive(bytes),
			PARADIS_OFFICE_BUDGET_PROFILES.browser,
			CancellationToken.None,
		);
		await rejects(
			parseSpreadsheetSemanticWeb(bytes, { ...inventory, budgetProfile: 'desktopLocal' }, CancellationToken.None),
			/unsafe/,
		);

		const oversizedInventory: ParadisOfficeInventory = {
			...inventory,
			parts: Array.from({ length: PARADIS_OFFICE_BUDGET_PROFILES.browser.entryCount + 1 }, (_, index) => ({
				...inventory.parts[0], id: `/part-${index}.xml`, canonicalUri: `/part-${index}.xml`,
			})),
		};
		await rejects(
			parseSpreadsheetSemanticWeb(bytes, oversizedInventory, CancellationToken.None),
			/limitExceeded/,
		);
	});

	test('uses intrinsic byte identity and rejects the exact compressed byte limit plus one', async () => {
		const bytes = await spreadsheetFixture();
		const inventory = await inspectOfficePackage(
			await createParadisOfficeWebArchive(bytes),
			PARADIS_OFFICE_BUDGET_PROFILES.browser,
			CancellationToken.None,
		);
		let byteLengthReads = 0;
		let sliceCalls = 0;
		class PoisonedBytes extends Uint8Array {
			override get byteLength(): number { byteLengthReads++; return 1; }
			override slice(_start?: number, _end?: number): Uint8Array<ArrayBuffer> { sliceCalls++; return this; }
		}
		const poisoned = new PoisonedBytes(bytes);
		await rejects(parseSpreadsheetSemanticWeb(poisoned, inventory, CancellationToken.None), /invalid/);
		strictEqual(byteLengthReads, 0);
		strictEqual(sliceCalls, 0);

		const oversized = new Uint8Array(PARADIS_OFFICE_BUDGET_PROFILES.browser.compressedInputBytes + 1);
		await rejects(
			parseSpreadsheetSemanticWeb(oversized, inventory, CancellationToken.None),
			error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded',
		);
	});

	test('rejects shared, resizable, detached, and species-programmable bytes before reflection', async () => {
		const bytes = await spreadsheetFixture();
		const rawInventory = await inspectOfficePackage(
			await createParadisOfficeWebArchive(bytes), PARADIS_OFFICE_BUDGET_PROFILES.browser, CancellationToken.None,
		);
		let inventoryReads = 0;
		const inventory = new Proxy(rawInventory, {
			getOwnPropertyDescriptor: (target, property) => {
				inventoryReads++;
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		const invalidBytes: Uint8Array[] = [];
		if (typeof SharedArrayBuffer !== 'undefined') {
			const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
			shared.set(bytes);
			invalidBytes.push(shared);
		}
		const resizableBuffer = new ArrayBuffer(bytes.byteLength, { maxByteLength: bytes.byteLength + 1024 });
		const resizable = new Uint8Array(resizableBuffer);
		resizable.set(bytes);
		invalidBytes.push(resizable);
		const detachedBuffer = bytes.slice().buffer;
		const detached = new Uint8Array(detachedBuffer);
		structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
		invalidBytes.push(detached);
		const speciesBytes = bytes.slice();
		Object.defineProperty(speciesBytes, 'constructor', { value: { [Symbol.species]: () => speciesBytes } });
		invalidBytes.push(speciesBytes);
		const ownSpecies = bytes.slice();
		Object.defineProperty(ownSpecies, Symbol.species, { value: () => ownSpecies });
		invalidBytes.push(ownSpecies);

		for (const candidate of invalidBytes) {
			await rejects(parseSpreadsheetSemanticWeb(candidate, inventory), /invalid/);
		}
		strictEqual(inventoryReads, 0);
	});
});

async function spreadsheetFixture(): Promise<Uint8Array> {
	return buildOpcFixture({
		parts: [
			['/xl/workbook.xml', `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rIdSheet1"/></sheets></workbook>`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
			['/xl/worksheets/sheet1.xml', `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
		],
		relationships: [
			{ id: 'rIdRoot', type: `${relationshipNamespace}/officeDocument`, target: 'xl/workbook.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdSheet1', type: `${relationshipNamespace}/worksheet`, target: 'worksheets/sheet1.xml' },
		],
	});
}
