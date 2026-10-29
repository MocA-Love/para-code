/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-crx.ts

// CRX3 の読み取りと署名の確認（P7）。Chromium の components/crx_file/crx_verifier.cc と同じ基準で確かめる。
//
//   "Cr24" | uint32 版（3） | uint32 ヘッダーの長さ | CrxFileHeader（protobuf） | zip
//
//  - ヘッダーに zip の終わりの印（EOCD・EOCD64・EOCD64 record）があれば断る（解凍が別の中身を読みうる）
//  - すべての署名（sha256_with_rsa・sha256_with_ecdsa）が「CRX3 SignedData\0 | 長さ | signed_header_data | zip」に対して
//    正しいこと。鍵の種類が署名の種類と合わなければ断る
//  - どれか 1 つの署名の鍵の hash から作った id が、ヘッダーに署名して書かれた id（crx_id）と同じであること（その鍵が
//    拡張機能の鍵。manifest の key に書き、Electron が同じ id を付けるようにする）
//  - ストアから入れるときは、Chrome ウェブストアの発行者の鍵（kPublisherKeyHash）の署名もあること

import { createHash, createPublicKey, verify, type KeyObject } from 'crypto';

const CRX_MAGIC = 'Cr24';
const SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1');
/** ヘッダーの大きさの上限（Chromium は読める限り読むが、Para Code はメモリに読むので上限を付ける）。 */
const MAX_HEADER_BYTES = 256 * 1024;
/** Chrome ウェブストアの発行者の鍵の SHA-256（crx_verifier.cc の kPublisherKeyHash）。 */
export const PARADIS_WEB_STORE_PUBLISHER_KEY_HASH = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';
/** ヘッダーに含んではいけない zip の印（crx_verifier.cc の kEocd・kEocd64・kEocd64Record）。 */
const ZIP_END_MARKS = [Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.from([0x50, 0x4b, 0x06, 0x07]), Buffer.from([0x50, 0x4b, 0x06, 0x06])];

// crx3.proto の番号
const HEADER_SHA256_WITH_RSA = 2;
const HEADER_SHA256_WITH_ECDSA = 3;
const HEADER_SIGNED_HEADER_DATA = 10000;
const PROOF_PUBLIC_KEY = 1;
const PROOF_SIGNATURE = 2;
const SIGNED_DATA_CRX_ID = 1;

/** 確かめた CRX。 */
export interface IParadisVerifiedCrx {
	readonly extensionId: string;
	/** 拡張機能の鍵（DER の SubjectPublicKeyInfo）。manifest の key に base64 で書く。 */
	readonly publicKey: Buffer;
	/** 中の zip。 */
	readonly archive: Buffer;
}

interface IProof {
	readonly algorithm: 'rsa' | 'ecdsa';
	readonly publicKey: Buffer;
	readonly signature: Buffer;
}

