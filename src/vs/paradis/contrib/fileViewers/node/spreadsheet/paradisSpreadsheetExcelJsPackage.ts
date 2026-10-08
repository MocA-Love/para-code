/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type JSZip from 'jszip';

/**
 * Rewrites a workbook package into the part layout exceljs expects, only when it differs.
 *
 * exceljs finds parts by name patterns (`xl/comments1.xml`, `xl/drawings/vmlDrawing1.vml`) and joins
 * relationship Targets as relative strings (`../comments1.xml`). ECMA-376 Part 2 §6.5.3 also allows an
 * absolute Target (`/xl/comments/comment1.xml`) and any part name, which some producers write; exceljs
 * then dereferences an undefined entry and the whole workbook fails to open. This rewrites absolute
 * internal Targets as relative ones and moves legacy comments and their VML into the names exceljs
 * matches. Packages already in that layout are returned unchanged (the same object).
 */
export async function normalizeWorkbookForExcelJs(buffer: Buffer, JSZipRuntime: typeof JSZip): Promise<Buffer> {
	const zip = await JSZipRuntime.loadAsync(buffer);
	const names = new Set(Object.keys(zip.files).filter(name => !zip.files[name].dir));
	let changed = false;
	const nextIndex = (prefix: string, suffix: string): number => {
		let index = 1;
		while (names.has(`${prefix}${index}${suffix}`)) {
			index++;
		}
		return index;
	};
	const relationshipParts = [...names].filter(name => name.endsWith('.rels')).sort();
	for (const relsName of relationshipParts) {
		const source = relationshipSource(relsName);
		if (source === undefined) {
			continue;
		}
		const sourceDirectory = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
		const relsFile = zip.file(relsName);
		if (!relsFile) {
			continue;
		}
		const xml = await relsFile.async('string');
		let rewritten = xml;
		const replacements: { readonly from: string; readonly to: string }[] = [];
		for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
			const element = match[0];
			if (/\bTargetMode\s*=\s*"External"/.test(element)) {
				continue;
			}
			const target = /\bTarget\s*=\s*"([^"]*)"/.exec(element)?.[1];
			const type = /\bType\s*=\s*"([^"]*)"/.exec(element)?.[1] ?? '';
			if (!target) {
				continue;
			}
			let partName = resolvePartName(sourceDirectory, target);
			if (partName === undefined || !names.has(partName)) {
				continue;
			}
			const typeName = type.slice(type.lastIndexOf('/') + 1);
			if (typeName === 'comments' && !/^xl\/comments\d+\.xml$/.test(partName)) {
				partName = movePart(zip, names, partName, `xl/comments${nextIndex('xl/comments', '.xml')}.xml`);
			} else if (typeName === 'vmlDrawing' && !/^xl\/drawings\/vmlDrawing\d+\.vml$/.test(partName)) {
				partName = movePart(zip, names, partName, `xl/drawings/vmlDrawing${nextIndex('xl/drawings/vmlDrawing', '.vml')}.vml`);
			} else if (!target.startsWith('/')) {
				continue;
			}
			replacements.push({ from: element, to: element.replace(/\bTarget\s*=\s*"[^"]*"/, `Target="${relativeTarget(sourceDirectory, partName)}"`) });
		}
		for (const { from, to } of replacements) {
			rewritten = rewritten.replace(from, to);
		}
		if (rewritten !== xml) {
			zip.file(relsName, rewritten);
			changed = true;
		}
	}
	if (!changed) {
		return buffer;
	}
	return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

/** `xl/worksheets/_rels/sheet1.xml.rels` → `xl/worksheets/sheet1.xml`; the package root → ''. */
function relationshipSource(relsName: string): string | undefined {
	if (relsName === '_rels/.rels') {
		return '';
	}
	const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(relsName);
	return match ? `${match[1] ?? ''}${match[2]}` : undefined;
}

function resolvePartName(sourceDirectory: string, target: string): string | undefined {
	const segments = target.startsWith('/') || !sourceDirectory ? [] : sourceDirectory.split('/');
	for (const segment of target.replace(/^\/+/, '').split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (segments.length === 0) {
				return undefined;
			}
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return segments.length ? segments.join('/') : undefined;
}

function relativeTarget(sourceDirectory: string, partName: string): string {
	const from = sourceDirectory ? sourceDirectory.split('/') : [];
	const to = partName.split('/');
	let common = 0;
	while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
		common++;
	}
	return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}

/** Moves a part and its relationships part; returns the new name. */
function movePart(zip: JSZip, names: Set<string>, from: string, to: string): string {
	const file = zip.file(from)!;
	zip.file(to, file.async('uint8array'));
	zip.remove(from);
	names.delete(from);
	names.add(to);
	const fromRels = relationshipPartName(from);
	const rels = zip.file(fromRels);
	if (rels) {
		const toRels = relationshipPartName(to);
		zip.file(toRels, rels.async('uint8array'));
		zip.remove(fromRels);
		names.delete(fromRels);
		names.add(toRels);
	}
	return to;
}

function relationshipPartName(partName: string): string {
	const slash = partName.lastIndexOf('/');
	return `${partName.slice(0, slash + 1)}_rels/${partName.slice(slash + 1)}.rels`;
}
