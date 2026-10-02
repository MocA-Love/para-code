/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC で選んでいるファイルアイコンのテーマをモバイルへ送るための純関数（`fs.icon-theme.v1`）。
 *
 * **このファイルは import を持たない。** モバイルアプリ（`app/mobile`）が相対パスで直接 import し、
 * 名前からアイコンを決める規則（{@link paradisResolveMobileFileIcon}）を PC とアプリで同じ関数にする。
 *
 * 規則は PC のエクスプローラー（`fileIconThemeData.ts` が作る CSS と `getIconClasses.ts` のクラス）の
 * 詳細度をそのまま点数にしたもの。点数の高い規則が勝つ:
 *  - ファイル: 既定 1 / 言語 ID 2 / 拡張子（`.` の区切りの数を k として）k + 2 / ファイル名（区切りの数 s）s + 3
 *  - フォルダー: 既定 1 / 名前 2 / 開いた既定 5 / 開いた名前 6
 *  - キーが `親/名前` の規則（親のフォルダー名で絞るもの）は 1 点足す
 * 名前とキーはどちらも小文字にして比べる（PC と同じ）。モバイルは暗い地なので、`light` / `highContrast` の
 * 対応表は使わない。
 *
 * 送るのは SVG のアイコン（`iconPath` が `.svg`）だけ。フォント（Seti など `fontCharacter`）と PNG は
 * 送らず、そのアイコンはアプリの既定（lucide）で描く。SVG が 1 つも無いテーマは `supported: false`。
 */

/** アイコンのテーマの対応表（モバイルへ送る形）。アイコンは `ids` の添字で指す（同じ ID の文字列を何千回も送らない）。 */
export interface IParadisMobileIconThemeManifest {
	/** アイコンの定義 ID。対応表の値はこの配列の添字。 */
	readonly ids: readonly string[];
	readonly file?: number;
	readonly folder?: number;
	readonly folderExpanded?: number;
	/** 拡張子（先頭の `.` なし・小文字。`親/拡張子` もある）。 */
	readonly fileExtensions: Readonly<Record<string, number>>;
	/** ファイル名（小文字。`親/名前` もある）。 */
	readonly fileNames: Readonly<Record<string, number>>;
	readonly folderNames: Readonly<Record<string, number>>;
	readonly folderNamesExpanded: Readonly<Record<string, number>>;
	/** 言語 ID → アイコン。 */
	readonly languageIds: Readonly<Record<string, number>>;
	/** 拡張子（先頭の `.` なし・小文字）→ 言語 ID。テーマが言語 ID で決めている言語の分だけ。 */
	readonly languageExtensions: Readonly<Record<string, string>>;
	/** ファイル名（小文字）→ 言語 ID。同上。 */
	readonly languageFileNames: Readonly<Record<string, string>>;
}

/** 言語の登録（PC の `ILanguageService` の一部）。テストでは表で渡す。 */
export interface IParadisMobileIconLanguageLookup {
	extensions(languageId: string): readonly string[];
	filenames(languageId: string): readonly string[];
}

export type ParadisMobileIconThemeBuild =
	| { readonly supported: true; readonly manifest: IParadisMobileIconThemeManifest; /** アイコン ID → テーマの JSON からの相対パス（SVG のみ）。 */ readonly svgPaths: ReadonlyMap<string, string> }
	| { readonly supported: false; readonly reason: 'invalid' | 'no-svg' };

/** 対応表の項目の上限（Material Icon Theme 5.38 で全部で約 1.3 万件。壊れた・悪意のあるテーマで膨らませない）。 */
const MAX_ASSOCIATIONS = 60_000;
const MAX_KEY_LENGTH = 256;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

/**
 * テーマの JSON（`contributes.iconThemes[].path` の中身を読んだもの）から、モバイルへ送る対応表を作る。
 * 定義の無い ID を指す規則は捨てる（PC も CSS を作らないので、その規則は無いのと同じ）。
 */
