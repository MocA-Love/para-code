/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の図形（drawingN.xml）とグラフ（chartN.xml）を、DOMParser で読んだ文書から辿る小さな道具。
// 名前空間の接頭辞に頼らず localName で探す。

/** 属性の値（無ければ空文字）。 */
export function xmlAttr(el: Element, name: string): string {
	return el.getAttribute(name) || '';
}

/** 名前（localName）が合う最初の子要素。 */
export function xmlChild(el: Element | null | undefined, localName: string): Element | null {
	if (!el) {
		return null;
	}
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i];
		if (child.localName === localName) {
			return child;
		}
	}
	return null;
}

/** 子要素（`localName` を渡せば、その名前のものだけ）。 */
export function xmlChildren(el: Element | null | undefined, localName?: string): Element[] {
	const result: Element[] = [];
	if (!el) {
		return result;
	}
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i];
		if (localName === undefined || child.localName === localName) {
			result.push(child);
		}
	}
	return result;
}

/** 子要素の文字（無ければ '0'）。 */
export function xmlText(el: Element, localName: string): string {
	const child = xmlChild(el, localName);
	return child?.textContent?.trim() || '0';
}

/** 属性を整数として読む。読めなければ `fallback`。 */
export function intAttr(el: Element | null, name: string, fallback: number): number {
	const value = el ? Number.parseInt(xmlAttr(el, name), 10) : Number.NaN;
	return Number.isFinite(value) ? value : fallback;
}
