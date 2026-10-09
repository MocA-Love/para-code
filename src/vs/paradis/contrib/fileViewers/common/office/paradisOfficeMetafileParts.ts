/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// パッケージの中の EMF・WMF の画像の部品を、まとめて SVG にする（Q321 f）。Word のサニタイザ・Excel の画像の
// 読み込みから呼ぶ。上限は 1 枚 4 MiB・1 文書の合計 32 MiB で、超えたもの・描けないものは返さない（呼び出し側は
// 今までどおり代替表示の箱にする）。返す SVG は変換器が組み立てたもので、表示は `<img>`（data URL）か SVG の
// `<image>` に入れる形に限る（インラインの SVG として DOM に差し込まない）。

import { convertParadisOfficeMetafile, sniffParadisOfficeMetafile, type ParadisOfficeMetafileFormat, type ParadisOfficeMetafileResult } from './paradisOfficeMetafile.js';

/** 1 枚の SVG のバイト数の上限。 */
export const PARADIS_OFFICE_METAFILE_IMAGE_BYTES = 4 * 1024 * 1024;
/** 1 文書で変換する SVG のバイト数の合計の上限。 */
export const PARADIS_OFFICE_METAFILE_DOCUMENT_BYTES = 32 * 1024 * 1024;

const CONTENT_TYPES = new Map<string, ParadisOfficeMetafileFormat>([
	['image/x-emf', 'emf'], ['image/emf', 'emf'], ['image/x-wmf', 'wmf'], ['image/wmf', 'wmf'],
]);

/** content type が EMF か WMF なら、その種類。 */
export function paradisOfficeMetafileContentType(type: string): ParadisOfficeMetafileFormat | undefined {
	return CONTENT_TYPES.get(type.trim().toLowerCase());
}

export interface ParadisOfficeMetafilePart {
	readonly name: string;
	readonly bytes: Uint8Array;
	/** 宣言された content type。中身の署名と同じ種類のときだけ変換する。 */
	readonly contentType: string;
}

export interface ParadisOfficeMetafilePartsOptions {
	/** 変換の途中で呼ぶ（取り消しの確認と、他の処理への譲り。投げれば止まる）。 */
	readonly checkpoint?: () => void | Promise<void>;
	/** 変換した SVG の合計のバイト数の上限。既定は 32 MiB。 */
	readonly documentBytes?: number;
	/**
	 * この時刻（`Date.now()` の値）を過ぎたら、変換をやめる。変換中の画像も、残りの画像も変換しない
	 * （箱のまま）。文書全体の締め切りより前に置き、画像のために文書の表示が止まらないようにする。
	 */
	readonly deadline?: number;
}

class MetafileDeadline extends Error { }

/** 部品を順に変換し、描けたものの SVG（UTF-8）を部品の名前ごとに返す。 */
export async function convertParadisOfficeMetafileParts(parts: Iterable<ParadisOfficeMetafilePart>, options: ParadisOfficeMetafilePartsOptions = {}): Promise<Map<string, Uint8Array>> {
	const converted = new Map<string, Uint8Array>();
	const documentBytes = options.documentBytes ?? PARADIS_OFFICE_METAFILE_DOCUMENT_BYTES;
	const deadline = options.deadline;
	const checkpoint = async () => {
		if (deadline !== undefined && Date.now() > deadline) {
			throw new MetafileDeadline();
		}
		await options.checkpoint?.();
	};
	let total = 0;
	const encoder = new TextEncoder();
	for (const part of parts) {
		const declared = paradisOfficeMetafileContentType(part.contentType);
		if (!declared || sniffParadisOfficeMetafile(part.bytes) !== declared) {
			continue;
		}
		let result: ParadisOfficeMetafileResult;
		try {
			await checkpoint();
			result = await convertParadisOfficeMetafile(part.bytes, { checkpoint });
		} catch (error) {
			if (error instanceof MetafileDeadline) {
				break;
			}
			throw error;
		}
		if (!result.ok) {
			continue;
		}
		const svg = encoder.encode(result.svg);
		if (svg.byteLength > PARADIS_OFFICE_METAFILE_IMAGE_BYTES || total + svg.byteLength > documentBytes) {
			continue;
		}
		total += svg.byteLength;
		converted.set(part.name, svg);
	}
	return converted;
}