export function paradisBuildMobileIconThemeManifest(document: unknown, language: IParadisMobileIconLanguageLookup): ParadisMobileIconThemeBuild {
	const root = asObject(document);
	const definitions = asObject(root?.iconDefinitions);
	if (root === undefined || definitions === undefined) {
		return { supported: false, reason: 'invalid' };
	}
	const svgPaths = new Map<string, string>();
	const known = new Set<string>();
	for (const [id, raw] of Object.entries(definitions)) {
		const definition = asObject(raw);
		if (definition === undefined) {
			continue;
		}
		known.add(id);
		const iconPath = definition.iconPath;
		if (typeof iconPath === 'string' && /\.svg$/i.test(iconPath)) {
			svgPaths.set(id, iconPath);
		}
	}
	if (svgPaths.size === 0) {
		return { supported: false, reason: 'no-svg' };
	}
	const ids: string[] = [];
	const indexOf = new Map<string, number>();
	let count = 0;
	const ref = (id: unknown): number | undefined => {
		if (typeof id !== 'string' || !known.has(id) || count >= MAX_ASSOCIATIONS) {
			return undefined;
		}
		count++;
		let index = indexOf.get(id);
		if (index === undefined) {
			index = ids.length;
			ids.push(id);
			indexOf.set(id, index);
		}
		return index;
	};
	const table = (value: unknown, normalizeKey: (key: string) => string): Record<string, number> => {
		const result: Record<string, number> = Object.create(null);
		for (const [key, id] of Object.entries(asObject(value) ?? {})) {
			const normalized = normalizeKey(key);
			if (normalized.length === 0 || normalized.length > MAX_KEY_LENGTH) {
				continue;
			}
			const index = ref(id);
			if (index !== undefined) {
				result[normalized] = index;
			}
		}
		return result;
	};
	const lower = (key: string) => key.toLowerCase();
	const languageIdsSource: JsonObject = { ...(asObject(root.languageIds) ?? {}) };
	// PC と同じく、jsonc の指定が無ければ json のアイコンを使う
	if (languageIdsSource.jsonc === undefined && languageIdsSource.json !== undefined) {
		languageIdsSource.jsonc = languageIdsSource.json;
	}
	const languageIds = table(languageIdsSource, key => key);
	const languageExtensions: Record<string, string> = Object.create(null);
	const languageFileNames: Record<string, string> = Object.create(null);
	for (const languageId of Object.keys(languageIds)) {
		for (const extension of language.extensions(languageId)) {
			const key = extension.replace(/^\./, '').toLowerCase();
			// 同じ拡張子を複数の言語が持つときは、先に登録された言語（PC の言語の推定と同じく先勝ち）
			if (key.length > 0 && key.length <= MAX_KEY_LENGTH && languageExtensions[key] === undefined) {
				languageExtensions[key] = languageId;
			}
		}
		for (const filename of language.filenames(languageId)) {
			const key = filename.toLowerCase();
			if (key.length > 0 && key.length <= MAX_KEY_LENGTH && languageFileNames[key] === undefined) {
				languageFileNames[key] = languageId;
			}
		}
	}
	const file = ref(root.file);
	const folder = ref(root.folder);
	const folderExpanded = ref(root.folderExpanded);
	const manifest: IParadisMobileIconThemeManifest = {
		ids,
		...(file !== undefined ? { file } : {}),
		...(folder !== undefined ? { folder } : {}),
		...(folderExpanded !== undefined ? { folderExpanded } : {}),
		fileExtensions: table(root.fileExtensions, lower),
		fileNames: table(root.fileNames, lower),
		folderNames: table(root.folderNames, lower),
		folderNamesExpanded: table(root.folderNamesExpanded, lower),
		languageIds,
		languageExtensions,
		languageFileNames,
	};
	return { supported: true, manifest, svgPaths };
}

