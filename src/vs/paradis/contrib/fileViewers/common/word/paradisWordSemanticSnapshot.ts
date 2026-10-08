/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 比較（compareWordSemantics）に渡す意味スナップショットを組み立てる。本文の木（ParadisWordDocument）に、
// スタイル・番号付け・図形と画像・セキュリティの補助モデルを足すと、変更を 7 種類
// （内容・書式・構造・コメント・変更履歴・オブジェクト・セキュリティ）に分けられる。
// 補助モデルは 1 つずつ作り、作れなかったものは外して名前だけ返す（比較そのものは止めない）。

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { throwIfParadisOfficeCancelled } from '../office/paradisOfficeArchive.js';
import { parseParadisOfficeXml, type ParadisOfficeXmlLimits } from '../office/paradisOfficeCanonicalXml.js';
import { parseParadisWordNumbering, type ParadisWordNumberingModel } from './paradisWordNumbering.js';
import { fingerprintParadisWordObjectBytes, parseParadisWordObjects, type ParadisWordObjectModel, type ParadisWordObjectPartInput } from './paradisWordObjects.js';
import { parseParadisWordSecurity, type ParadisWordSecurityModel } from './paradisWordSecurity.js';
import type { ParadisWordDocument } from './paradisWordSemantic.js';
import type { ParadisWordPackageFact, ParadisWordSemanticSnapshot } from './paradisWordSemanticDiff.js';
import { parseParadisWordStyles, type ParadisWordStyleModel, type ParadisWordStylePart } from './paradisWordStyles.js';

// 文書情報（docProps）は比べない。保存するたびに更新日時や編集時間が変わり、毎回「変更あり」になるため。
export type ParadisWordSnapshotModel = 'styles' | 'numbering' | 'objects' | 'security';

export interface ParadisWordSnapshotBuildResult {
	readonly snapshot: ParadisWordSemanticSnapshot;
	readonly omittedModels: readonly ParadisWordSnapshotModel[];
}

export interface ParadisWordSnapshotBuildOptions {
	readonly token?: CancellationToken;
	readonly xmlLimits: ParadisOfficeXmlLimits;
	readonly deadlineMilliseconds?: number;
}

const storyPartPattern = /^\/word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/;
const mediaPattern = /^\/word\/media\/[^/]+$/;
/** 本文の木か補助モデルが中身を比べる部品。 */
const coveredPattern = /^\/(?:\[Content_Types\]\.xml|_rels\/\.rels|word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments|styles|numbering|fontTable)\.xml|word\/_rels\/[^/]+\.rels|word\/theme\/[^/]+|word\/media\/[^/]+)$/;
/**
 * 保存するたびに中身が変わり、見た目には関係しない部品。比べると毎回「変更あり」になるので比べない
 * （文書情報の更新日時・編集時間、settings の rsid、customXml の管理用データなど）。
 */
const volatilePattern = /^\/(?:docProps\/.*|word\/settings\.xml|word\/webSettings\.xml|customXml\/.*|word\/people\.xml|word\/comments(?:Extended|Ids|Extensible)\.xml|word\/glossary\/.*)$/;

function relationshipPartUri(partUri: string): string {
	const slash = partUri.lastIndexOf('/');
	return `${partUri.slice(0, slash)}/_rels/${partUri.slice(slash + 1)}.rels`;
}

