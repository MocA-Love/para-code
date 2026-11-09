/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// The guard of Para Code's UI kit (stage 0, Q596) for the fork's own CSS under src/vs/paradis. Each rule stops one of
// the basic mistakes found in the 2026-11-09 UI audit:
//  - z-index: a number above 3 (or below 0). Floating parts use the layer variables (--paradis-z-*,
//    src/vs/paradis/browser/media/paradisTokens.css, table in paradisModal.ts); 0 to 3 stay for stacking inside a part.
//  - focus: a :focus / :focus-visible / :focus-within selector outside the one focus file (paradisFocusRing.css).
//  - codicon-size: a codicon at 13 to 15px, always a near miss for 12 or 16.
//  - hex-color: a hard-coded hex color instead of a theme color (--vscode-*, the fork's --vscode-paradis-*).
// Violations already in the tree when the guard was added are listed in paradis-ui-baseline.json (file -> rule,
// selector and declaration -> count), so only new ones fail. A finding is matched by its selector and declaration,
// not by its line, so unrelated edits do not break the build. Editing the selector or declaration of a listed rule (or
// renaming its file) shows up as a new finding: then, and after fixing listed ones, run
// `node build/lib/stylelint/paradisUiRules.ts --update-baseline` and check that the JSON diff only replaces or removes
// entries. Never run it to accept a new violation.

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

export type ParadisUiRule = 'z-index' | 'focus' | 'codicon-size' | 'hex-color';

export interface IParadisUiFinding {
	readonly rule: ParadisUiRule;
	readonly line: number;
	/** What the baseline matches: the rule, the selector and the declaration, with whitespace collapsed. */
	readonly key: string;
	readonly message: string;
}

/** file (forward slashes, from the repository root) -> finding key -> how many are allowed. */
export type ParadisUiBaseline = Readonly<Record<string, Readonly<Record<string, number>>>>;

const PARADIS_CSS = /^src\/vs\/paradis\/.+\.css$/;
/** Vendored CSS that the stylelint filter skips as well (build/filters.ts). */
const VENDORED = /^src\/vs\/paradis\/contrib\/browserExtensions\/electron-main\/media\//;
export const PARADIS_FOCUS_RULES_FILE = 'src/vs/paradis/contrib/focusRing/browser/media/paradisFocusRing.css';
const BASELINE_FILE = path.join(import.meta.dirname, 'paradis-ui-baseline.json');
/** Listed findings are matched by selector and declaration, so editing them shows up as a new finding. */
const BASELINE_HINT = 'If you only changed the selector or declaration of a rule already listed in build/lib/stylelint/paradis-ui-baseline.json (or renamed its file), run `node build/lib/stylelint/paradisUiRules.ts --update-baseline` and check that the JSON diff only replaces entries without adding any';

const RE_Z_INDEX = /^z-index\s*:\s*(?<value>.+?)\s*(?:!important)?$/i;
const RE_FONT_SIZE_PX = /^font-size\s*:\s*(?<px>[\d.]+)px/i;
const RE_HEX = /#[0-9a-f]{3,8}\b/i;
/** `:focus`, and with the word boundary also `:focus-visible` and `:focus-within`. */
const RE_FOCUS = /:focus\b/;

function collapse(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Comment bodies and quoted strings become spaces (newlines kept), so their contents never look like CSS. */
function blank(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
		.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, match => match.replace(/[^\n]/g, ' '));
}

/**
 * Walks the rules of a style sheet: `onSelector` for every block that opens (at-rules included, the caller filters
 * them), `onDeclaration` for every declaration with the innermost selector. Lines are 1-based.
 */
function walk(text: string, onSelector: (line: number, selector: string) => void, onDeclaration: (line: number, selector: string, declaration: string) => void): void {
	const source = blank(text);
	const stack: string[] = [];
	let pending = '';
	let pendingLine = 1;
	let line = 1;
	for (const character of source) {
		if (character === '\n') {
			line++;
		}
		if (character === '{') {
			const selector = collapse(pending);
			stack.push(selector);
			onSelector(pendingLine, selector);
			pending = '';
		} else if (character === '}' || character === ';') {
			const declaration = collapse(pending);
			if (declaration && stack.length) {
				onDeclaration(line, stack[stack.length - 1], declaration);
			}
			if (character === '}') {
				stack.pop();
			}
			pending = '';
		} else {
			if (!pending.trim() && character.trim()) {
				pendingLine = line;
			}
			pending += character;
		}
	}
}

