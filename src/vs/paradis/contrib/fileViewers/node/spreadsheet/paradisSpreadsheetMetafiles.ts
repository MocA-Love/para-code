/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のブックの図形が使う EMF・WMF の画像を、まとめて SVG の data URL にする（Q321 f の Excel 側）。
// shared process の worker（paradisSpreadsheetMetafileWorkerMain.ts）から呼ぶ。変換は記録 1 件の中で長く
// 止まることがあるので、shared process 本体では走らせない。上限（1 枚 4 MiB・合計 32 MiB・読む量）は
// `convertParadisOfficeMetafileParts` の既定値をそのまま使い、締め切りを過ぎた分は変換しない。

import type JSZip from 'jszip';
import { convertParadisOfficeMetafileParts, PARADIS_OFFICE_METAFILE_DOCUMENT_INPUT_BYTES, type ParadisOfficeMetafilePart } from '../../common/office/paradisOfficeMetafileParts.js';

/** 変換にかけてよい時間（ブック全体）。過ぎたら残りは代替表示の箱のまま。 */
export const PARADIS_SPREADSHEET_METAFILE_MILLISECONDS = 10_000;

export interface IParadisSpreadsheetMetafileOptions {
	/** 変換の途中で呼ぶ（取り消しの確認。投げれば止まる）。 */
	readonly checkpoint?: () => void | Promise<void>;
	/** 締め切り（`Date.now()` の値）。既定は呼んだ時刻から `PARADIS_SPREADSHEET_METAFILE_MILLISECONDS` 後。 */
	readonly deadline?: number;
}

/** `[Content_Types].xml` から、部品の名前（`/xl/media/image1.emf`）→ content type を引く関数を作る。 */
export async function readParadisSpreadsheetContentTypes(file: JSZip.JSZipObject | undefined): Promise<(partName: string) => string> {
	const overrides = new Map<string, string>();
	const defaults = new Map<string, string>();
	for (const tag of (file ? await file.async('text') : '').match(/<(?:\w+:)?(?:Override|Default)\b[^>]*>/g) ?? []) {
		const type = /\bContentType=["']([^"']*)["']/.exec(tag)?.[1] ?? '';
		const part = /\bPartName=["']([^"']*)["']/.exec(tag)?.[1];
		const extension = /\bExtension=["']([^"']*)["']/.exec(tag)?.[1];
		if (part) {
			overrides.set(part.toLowerCase(), type);
		} else if (extension) {
			defaults.set(extension.toLowerCase(), type);
		}
	}
	return partName => overrides.get(partName.toLowerCase()) ?? defaults.get(partName.slice(partName.lastIndexOf('.') + 1).toLowerCase()) ?? '';
}

/**
 * ブック（xlsx のバイト列）の図形の関係から参照される EMF・WMF を SVG にし、メディアの名前（`image1.emf`）→
 * `data:image/svg+xml;base64,...` を返す。描けないもの・上限を越えたもの・締め切りを過ぎたものは含めない。
 */
export async function convertParadisSpreadsheetMetafiles(bytes: Uint8Array, options: IParadisSpreadsheetMetafileOptions = {}): Promise<Record<string, string>> {
	const deadline = options.deadline ?? Date.now() + PARADIS_SPREADSHEET_METAFILE_MILLISECONDS;
	const { default: JSZipRuntime } = await import('jszip');
	const zip = await JSZipRuntime.loadAsync(bytes);
	const files = zip.files;
	const names = new Set<string>();
	for (const name of Object.keys(files)) {
		if (!/^xl\/drawings\/_rels\/[^/]+\.xml\.rels$/.test(name) || files[name].dir) {
			continue;
		}
		for (const match of (await files[name].async('text')).matchAll(/Target="[^"]*media\/(?<media>[^"/]+\.(?:emf|wmf))"/gi)) {
			names.add(match.groups!.media);
		}
	}
	const result: Record<string, string> = Object.create(null);
	if (names.size === 0) {
		return result;
	}
	const contentType = await readParadisSpreadsheetContentTypes(files['[Content_Types].xml']);
	const parts: ParadisOfficeMetafilePart[] = [];
	let input = 0;
	for (const name of names) {
		const file = files[`xl/media/${name}`];
		if (!file || file.dir) {
			continue;
		}
		const media = await file.async('uint8array');
		// 変換が読む量の上限を越える分は読み込まない（変換しても、どうせ途中で打ち切られる）。
		if (input + media.byteLength > PARADIS_OFFICE_METAFILE_DOCUMENT_INPUT_BYTES) {
			break;
		}
		input += media.byteLength;
		parts.push({ name, bytes: media, contentType: contentType(`/xl/media/${name}`) });
	}
	const converted = await convertParadisOfficeMetafileParts(parts, { ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}), deadline });
	for (const [name, svg] of converted) {
		result[name] = `data:image/svg+xml;base64,${Buffer.from(svg.buffer, svg.byteOffset, svg.byteLength).toString('base64')}`;
	}
	return result;
}
