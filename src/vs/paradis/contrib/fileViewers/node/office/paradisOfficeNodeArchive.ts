/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'crypto';
import { Readable } from 'stream';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
// eslint-disable-next-line local/code-import-patterns
import type { SaxesTag } from 'saxes';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import { type IParadisOfficeArchive, type ParadisOfficeArchiveEntry, type ParadisOfficeXmlDocument, type ParadisOfficeXmlNode, ParadisOfficePackageError, throwIfParadisOfficeCancelled } from '../../common/office/paradisOfficeArchive.js';
import type { ParadisOfficeXmlLimits } from '../../common/office/paradisOfficeCanonicalXml.js';

interface NodeEntry extends ParadisOfficeArchiveEntry {
	readonly yauzlEntry: Entry;
}

/** Opens bounded in-memory source bytes with yauzl's lazy central-directory API. */
export async function createParadisOfficeNodeArchive(bytes: Uint8Array): Promise<IParadisOfficeArchive> {

	if (!(bytes instanceof Uint8Array)) {
		throw new ParadisOfficePackageError('invalid');
	}
	const zip = await new Promise<ZipFile>((resolve, reject) => {
		fromBuffer(Buffer.from(bytes), { lazyEntries: true, autoClose: false, strictFileNames: false }, (error, result) => {
			if (error || !result) { reject(new ParadisOfficePackageError('invalid')); } else { resolve(result); }
		});
	});
	return new ParadisOfficeNodeArchive(zip, bytes.byteLength);
}

class ParadisOfficeNodeArchive implements IParadisOfficeArchive {
	private readonly entriesByIdentity = new WeakMap<ParadisOfficeArchiveEntry, Entry>();
	private closed = false;

	constructor(private readonly zip: ZipFile, readonly containerByteLength: number) { }

	async *entries(token?: CancellationToken): AsyncIterable<ParadisOfficeArchiveEntry> {
		while (!this.closed) {
			throwIfParadisOfficeCancelled(token);
			const entry = await this.nextEntry();
			if (!entry) { return; }
			const result: NodeEntry = {
				name: entry.fileName,
				compressedBytes: entry.compressedSize,
				declaredExpandedBytes: entry.uncompressedSize,
				encrypted: (entry.generalPurposeBitFlag & 1) !== 0,
				directory: entry.fileName.endsWith('/'),
				symlink: ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000,
				unixMode: entry.externalFileAttributes >>> 16,
				yauzlEntry: entry,
			};
			this.entriesByIdentity.set(result, entry);
			yield result;
		}
	}

	async *read(entry: ParadisOfficeArchiveEntry, token?: CancellationToken): AsyncIterable<Uint8Array> {
		const yauzlEntry = this.entriesByIdentity.get(entry);
		if (!yauzlEntry || this.closed) { throw new ParadisOfficePackageError('invalid'); }
		const stream = await new Promise<Readable>((resolve, reject) => {
			this.zip.openReadStream(yauzlEntry, (error, result) => {
				if (error || !result) { reject(new ParadisOfficePackageError('invalid')); } else { resolve(result); }
			});
		});
		const listener = token?.onCancellationRequested(() => stream.destroy());
		try {
			for await (const chunk of stream) {
				throwIfParadisOfficeCancelled(token);
				yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			}
		} catch (error) {
			if (token?.isCancellationRequested) { throw new ParadisOfficePackageError('cancelled'); }
			if (error instanceof ParadisOfficePackageError) { throw error; }
			throw new ParadisOfficePackageError('invalid');
		} finally {
			listener?.dispose();
			stream.destroy();
		}
	}

	async hash(bytes: Uint8Array): Promise<ParadisOfficeFingerprint> {
		const hash = createHash('sha256').update(bytes).digest('hex');
		return { algorithm: 'sha256', value: hash, byteLength: bytes.byteLength };
	}