/** Chromium の id: SHA-256 の先頭 16 バイトの 16 進の 0〜f を a〜p にしたもの。 */
export function paradisExtensionIdFromHash(hash: Buffer): string {
	return [...hash.subarray(0, 16).toString('hex')].map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

function readVarint(buffer: Buffer, start: number): { value: number; next: number } {
	let value = 0;
	let multiplier = 1;
	for (let offset = start; offset < buffer.length && offset < start + 8; offset++) {
		const byte = buffer[offset];
		value += (byte & 0x7f) * multiplier;
		if ((byte & 0x80) === 0) {
			return { value, next: offset + 1 };
		}
		multiplier *= 128;
	}
	throw new Error('Malformed CRX header');
}

/** protobuf の 1 つのメッセージの、長さ付きの欄（ほかの形の欄は読み飛ばす）。 */
function readMessageFields(buffer: Buffer): { field: number; bytes: Buffer }[] {
	const fields: { field: number; bytes: Buffer }[] = [];
	let offset = 0;
	while (offset < buffer.length) {
		const key = readVarint(buffer, offset);
		const field = Math.floor(key.value / 8);
		const wireType = key.value % 8;
		offset = key.next;
		if (wireType === 0) {
			offset = readVarint(buffer, offset).next;
		} else if (wireType === 1) {
			offset += 8;
		} else if (wireType === 5) {
			offset += 4;
		} else if (wireType === 2) {
			const length = readVarint(buffer, offset);
			const end = length.next + length.value;
			if (end > buffer.length) {
				throw new Error('Malformed CRX header');
			}
			fields.push({ field, bytes: buffer.subarray(length.next, end) });
			offset = end;
		} else {
			throw new Error('Malformed CRX header');
		}
		if (offset > buffer.length) {
			throw new Error('Malformed CRX header');
		}
	}
	return fields;
}

function readProof(algorithm: IProof['algorithm'], bytes: Buffer): IProof {
	const fields = readMessageFields(bytes);
	const publicKey = fields.find(entry => entry.field === PROOF_PUBLIC_KEY)?.bytes;
	const signature = fields.find(entry => entry.field === PROOF_SIGNATURE)?.bytes;
	if (!publicKey || !signature) {
		throw new Error('CRX signature is incomplete');
	}
	return { algorithm, publicKey, signature };
}

function importKey(proof: IProof): KeyObject {
	let key: KeyObject;
	try {
		key = createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' });
	} catch {
		throw new Error('CRX signature has an unreadable key');
	}
	if (key.asymmetricKeyType !== (proof.algorithm === 'rsa' ? 'rsa' : 'ec')) {
		throw new Error('CRX signature key does not match its algorithm');
	}
	return key;
}

/**
 * CRX3 を読み、Chrome が入れる前と同じように確かめる。`publisherKeyHash` はテストで差し替える（既定は Chrome ウェブストアの鍵）。
 */
export function paradisVerifyCrx3(buffer: Buffer, options: { readonly expectedExtensionId: string; readonly requirePublisherProof: boolean; readonly publisherKeyHash?: string }): IParadisVerifiedCrx {
	if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== CRX_MAGIC) {
		throw new Error('Not a CRX file');
	}
	if (buffer.readUInt32LE(4) !== 3) {
		throw new Error('Only CRX3 packages are supported');
	}
	const headerSize = buffer.readUInt32LE(8);
	if (headerSize > MAX_HEADER_BYTES || 12 + headerSize >= buffer.length) {
		throw new Error('Malformed CRX header');
	}
	const header = buffer.subarray(12, 12 + headerSize);
	const archive = buffer.subarray(12 + headerSize);
	if (ZIP_END_MARKS.some(mark => header.includes(mark))) {
		throw new Error('Malformed CRX header');
	}
	const proofs: IProof[] = [];
	let signedHeaderData: Buffer | undefined;
	for (const { field, bytes } of readMessageFields(header)) {
		if (field === HEADER_SHA256_WITH_RSA) {
			proofs.push(readProof('rsa', bytes));
		} else if (field === HEADER_SHA256_WITH_ECDSA) {
			proofs.push(readProof('ecdsa', bytes));
		} else if (field === HEADER_SIGNED_HEADER_DATA) {
			signedHeaderData = bytes;
		}
	}
	const crxId = signedHeaderData ? readMessageFields(signedHeaderData).find(entry => entry.field === SIGNED_DATA_CRX_ID)?.bytes : undefined;
	if (!signedHeaderData || crxId?.length !== 16) {
		throw new Error('CRX has no signed id');
	}
	const declaredId = paradisExtensionIdFromHash(crxId);
	if (declaredId !== options.expectedExtensionId) {
		throw new Error('CRX belongs to a different extension');
	}
	if (proofs.length === 0) {
		throw new Error('CRX is not signed');
	}
	const signedHeaderLength = Buffer.alloc(4);
	signedHeaderLength.writeUInt32LE(signedHeaderData.length);
	const signedData = Buffer.concat([SIGNED_DATA_PREFIX, signedHeaderLength, signedHeaderData, archive]);
	const publisherKeyHash = options.publisherKeyHash ?? PARADIS_WEB_STORE_PUBLISHER_KEY_HASH;
	let developerKey: Buffer | undefined;
	let hasPublisherProof = false;
	for (const proof of proofs) {
		const key = importKey(proof);
		const keyHash = createHash('sha256').update(proof.publicKey).digest();
		if (paradisExtensionIdFromHash(keyHash) === declaredId) {
			developerKey = proof.publicKey;
		}
		if (keyHash.toString('hex') === publisherKeyHash) {
			hasPublisherProof = true;
		}
		if (!verify('sha256', signedData, key, proof.signature)) {
			throw new Error('CRX signature does not verify');
		}
	}
	if (!developerKey) {
		throw new Error('CRX is not signed by its own key');
	}
	if (options.requirePublisherProof && !hasPublisherProof) {
		throw new Error('CRX is not signed by the Chrome Web Store');
	}
	return { extensionId: declaredId, publicKey: developerKey, archive };
}
