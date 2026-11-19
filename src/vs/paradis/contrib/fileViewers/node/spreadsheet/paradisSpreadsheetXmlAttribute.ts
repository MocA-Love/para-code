/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** The text of an attribute value, with the predefined and character references resolved. */
export function paradisUnescapeXmlAttribute(value: string): string {
	return value.replace(/&(?:#x(?<hex>[0-9a-fA-F]+)|#(?<decimal>[0-9]+)|(?<named>amp|lt|gt|quot|apos));/g, (entity, ...args) => {
		const groups = args[args.length - 1] as { hex?: string; decimal?: string; named?: string };
		if (groups.hex !== undefined || groups.decimal !== undefined) {
			const codePoint = groups.hex !== undefined ? parseInt(groups.hex, 16) : parseInt(groups.decimal!, 10);
			return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entity;
		}
		return { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }[groups.named as 'amp'];
	});
}

/** Escapes text for a double-quoted attribute value. */
export function paradisEscapeXmlAttribute(value: string): string {
	return value.replace(/[&<"]/g, character => character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&quot;');
}
