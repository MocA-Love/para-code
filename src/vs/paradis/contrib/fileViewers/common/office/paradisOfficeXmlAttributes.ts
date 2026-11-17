/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ParadisOfficePackageError, type ParadisOfficeXmlNode } from './paradisOfficeArchive.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

/**
 * Element and attribute readers whose bodies were exact copies in several Office parsers.
 * Readers that differ in strictness (duplicate handling, empty values, namespaces) stay in their parser.
 */

/** The element children of `element`, in document order. */
export function paradisOfficeElementChildren(element: XmlElement): readonly XmlElement[] {
	return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

/** The first attribute named `local` in no namespace. */
export function paradisOfficeUnqualifiedAttribute(node: XmlElement, local: string): string | undefined {
	return node.attributes.find(candidate => candidate.uri === '' && candidate.local === local)?.value;
}

/** Like {@link paradisOfficeUnqualifiedAttribute}, but a missing attribute is malformed. An empty value is accepted. */
export function paradisOfficeRequiredUnqualifiedAttribute(node: XmlElement, local: string): string {
	const value = paradisOfficeUnqualifiedAttribute(node, local);
	if (value === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

/** An unqualified `xsd:boolean` attribute (`1`, `true`, `0`, `false`). Any other value is malformed. */
export function paradisOfficeBooleanAttribute(node: XmlElement, local: string): boolean | undefined {
	const value = paradisOfficeUnqualifiedAttribute(node, local);
	if (value === undefined) { return undefined; }
	if (value === '1' || value === 'true') { return true; }
	if (value === '0' || value === 'false') { return false; }
	throw new ParadisOfficePackageError('malformed');
}

/** An unqualified non-negative decimal integer attribute without leading zeros, within the safe integer range. */
export function paradisOfficeIntegerAttribute(node: XmlElement, local: string): number | undefined {
	const value = paradisOfficeUnqualifiedAttribute(node, local);
	if (value === undefined) { return undefined; }
	if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result = Number(value);
	if (!Number.isSafeInteger(result)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return result;
}

/** Like {@link paradisOfficeIntegerAttribute}, but a missing attribute is malformed. */
export function paradisOfficeRequiredIntegerAttribute(node: XmlElement, local: string): number {
	const result = paradisOfficeIntegerAttribute(node, local);
	if (result === undefined) { throw new ParadisOfficePackageError('malformed'); }
	return result;
}

/** The first attribute named `local` whose namespace is one of `namespaces`. */
export function paradisOfficeAttributeInNamespaces(node: XmlElement, namespaces: ReadonlySet<string>, local: string): string | undefined {
	return node.attributes.find(candidate => namespaces.has(candidate.uri) && candidate.local === local)?.value;
}

/** The attribute `local` in namespace `uri`. The same attribute appearing more than once is malformed. */
export function paradisOfficeUniqueAttribute(element: XmlElement, uri: string, local: string): string | undefined {
	const matches = element.attributes.filter(attribute => attribute.uri === uri && attribute.local === local);
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0]?.value;
}

/** Like {@link paradisOfficeUniqueAttribute}, but a missing or empty attribute is malformed. */
export function paradisOfficeRequiredUniqueAttribute(element: XmlElement, uri: string, local: string): string {
	const value = paradisOfficeUniqueAttribute(element, uri, local);
	if (!value) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}
