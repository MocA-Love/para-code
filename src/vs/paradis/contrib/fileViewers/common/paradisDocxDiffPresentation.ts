/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word 差分の表示文言。差分アルゴリズム(paradisDocxDiff.ts)は「どのプロパティがどう変わったか」という
// 構造化データまでを作り、人が読む文へ直すのはここだけの責任にしてある。
// webview 側では nls が使えないので、注釈を送る直前に renderer がこの関数で文言を埋める。

import { localize } from '../../../../nls.js';
import {
	IParadisDocxAnnotation,
	IParadisDocxFormatChange,
	ParadisDocxChangeStatus,
	PARADIS_DOCX_CHAR_STYLE_KEY,
	PARADIS_DOCX_LIST_KEY,
	PARADIS_DOCX_PARAGRAPH_STYLE_KEY,
	PARADIS_DOCX_VERTICAL_ALIGN_KEY,
} from './paradisDocx.js';

/** 「値が付いていない」ことを表す表示。 */
function noneLabel(): string {
	// allow-any-unicode-next-line
	return localize('paradis.docxDiff.format.none', "なし");
}

/** CSS プロパティ名 → 人が読む項目名。 */
function propertyLabel(property: string): string {
	switch (property) {
		// allow-any-unicode-next-line
		case 'font-weight': return localize('paradis.docxDiff.format.weight', "太さ");
		// allow-any-unicode-next-line
		case 'font-style': return localize('paradis.docxDiff.format.style', "字体");
		// allow-any-unicode-next-line
		case 'text-decoration': return localize('paradis.docxDiff.format.decoration', "下線・取り消し線");
		// allow-any-unicode-next-line
		case 'text-decoration-color': return localize('paradis.docxDiff.format.decorationColor', "下線の色");
		// allow-any-unicode-next-line
		case 'color': return localize('paradis.docxDiff.format.color', "文字色");
		// allow-any-unicode-next-line
		case 'font-size': return localize('paradis.docxDiff.format.size', "文字サイズ");
		// allow-any-unicode-next-line
		case 'font-family': return localize('paradis.docxDiff.format.font', "フォント");
		// allow-any-unicode-next-line
		case 'background-color': return localize('paradis.docxDiff.format.background', "背景色");
		// allow-any-unicode-next-line
		case 'text-transform': return localize('paradis.docxDiff.format.transform', "大文字小文字");
		// allow-any-unicode-next-line
		case 'font-variant': return localize('paradis.docxDiff.format.variant', "小型大文字");
		// allow-any-unicode-next-line
		case 'letter-spacing': return localize('paradis.docxDiff.format.letterSpacing', "文字間隔");
		// allow-any-unicode-next-line
		case 'vertical-align': case 'verticalAlign': return localize('paradis.docxDiff.format.verticalAlign', "縦位置");
		// allow-any-unicode-next-line
		case 'direction': return localize('paradis.docxDiff.format.direction', "文字方向");
		// allow-any-unicode-next-line
		case 'text-align': return localize('paradis.docxDiff.format.align', "配置");
		// allow-any-unicode-next-line
		case 'margin-left': return localize('paradis.docxDiff.format.marginLeft', "左のインデント");
		// allow-any-unicode-next-line
		case 'margin-right': return localize('paradis.docxDiff.format.marginRight', "右のインデント");
		// allow-any-unicode-next-line
		case 'margin-top': return localize('paradis.docxDiff.format.marginTop', "段落前の間隔");
		// allow-any-unicode-next-line
		case 'margin-bottom': return localize('paradis.docxDiff.format.marginBottom', "段落後の間隔");
		// allow-any-unicode-next-line
		case 'text-indent': return localize('paradis.docxDiff.format.textIndent', "1行目のインデント");
		// allow-any-unicode-next-line
		case 'line-height': return localize('paradis.docxDiff.format.lineHeight', "行間");
		// allow-any-unicode-next-line
		case 'border-top': return localize('paradis.docxDiff.format.borderTop', "上の罫線");
		// allow-any-unicode-next-line
		case 'border-bottom': return localize('paradis.docxDiff.format.borderBottom', "下の罫線");
		// allow-any-unicode-next-line
		case 'border-left': return localize('paradis.docxDiff.format.borderLeft', "左の罫線");
		// allow-any-unicode-next-line
		case 'border-right': return localize('paradis.docxDiff.format.borderRight', "右の罫線");
		// allow-any-unicode-next-line
		case PARADIS_DOCX_VERTICAL_ALIGN_KEY: return localize('paradis.docxDiff.format.script', "上付き・下付き");
		// allow-any-unicode-next-line
		case PARADIS_DOCX_CHAR_STYLE_KEY: return localize('paradis.docxDiff.format.charStyle', "文字スタイル");
		// allow-any-unicode-next-line
		case PARADIS_DOCX_PARAGRAPH_STYLE_KEY: return localize('paradis.docxDiff.format.paragraphStyle', "段落スタイル");
		// allow-any-unicode-next-line
		case PARADIS_DOCX_LIST_KEY: return localize('paradis.docxDiff.format.list', "箇条書き・段落番号");
		default: return property;
	}
}

/**
 * 「付いた/外れた」で言い切れる書式かどうかを判定し、そう言える場合はその文言を返す。
 * 「太字: normal → bold」より「太字になりました」の方が読み手に速い。
 */