	async parseXml(xml: string, limits: ParadisOfficeXmlLimits, token?: CancellationToken): Promise<ParadisOfficeXmlDocument> {
		if (/<!DOCTYPE|<!ENTITY/i.test(xml)) { throw new ParadisOfficePackageError('malformed'); }
		if (typeof DOMParser !== 'undefined') {
			return parseDomXml(xml, limits, token);
		}
		const { SaxesParser } = await import('saxes');
		const stack: { node: Extract<ParadisOfficeXmlNode, { kind: 'element' }>; children: ParadisOfficeXmlNode[] }[] = [];
		let root: Extract<ParadisOfficeXmlNode, { kind: 'element' }> | undefined;
		let nodes = 0;
		let characters = 0;
		let failed = false;
		const parser = new SaxesParser({ xmlns: true, fragment: false });
		parser.on('error', () => { failed = true; });
		parser.on('opentag', (tag: SaxesTag) => {
			throwIfParadisOfficeCancelled(token);
			if (++nodes > limits.nodes || stack.length + 1 > limits.depth) { throw new ParadisOfficePackageError('limitExceeded'); }
			const attributes = Object.values(tag.attributes).map(attribute => ({ uri: attribute.uri ?? '', local: attribute.local ?? attribute.name, value: attribute.value }));
			if (attributes.some(attribute => attribute.value.length > limits.attributeLength)) { throw new ParadisOfficePackageError('limitExceeded'); }
			const node = { kind: 'element' as const, uri: tag.uri ?? '', local: tag.local ?? tag.name, attributes, children: [] as ParadisOfficeXmlNode[], namespaceBindings: { ...(tag.ns ?? {}) } };
			if (stack.length) { stack[stack.length - 1].children.push(node); } else { root = node; }
			stack.push({ node, children: node.children as ParadisOfficeXmlNode[] });
		});
		parser.on('text', text => { characters += text.length; if (characters > limits.characters) { throw new ParadisOfficePackageError('limitExceeded'); } if (stack.length) { stack[stack.length - 1].children.push({ kind: 'text', value: text }); } });
		parser.on('cdata', text => { characters += text.length; if (characters > limits.characters) { throw new ParadisOfficePackageError('limitExceeded'); } if (stack.length) { stack[stack.length - 1].children.push({ kind: 'text', value: text }); } });
		parser.on('closetag', () => { stack.pop(); });
		try { parser.write(xml).close(); } catch (error) { if (error instanceof ParadisOfficePackageError) { throw error; } throw new ParadisOfficePackageError('malformed'); }
		if (failed || !root || stack.length !== 0) { throw new ParadisOfficePackageError('malformed'); }
		return { root };
	}

	dispose(): void {
		if (!this.closed) {
			this.closed = true;
			this.zip.close();
		}
	}

	private nextEntry(): Promise<Entry | undefined> {
		return new Promise<Entry | undefined>((resolve, reject) => {
			const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
			const onEnd = () => { cleanup(); resolve(undefined); };
			const onError = () => { cleanup(); reject(new ParadisOfficePackageError('invalid')); };
			const cleanup = () => { this.zip.removeListener('entry', onEntry); this.zip.removeListener('end', onEnd); this.zip.removeListener('error', onError); };
			this.zip.once('entry', onEntry);
			this.zip.once('end', onEnd);
			this.zip.once('error', onError);
			this.zip.readEntry();
		});
	}
}

function parseDomXml(xml: string, limits: ParadisOfficeXmlLimits, token?: CancellationToken): ParadisOfficeXmlDocument {

	const document = new DOMParser().parseFromString(xml, 'application/xml');
	if (document.querySelector('parsererror') || !document.documentElement) { throw new ParadisOfficePackageError('malformed'); }
	let nodes = 0;
	let characters = 0;
	const convert = (node: Node, depth: number): ParadisOfficeXmlNode | undefined => {
		throwIfParadisOfficeCancelled(token);
		if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
			characters += node.textContent?.length ?? 0;
			if (characters > limits.characters) { throw new ParadisOfficePackageError('limitExceeded'); }
			return { kind: 'text', value: node.textContent ?? '' };
		}
		if (node.nodeType !== Node.ELEMENT_NODE) { return undefined; }
		if (++nodes > limits.nodes || depth > limits.depth) { throw new ParadisOfficePackageError('limitExceeded'); }
		const element = node as Element;
		const attributes = [...element.attributes].filter(attribute => !attribute.name.startsWith('xmlns')).map(attribute => ({ uri: attribute.namespaceURI ?? '', local: attribute.localName ?? attribute.name, value: attribute.value }));
		if (attributes.some(attribute => attribute.value.length > limits.attributeLength)) { throw new ParadisOfficePackageError('limitExceeded'); }
		return { kind: 'element', uri: element.namespaceURI ?? '', local: element.localName ?? element.nodeName, attributes, children: [...element.childNodes].map(child => convert(child, depth + 1)).filter((child): child is ParadisOfficeXmlNode => child !== undefined), namespaceBindings: namespaceBindings(element) };
	};
	const root = convert(document.documentElement, 1);
	if (!root || root.kind !== 'element') { throw new ParadisOfficePackageError('malformed'); }
	return { root };
}

function namespaceBindings(element: Element): Readonly<Record<string, string>> {

	const result: Record<string, string> = {};
	for (const attribute of element.attributes) {
		if (attribute.name === 'xmlns') { result[''] = attribute.value; }
		else if (attribute.name.startsWith('xmlns:')) { result[attribute.name.slice(6)] = attribute.value; }
	}
	return result;
}
