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

/** Grows a little-endian buffer and lets earlier fields point at later blocks. */
class ParadisTestDumpWriter {
	private bytes: number[] = [];

	reserve(size: number): number {
		const offset = this.bytes.length;
		for (let index = 0; index < size; index++) {
			this.bytes.push(0);
		}
		return offset;
	}

	u16(offset: number, value: number): void {
		this.bytes[offset] = value & 0xff;
		this.bytes[offset + 1] = (value >>> 8) & 0xff;
	}

	u32(offset: number, value: number): void {
		for (let index = 0; index < 4; index++) {
			this.bytes[offset + index] = (value >>> (index * 8)) & 0xff;
		}
	}

	/** A MinidumpUTF8String / MinidumpByteArray: a length, then the bytes. */
	sized(text: string): number {
		const encoded = new TextEncoder().encode(text);
		const offset = this.reserve(4 + encoded.byteLength);
		this.u32(offset, encoded.byteLength);
		encoded.forEach((byte, index) => this.bytes[offset + 4 + index] = byte);
		return offset;
	}

	/** A MinidumpSimpleStringDictionary; returns its location (size, rva). */
	simpleDictionary(entries: Record<string, string>): { readonly size: number; readonly rva: number } {
		const keys = Object.keys(entries);
		if (keys.length === 0) {
			return { size: 0, rva: 0 };
		}
		const rva = this.reserve(4 + keys.length * 8);
		this.u32(rva, keys.length);
		keys.forEach((key, index) => {
			this.u32(rva + 4 + index * 8, this.sized(key));
			this.u32(rva + 8 + index * 8, this.sized(entries[key]));
		});
		return { size: 4 + keys.length * 8, rva };
	}

	toBytes(): Uint8Array {
		return new Uint8Array(this.bytes);
	}
}

/**
 * Builds a minidump with a one-module list and a crashpad info stream, laid out as Electron writes
 * them: crash keys are annotation objects of a module (the Electron framework), and the dump-wide
 * simple dictionary holds the product keys. `types` overrides an annotation's type (1 = string).
 */
export function createParadisTestCrashpadMinidump(annotations: {
	readonly objects?: Record<string, string>;
	readonly types?: Record<string, number>;
	readonly simple?: Record<string, string>;
	readonly moduleSimple?: Record<string, string>;
}): Uint8Array {
	const writer = new ParadisTestDumpWriter();
	const header = writer.reserve(32);
	writer.u32(header, 0x504d444d);
	writer.u32(header + 8, 2);
	writer.u32(header + 12, 32);
	const directory = writer.reserve(2 * 12);

	const moduleList = writer.reserve(4 + 108);
	writer.u32(moduleList, 1);
	const executable = '/Applications/Para Code.app/Contents/MacOS/Para Code';
	const name = writer.reserve(4 + executable.length * 2);
	writer.u32(name, executable.length * 2);
	for (let index = 0; index < executable.length; index++) {
		writer.u16(name + 4 + index * 2, executable.charCodeAt(index));
	}
	writer.u32(moduleList + 4 + 20, name);
	writer.u32(directory, 4);
	writer.u32(directory + 4, 4 + 108);
	writer.u32(directory + 8, moduleList);

	const info = writer.reserve(64);
	writer.u32(info, 1);
	const simple = writer.simpleDictionary(annotations.simple ?? {});
	writer.u32(info + 36, simple.size);
	writer.u32(info + 40, simple.rva);
	writer.u32(directory + 12, 0x43500001);
	writer.u32(directory + 16, 64);
	writer.u32(directory + 20, info);

	const objects = annotations.objects ?? {};
	const objectNames = Object.keys(objects);
	if (objectNames.length > 0 || annotations.moduleSimple) {
		const links = writer.reserve(4 + 12);
		writer.u32(links, 1);
		writer.u32(links + 4, 0);
		writer.u32(info + 44, 4 + 12);
		writer.u32(info + 48, links);
		const moduleInfo = writer.reserve(28);
		writer.u32(links + 8, 28);
		writer.u32(links + 12, moduleInfo);
		writer.u32(moduleInfo, 1);
		const moduleSimple = writer.simpleDictionary(annotations.moduleSimple ?? {});
		writer.u32(moduleInfo + 12, moduleSimple.size);
		writer.u32(moduleInfo + 16, moduleSimple.rva);
		if (objectNames.length > 0) {
			const list = writer.reserve(4 + objectNames.length * 12);
			writer.u32(list, objectNames.length);
			objectNames.forEach((key, index) => {
				const entry = list + 4 + index * 12;
				writer.u32(entry, writer.sized(key));
				writer.u16(entry + 4, annotations.types?.[key] ?? 1);
				writer.u32(entry + 8, writer.sized(objects[key]));
			});
			writer.u32(moduleInfo + 20, 4 + objectNames.length * 12);
			writer.u32(moduleInfo + 24, list);
		}
	}
	return writer.toBytes();
}