function decodeXml(bytes: Uint8Array): string {
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** `[Content_Types].xml` の Default（拡張子）と Override（部品名）から、部品の content type を引く関数を作る。 */
function contentTypeResolver(parts: ReadonlyMap<string, Uint8Array>, xmlLimits: ParadisOfficeXmlLimits, token: CancellationToken | undefined): (partUri: string) => string | undefined {
	const bytes = parts.get('/[Content_Types].xml');
	const defaults = new Map<string, string>();
	const overrides = new Map<string, string>();
	if (bytes) {
		const root = parseParadisOfficeXml(decodeXml(bytes), xmlLimits, token).root;
		for (const child of root.children) {
			if (child.kind !== 'element') {
				continue;
			}
			const attribute = (name: string) => child.attributes.find(value => value.uri === '' && value.local === name)?.value;
			const contentType = attribute('ContentType');
			if (!contentType) {
				continue;
			}
			if (child.local === 'Default') {
				const extension = attribute('Extension');
				if (extension) {
					defaults.set(extension.toLowerCase(), contentType);
				}
			} else if (child.local === 'Override') {
				const partName = attribute('PartName');
				if (partName) {
					overrides.set(partName.toLowerCase(), contentType);
				}
			}
		}
	}
	return partUri => overrides.get(partUri.toLowerCase()) ?? defaults.get(partUri.slice(partUri.lastIndexOf('.') + 1).toLowerCase());
}

/**
 * 部品の中身（キーは `/word/document.xml` のような正規化した部品名）から比較用のスナップショットを作る。
 * 部品の中身は呼び出し側が ZIP から読んだもの。ここでは外部の取得も実行もしない。
 */
export function buildParadisWordSemanticSnapshot(
	document: ParadisWordDocument,
	parts: ReadonlyMap<string, Uint8Array>,
	options: ParadisWordSnapshotBuildOptions,
): ParadisWordSnapshotBuildResult {
	const omitted: ParadisWordSnapshotModel[] = [];
	const token = options.token;
	const modelOptions = { token, ...(options.deadlineMilliseconds !== undefined ? { deadlineMilliseconds: options.deadlineMilliseconds } : {}) };
	const stylePart = (partUri: string): ParadisWordStylePart | undefined => {
		const bytes = parts.get(partUri);
		if (!bytes) {
			return undefined;
		}
		return {
			document: parseParadisOfficeXml(decodeXml(bytes), options.xmlLimits, token),
			authority: { partUri, partFingerprint: fingerprintParadisWordObjectBytes(bytes) },
		};
	};
	const attempt = <T>(model: ParadisWordSnapshotModel, build: () => T | undefined): T | undefined => {
		throwIfParadisOfficeCancelled(token);
		try {
			return build();
		} catch {
			throwIfParadisOfficeCancelled(token);
			omitted.push(model);
			return undefined;
		}
	};

	const styles = attempt<ParadisWordStyleModel>('styles', () => {
		const stylesPart = stylePart('/word/styles.xml');
		if (!stylesPart) {
			return undefined;
		}
		const themeUri = [...parts.keys()].filter(uri => /^\/word\/theme\/[^/]+\.xml$/.test(uri)).sort()[0];
		const theme = themeUri ? stylePart(themeUri) : undefined;
		const fontTable = stylePart('/word/fontTable.xml');
		return parseParadisWordStyles({ styles: stylesPart, ...(theme ? { theme } : {}), ...(fontTable ? { fontTable } : {}) }, modelOptions);
	});

	const numbering = attempt<ParadisWordNumberingModel>('numbering', () => {
		const part = stylePart('/word/numbering.xml');
		return part ? parseParadisWordNumbering(part, modelOptions) : undefined;
	});

	const objectModel = attempt<ParadisWordObjectModel>('objects', () => {
		const contentTypeOf = contentTypeResolver(parts, options.xmlLimits, token);
		const objectPart = (partUri: string): ParadisWordObjectPartInput | undefined => {
			const bytes = parts.get(partUri);
			const contentType = contentTypeOf(partUri);
			return bytes ? { bytes, source: { partUri, partFingerprint: fingerprintParadisWordObjectBytes(bytes) }, ...(contentType ? { contentType } : {}) } : undefined;
		};
		const relatedParts = [...parts.keys()].filter(uri => mediaPattern.test(uri)).sort().map(objectPart).filter((part): part is ParadisWordObjectPartInput => !!part);
		const merged: { images: ParadisWordObjectModel['images'][number][]; lines: ParadisWordObjectModel['lines'][number][]; math: ParadisWordObjectModel['math'][number][] } = { images: [], lines: [], math: [] };
		for (const partUri of [...parts.keys()].filter(uri => storyPartPattern.test(uri)).sort()) {
			const part = objectPart(partUri)!;
			const relationshipPart = objectPart(relationshipPartUri(partUri));
			const model = parseParadisWordObjects({ document: part, ...(relationshipPart ? { relationshipPart } : {}), relatedParts, token }, modelOptions);
			merged.images.push(...model.images);
			merged.lines.push(...model.lines);
			merged.math.push(...model.math);
		}
		return merged;
	});

	const securityModel = attempt<ParadisWordSecurityModel>('security', () => parseParadisWordSecurity({
		parts: [...parts].map(([partUri, bytes]) => ({ bytes, source: { partUri, partFingerprint: fingerprintParadisWordObjectBytes(bytes) } })),
		token,
	}, options.deadlineMilliseconds !== undefined ? { deadlineMilliseconds: options.deadlineMilliseconds } : {}));

	// 本文の木と補助モデルが比べない部品は、中身のハッシュだけで比べる（何が変わったかは言えないが、
	// 変わったことは伝える）。これで「比べていない部品は無い」と言えるので、比較を完了として扱える。
	const packageFacts: ParadisWordPackageFact[] = [];
	for (const [partUri, bytes] of [...parts].sort((left, right) => left[0].localeCompare(right[0]))) {
		if (coveredPattern.test(partUri) || volatilePattern.test(partUri)) {
			continue;
		}
		throwIfParadisOfficeCancelled(token);
		packageFacts.push({ kind: 'unknown', id: partUri, fingerprint: fingerprintParadisWordObjectBytes(bytes), sourceParts: [partUri] });
	}
	const units = document.completeness.nodes + document.completeness.stories;
	return {
		snapshot: {
			document,
			packageFacts,
			packageCompleteness: {
				expectedParts: parts.size, visitedParts: parts.size, parsedParts: parts.size, opaqueParts: 0,
				failedParts: omitted.length, omittedParts: 0,
				expectedSemanticUnits: units, visitedSemanticUnits: units,
				terminal: omitted.length === 0,
			},
			...(styles ? { styles } : {}),
			...(numbering ? { numbering } : {}),
			...(objectModel ? { objectModel } : {}),
			...(securityModel ? { securityModel } : {}),
		},
		omittedModels: omitted,
	};
}