/** 自分のキーだけを見る（`constructor` のような名前のファイルで継承されたキーを拾わない）。 */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** アプリが受け取った対応表の形を確かめる（PC は信用しない相手）。形が違えば undefined。 */
export function paradisParseMobileIconThemeManifest(value: unknown): IParadisMobileIconThemeManifest | undefined {
	const root = asObject(value);
	if (root === undefined || !Array.isArray(root.ids) || !root.ids.every(id => typeof id === 'string')) {
		return undefined;
	}
	const ids = root.ids as string[];
	const validIndex = (index: unknown): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < ids.length;
	const indexTable = (raw: unknown): Record<string, number> | undefined => {
		const object = asObject(raw);
		if (object === undefined) {
			return undefined;
		}
		const result: Record<string, number> = Object.create(null);
		for (const [key, index] of Object.entries(object)) {
			if (validIndex(index)) {
				result[key] = index;
			}
		}
		return result;
	};
	const stringTable = (raw: unknown): Record<string, string> => {
		const result: Record<string, string> = Object.create(null);
		for (const [key, languageId] of Object.entries(asObject(raw) ?? {})) {
			if (typeof languageId === 'string') {
				result[key] = languageId;
			}
		}
		return result;
	};
	const fileExtensions = indexTable(root.fileExtensions);
	const fileNames = indexTable(root.fileNames);
	const folderNames = indexTable(root.folderNames);
	const folderNamesExpanded = indexTable(root.folderNamesExpanded);
	const languageIds = indexTable(root.languageIds);
	if (fileExtensions === undefined || fileNames === undefined || folderNames === undefined || folderNamesExpanded === undefined || languageIds === undefined) {
		return undefined;
	}
	return {
		ids,
		...(validIndex(root.file) ? { file: root.file } : {}),
		...(validIndex(root.folder) ? { folder: root.folder } : {}),
		...(validIndex(root.folderExpanded) ? { folderExpanded: root.folderExpanded } : {}),
		fileExtensions,
		fileNames,
		folderNames,
		folderNamesExpanded,
		languageIds,
		languageExtensions: stringTable(root.languageExtensions),
		languageFileNames: stringTable(root.languageFileNames),
	};
}

export type ParadisMobileIconTarget = 'file' | 'folder' | 'folderExpanded';

/**
 * 名前（と親のフォルダー名）から、PC のエクスプローラーが出すのと同じアイコンの ID を返す。
 * どの規則にも当たらなければ undefined（アプリの既定のアイコンで描く）。
 *
 * PC の言語の推定は拡張子・ファイル名に加えて名前の型や 1 行目も見るが、ここでは拡張子とファイル名だけで近似する。
 */
export function paradisResolveMobileFileIcon(manifest: IParadisMobileIconThemeManifest, name: string, parentName: string | undefined, target: ParadisMobileIconTarget): string | undefined {
	const lowerName = name.toLowerCase();
	const parent = parentName !== undefined && parentName.length > 0 ? parentName.toLowerCase() : undefined;
	let bestScore = 0;
	let best: number | undefined;
	const offer = (index: number | undefined, score: number) => {
		if (index !== undefined && score > bestScore) {
			bestScore = score;
			best = index;
		}
	};
	const named = (record: Readonly<Record<string, number>>, key: string, score: number) => {
		offer(own(record, key), score);
		if (parent !== undefined) {
			offer(own(record, `${parent}/${key}`), score + 1);
		}
	};
	if (target === 'file') {
		offer(manifest.file, 1);
		const segments = lowerName.split('.');
		// 言語 ID（ファイル名の登録 → 長い拡張子から）
		let languageId = own(manifest.languageFileNames, lowerName);
		for (let i = 1; languageId === undefined && i < segments.length; i++) {
			languageId = own(manifest.languageExtensions, segments.slice(i).join('.'));
		}
		if (languageId !== undefined) {
			offer(own(manifest.languageIds, languageId), 2);
		}
		// 拡張子（`a.test.ts` は `test.ts`（3 点）と `ts`（2 点）... に区切りの数の点を足す）
		if (lowerName.length <= 255) {
			for (let i = 1; i < segments.length; i++) {
				named(manifest.fileExtensions, segments.slice(i).join('.'), segments.length - i + 2);
			}
		}
		named(manifest.fileNames, lowerName, segments.length + 3);
	} else {
		offer(manifest.folder, 1);
		named(manifest.folderNames, lowerName, 2);
		if (target === 'folderExpanded') {
			offer(manifest.folderExpanded, 5);
			named(manifest.folderNamesExpanded, lowerName, 6);
		}
	}
	return best !== undefined ? manifest.ids[best] : undefined;
}