function toggleDescription(change: IParadisDocxFormatChange): string | undefined {
	const { property, original, modified } = change;
	// allow-any-unicode-next-line
	const on = (label: string) => localize('paradis.docxDiff.format.turnedOn', "{0}になりました", label);
	// allow-any-unicode-next-line
	const off = (label: string) => localize('paradis.docxDiff.format.turnedOff', "{0}が解除されました", label);

	// allow-any-unicode-next-line
	const bold = localize('paradis.docxDiff.format.bold', "太字");
	// allow-any-unicode-next-line
	const italic = localize('paradis.docxDiff.format.italic', "斜体");
	// allow-any-unicode-next-line
	const underline = localize('paradis.docxDiff.format.underline', "下線");
	// allow-any-unicode-next-line
	const strike = localize('paradis.docxDiff.format.strike', "取り消し線");
	// allow-any-unicode-next-line
	const superscript = localize('paradis.docxDiff.format.superscript', "上付き");
	// allow-any-unicode-next-line
	const subscript = localize('paradis.docxDiff.format.subscript', "下付き");

	switch (property) {
		case 'font-weight': {
			const wasBold = original === 'bold';
			const isBold = modified === 'bold';
			if (wasBold === isBold) {
				return undefined;
			}
			return isBold ? on(bold) : off(bold);
		}
		case 'font-style': {
			const wasItalic = original === 'italic';
			const isItalic = modified === 'italic';
			if (wasItalic === isItalic) {
				return undefined;
			}
			return isItalic ? on(italic) : off(italic);
		}
		case 'text-decoration': {
			// docx-preview は w:u と w:strike を同じ text-decoration に書くので、
			// 「下線」「取り消し線」のどちらが変わったのかを値から読み取る。
			const hadUnderline = original?.includes('underline') ?? false;
			const hasUnderline = modified?.includes('underline') ?? false;
			const hadStrike = original?.includes('line-through') ?? false;
			const hasStrike = modified?.includes('line-through') ?? false;
			const parts: string[] = [];
			if (hadUnderline !== hasUnderline) {
				parts.push(hasUnderline ? on(underline) : off(underline));
			}
			if (hadStrike !== hasStrike) {
				parts.push(hasStrike ? on(strike) : off(strike));
			}
			// 下線の種類（実線→波線など）だけが変わった場合は、汎用の表記に任せる。
			// allow-any-unicode-next-line
			return parts.length ? parts.join(localize('paradis.docxDiff.format.separator', "、")) : undefined;
		}
		case PARADIS_DOCX_VERTICAL_ALIGN_KEY: {
			if (modified === 'sup') { return on(superscript); }
			if (modified === 'sub') { return on(subscript); }
			if (original === 'sup') { return off(superscript); }
			if (original === 'sub') { return off(subscript); }
			return undefined;
		}
		default:
			return undefined;
	}
}

/** 書式変更1件を人が読む文にする。 */
function describeFormatChange(change: IParadisDocxFormatChange): string {
	const toggled = toggleDescription(change);
	if (toggled) {
		return toggled;
	}
	const label = propertyLabel(change.property);
	const before = change.original ?? noneLabel();
	const after = change.modified ?? noneLabel();
	// allow-any-unicode-next-line
	return localize('paradis.docxDiff.format.changed', "{0}: {1} → {2}", label, before, after);
}

/** 書式変更の一覧をツールチップ1つ分の文にする。 */
export function describeDocxFormatChanges(changes: readonly IParadisDocxFormatChange[] | undefined): string | undefined {
	if (!changes?.length) {
		return undefined;
	}
	const lines: string[] = [];
	for (const change of changes) {
		const text = describeFormatChange(change);
		if (text && !lines.includes(text)) {
			lines.push(text);
		}
	}
	return lines.length ? lines.join('\n') : undefined;
}

/** 変更の種別を示す短いラベル（ツールバーの凡例・変更一覧に使う）。 */
export function describeDocxChangeStatus(status: ParadisDocxChangeStatus): string {
	switch (status) {
		// allow-any-unicode-next-line
		case 'added': return localize('paradis.docxDiff.status.added', "追加");
		// allow-any-unicode-next-line
		case 'removed': return localize('paradis.docxDiff.status.removed', "削除");
		// allow-any-unicode-next-line
		case 'modified': return localize('paradis.docxDiff.status.modified', "変更");
		// allow-any-unicode-next-line
		case 'moved': return localize('paradis.docxDiff.status.moved', "移動");
		// allow-any-unicode-next-line
		case 'formatChanged': return localize('paradis.docxDiff.status.format', "書式");
	}
}

/**
 * 注釈にツールチップ本文（`detail`）を埋めた新しい配列を返す。
 * 差分アルゴリズムは文言を持たないので、webview へ送る直前にここを通す。
 */
export function localizeDocxAnnotations(annotations: readonly IParadisDocxAnnotation[]): IParadisDocxAnnotation[] {
	return annotations.map(annotation => {
		const blockDetail = describeDocxFormatChanges(annotation.blockFormat);
		let segmentsChanged = false;
		const segments = annotation.segments?.map(segment => {
			const detail = describeDocxFormatChanges(segment.format);
			if (!detail) {
				return segment;
			}
			segmentsChanged = true;
			return { ...segment, detail };
		});
		if (!blockDetail && !segmentsChanged) {
			return annotation;
		}
		return {
			...annotation,
			segments: segments ?? annotation.segments,
			detail: blockDetail ?? annotation.detail,
		};
	});
}