/** The violations of the UI kit's rules in one CSS file. Files outside src/vs/paradis have none. */
export function findParadisUiViolations(relativePath: string, contents: string): IParadisUiFinding[] {
	const file = relativePath.replace(/\\/g, '/');
	if (!PARADIS_CSS.test(file) || VENDORED.test(file)) {
		return [];
	}
	const findings: IParadisUiFinding[] = [];
	const add = (rule: ParadisUiRule, line: number, selector: string, declaration: string, message: string) => {
		findings.push({ rule, line, key: `${rule} | ${selector} | ${declaration}`, message });
	};
	walk(contents, (line, selector) => {
		if (file !== PARADIS_FOCUS_RULES_FILE && !selector.startsWith('@') && RE_FOCUS.test(selector)) {
			add('focus', line, selector, '', `:focus belongs in ${PARADIS_FOCUS_RULES_FILE} only (one outline, keyboard focus only, --vscode-paradis-focus)`);
		}
	}, (line, selector, declaration) => {
		const zIndex = RE_Z_INDEX.exec(declaration)?.groups?.value;
		if (zIndex !== undefined && /^-?\d+$/.test(zIndex) && (Number(zIndex) < 0 || Number(zIndex) > 3)) {
			add('z-index', line, selector, declaration, `z-index ${zIndex}: use a layer variable (--paradis-z-*, table in src/vs/paradis/browser/paradisModal.ts); only 0 to 3 may be written as numbers`);
		}
		const px = RE_FONT_SIZE_PX.exec(declaration)?.groups?.px;
		if (px !== undefined && /codicon/i.test(selector) && Number(px) > 12 && Number(px) < 16) {
			add('codicon-size', line, selector, declaration, `codicon at ${px}px: use 16px (var(--vscode-codiconFontSize)) or 12px (var(--vscode-codiconFontSize-compact))`);
		}
		const declarationValue = declaration.slice(declaration.indexOf(':') + 1);
		const hex = RE_HEX.exec(declarationValue)?.[0];
		if (hex !== undefined && declaration.includes(':')) {
			add('hex-color', line, selector, declaration, `hard-coded color ${hex}: use a theme color (--vscode-*, or --vscode-paradis-* from src/vs/paradis/common/paradisColors.ts)`);
		}
	});
	return findings;
}

let cachedBaseline: ParadisUiBaseline | undefined;
function loadBaseline(): ParadisUiBaseline {
	cachedBaseline ??= JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as ParadisUiBaseline;
	return cachedBaseline;
}

/**
 * Reports the violations that are not in the baseline as errors and returns how many there were. Called for every
 * linted CSS file from build/stylelint.ts, so it runs in `npm run stylelint` and in hygiene.
 */
export function reportParadisUiRules(relativePath: string, contents: string, report: (message: string) => void, baseline: ParadisUiBaseline = loadBaseline()): number {
	const file = relativePath.replace(/\\/g, '/');
	const allowed = new Map(Object.entries(baseline[file] ?? {}));
	let errors = 0;
	for (const finding of findParadisUiViolations(file, contents)) {
		const left = allowed.get(finding.key) ?? 0;
		if (left > 0) {
			allowed.set(finding.key, left - 1);
			continue;
		}
		report(`${file}(${finding.line},1): [paradis-ui ${finding.rule}] ${finding.message}. ${BASELINE_HINT}`);
		errors++;
	}
	return errors;
}

/** Counts the violations of the given files, the shape of paradis-ui-baseline.json. */
export function buildParadisUiBaseline(files: readonly { readonly path: string; readonly contents: string }[]): Record<string, Record<string, number>> {
	const baseline: Record<string, Record<string, number>> = {};
	for (const { path: file, contents } of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
		for (const finding of findParadisUiViolations(file, contents)) {
			const counts = baseline[file] ??= {};
			counts[finding.key] = (counts[finding.key] ?? 0) + 1;
		}
	}
	return baseline;
}

function listParadisCss(root: string): string[] {
	const result: string[] = [];
	const visit = (folder: string) => {
		for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
			const relative = `${folder}/${entry.name}`;
			if (entry.isDirectory()) {
				visit(relative);
			} else if (PARADIS_CSS.test(relative) && !VENDORED.test(relative)) {
				result.push(relative);
			}
		}
	};
	visit('src/vs/paradis');
	return result;
}

if (import.meta.main) {
	if (!process.argv.includes('--update-baseline')) {
		console.error('Usage: node build/lib/stylelint/paradisUiRules.ts --update-baseline');
		process.exit(1);
	}
	const root = path.join(import.meta.dirname, '..', '..', '..');
	const files = listParadisCss(root).map(file => ({ path: file, contents: readFileSync(path.join(root, file), 'utf8') }));
	const baseline = buildParadisUiBaseline(files);
	writeFileSync(BASELINE_FILE, JSON.stringify(baseline, undefined, '\t') + '\n');
	const total = Object.values(baseline).reduce((sum, counts) => sum + Object.values(counts).reduce((a, b) => a + b, 0), 0);
	console.log(`Wrote ${path.relative(root, BASELINE_FILE)}: ${total} findings in ${Object.keys(baseline).length} files.`);
}
