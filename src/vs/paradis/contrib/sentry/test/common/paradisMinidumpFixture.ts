/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Builds the smallest minidump the parser reads: header, a directory with an unrelated stream
 * followed by the module list, and one MINIDUMP_STRING per module.
 */
export function createParadisTestMinidump(modulePaths: readonly string[]): Uint8Array {
	const headerSize = 32;
	const directorySize = 2 * 12;
	const listRva = headerSize + directorySize;
	const listSize = 4 + modulePaths.length * 108;
	const names = modulePaths.map(path => {
		const bytes = new Uint8Array(4 + path.length * 2);
		const view = new DataView(bytes.buffer);
		view.setUint32(0, path.length * 2, true);
		for (let index = 0; index < path.length; index++) {
			view.setUint16(4 + index * 2, path.charCodeAt(index), true);
		}
		return bytes;
	});
	const total = listRva + listSize + names.reduce((sum, name) => sum + name.byteLength, 0);
	const data = new Uint8Array(total);
	const view = new DataView(data.buffer);
	view.setUint32(0, 0x504d444d, true);
	view.setUint32(8, 2, true);
	view.setUint32(12, headerSize, true);
	// An unrelated stream first (ThreadListStream), so the parser has to walk the directory.
	view.setUint32(headerSize, 3, true);
	view.setUint32(headerSize + 12, 4, true);
	view.setUint32(headerSize + 12 + 4, listSize, true);
	view.setUint32(headerSize + 12 + 8, listRva, true);
	view.setUint32(listRva, modulePaths.length, true);
	let nameRva = listRva + listSize;
	names.forEach((name, index) => {
		view.setUint32(listRva + 4 + index * 108 + 20, nameRva, true);
		data.set(name, nameRva);
		nameRva += name.byteLength;
	});
	return data;
}