/** SVG 1 個の上限（バイト）。Material Icon Theme の最大は 20KB 程度。 */
export const PARADIS_MOBILE_ICON_SVG_MAX_LENGTH = 64 * 1024;

/**
 * 送る・描く前の SVG の検査。テーマは拡張が持つ信用しない入力なので、スクリプト・外部の参照・
 * 埋め込みの HTML・アニメーションでの参照の書き換えを含むものは捨てる（undefined）。XML 宣言・DOCTYPE・コメントは外して返す。
 *
 * **アプリの `SvgXml`（react-native-svg）で描く前提の検査で、HTML の文脈（WebView・innerHTML）に入れてよいという意味ではない。**
 * 実体参照（`&#106;` など）と CSS のエスケープ（`\6a` など）は、元の文字に戻してから調べる（すり抜けを防ぐ）。
 */
export function paradisSanitizeMobileIconSvg(svg: string): string | undefined {
	if (svg.length > PARADIS_MOBILE_ICON_SVG_MAX_LENGTH) {
		return undefined;
	}
	if (/<!ENTITY/i.test(svg)) {
		return undefined;
	}
	const cleaned = svg
		.replace(/^﻿/, '')
		.replace(/<\?xml[\s\S]*?\?>/gi, '')
		.replace(/<!DOCTYPE[^>]*>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.trim();
	if (!/^<svg[\s>]/i.test(cleaned) || !/<\/svg>$/i.test(cleaned)) {
		return undefined;
	}
	const decoded = decodeSvgEscapes(cleaned);
	if (/<(?:script|foreignObject|iframe|object|embed|image|a\b|set\b|animate\w*|use\b[^>]*href\s*=\s*["'](?!#))/i.test(decoded)
		|| /[\s/"']on[a-z]+\s*=/i.test(decoded)
		|| /attributeName\s*=\s*["']?\s*(?:xlink:)?href/i.test(decoded)
		|| /(?:xlink:)?href\s*=\s*(?:["']\s*)?(?!["'#\s])/i.test(decoded)
		|| /url\(\s*(?:["']\s*)?(?!["'#\s])/i.test(decoded)
		|| /@import/i.test(decoded)
		|| /(?:java|vb)script\s*:/i.test(decoded)
		|| /expression\s*\(/i.test(decoded)) {
		return undefined;
	}
	return cleaned;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'', colon: ':', sol: '/', lpar: '(', rpar: ')', tab: '\t', newline: '\n' };

/** 実体参照と CSS のエスケープを元の文字に戻す（検査だけに使う。返す SVG は元のまま）。2 重のエスケープも戻す。 */
function decodeSvgEscapes(text: string): string {
	let current = text;
	for (let round = 0; round < 3; round++) {
		const next = current
			.replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => safeChar(Number.parseInt(hex, 16)))
			.replace(/&#(\d+);?/g, (_m, dec: string) => safeChar(Number.parseInt(dec, 10)))
			.replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
			.replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex: string) => safeChar(Number.parseInt(hex, 16)))
			.replace(/\\([^0-9a-f\n])/gi, '$1');
		if (next === current) {
			break;
		}
		current = next;
	}
	return current;
}

function safeChar(code: number): string {
	return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** テーマの版（テーマ・拡張の版・対応表の中身が同じなら同じ値）。FNV-1a の 2 本で 64bit 相当にする。 */
export function paradisMobileIconThemeRevision(themeId: string, extensionVersion: string, manifest: IParadisMobileIconThemeManifest): string {
	const text = `${themeId}\u0000${extensionVersion}\u0000${JSON.stringify(manifest)}`;
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		a = Math.imul(a ^ code, 0x01000193) >>> 0;
		b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
		b ^= b >>> 15;
	}
	return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** `iconSvgs` で 1 回に頼める ID の数。 */
export const PARADIS_MOBILE_ICON_SVG_REQUEST_LIMIT = 200;
/** `iconSvgs` の応答 1 回に入れる SVG の合計の上限（文字数）。超えた分はアプリが次の要求で頼み直す。 */
export const PARADIS_MOBILE_ICON_SVG_RESPONSE_BUDGET = 1024 * 1024;
