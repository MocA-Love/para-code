/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * Claude Code は 2.1.277 から、送る文に目に見えない文字（ゼロ幅の文字、語結合子、BOM、タグ文字、異体字セレクタなど）が
 * あると、それを取り除いた文を入力欄に戻して「review and press Enter to send」と出し、その Enter では送らない。
 * 貼り付けの後に Enter を 1 回だけ送る Para Code では、文が入力欄に残ったまま「送れた」ことになる
 * （2.1.293 で実測、2026-10-08）。そこで貼る前に、CLI が取り除くのと同じ文字を取り除く。
 *
 * 取り除く範囲は 2.1.293 の CLI の判定の写し。絵文字の結合（ZWJ）、絵文字の異体字セレクタ（U+FE0F）、
 * 旗のタグ列、ペルシア語などの ZWNJ のように CLI が文脈で残すものは、迷う場合は残す側に倒す。
 * 残しすぎた分は CLI が確認を出すだけ（今までと同じ）で、文を壊さない。
 */

const EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const EMOJI = /^\p{Emoji}$/u;
const MARK = /^\p{M}$/u;
const JOINING_SCRIPTS = /^[\p{Script_Extensions=Arabic}\p{Script_Extensions=Syriac}\p{Script_Extensions=Nko}\p{Script_Extensions=Mongolian}\p{Script_Extensions=Devanagari}\p{Script_Extensions=Bengali}\p{Script_Extensions=Gurmukhi}\p{Script_Extensions=Gujarati}\p{Script_Extensions=Oriya}\p{Script_Extensions=Tamil}\p{Script_Extensions=Telugu}\p{Script_Extensions=Kannada}\p{Script_Extensions=Malayalam}\p{Script_Extensions=Sinhala}\p{Script_Extensions=Myanmar}\p{Script_Extensions=Khmer}\p{Script_Extensions=Tibetan}\p{Script_Extensions=Tifinagh}]$/u;
const NO_SPACE_SCRIPTS = /^[\p{Script=Khmer}\p{Script=Thai}\p{Script=Lao}\p{Script=Myanmar}]$/u;
const RIGHT_TO_LEFT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]/u;
const SELECTOR_BASES = /^[\p{Script=Egyptian_Hieroglyphs}\p{Script=Myanmar}\p{Script=Phags_Pa}\p{Script=Manichaean}\p{Sm}]$/u;
const KHMER = /^\p{Script=Khmer}$/u;
const MONGOLIAN = /^\p{Script=Mongolian}$/u;
const BRAHMI = /^\p{Script=Brahmi}$/u;
const EGYPTIAN = /^\p{Script=Egyptian_Hieroglyphs}$/u;
const DUPLOYAN = /^\p{Script=Duployan}$/u;
/** 旗のタグ列のうち CLI が残すもの（イングランド・スコットランド・ウェールズ）。 */
const FLAG_TAG_SEQUENCES = ['gbeng', 'gbsct', 'gbwls'];
const BLACK_FLAG = 0x1F3F4;
const CANCEL_TAG = 0xE007F;

/** CLI が取り除く候補の文字か（文脈で残すものも含む）。 */
function isInvisible(codePoint: number): boolean {
	if (codePoint < 0xA0) {
		return codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0A && codePoint !== 0x0D || codePoint >= 0x7F;
	}
	if (codePoint < 0x2000) {
		return codePoint === 0xAD || codePoint === 0x34F || codePoint === 0x61C || codePoint === 0x115F || codePoint === 0x1160
			|| codePoint === 0x17B4 || codePoint === 0x17B5 || codePoint >= 0x180B && codePoint <= 0x180F;
	}
	if (codePoint < 0x10000) {
		return codePoint >= 0x200B && codePoint <= 0x200F || codePoint >= 0x2028 && codePoint <= 0x202E || codePoint >= 0x2060 && codePoint <= 0x206F
			|| codePoint === 0x3164 || codePoint >= 0xFE00 && codePoint <= 0xFE0F || codePoint === 0xFEFF || codePoint === 0xFFA0 || codePoint >= 0xFFF0 && codePoint <= 0xFFFB;
	}
	return codePoint === 0x110BD || codePoint >= 0x13430 && codePoint <= 0x1343F || codePoint === 0x16FE4 || codePoint >= 0x1BCA0 && codePoint <= 0x1BCA3
		|| codePoint >= 0x1D173 && codePoint <= 0x1D17A || codePoint >= 0xE0000 && codePoint <= 0xE0FFF;
}

function matches(pattern: RegExp, char: string | undefined): boolean {
	return char !== undefined && pattern.test(char);
}

/** 旗のタグ列（U+1F3F4 の後のタグ文字と U+E007F）の長さ。CLI が残す列でなければ 0。 */
function flagTagLength(chars: readonly string[], index: number): number {
	let name = '';
	for (let i = index + 1; i < chars.length && i <= index + 6; i++) {
		const codePoint = chars[i].codePointAt(0) ?? 0;
		if (codePoint === CANCEL_TAG) {
			return FLAG_TAG_SEQUENCES.includes(name) ? i - index : 0;
		}
		if (codePoint < 0xE0061 || codePoint > 0xE007A) {
			return 0;
		}
		name += String.fromCharCode(codePoint - 0xE0000);
	}
	return 0;
}

/** 文脈により CLI が残しうる文字か。迷う場合は残す。 */
function keepInContext(codePoint: number, previous: string | undefined, next: string | undefined, line: string): boolean {
	switch (codePoint) {
		case 0x200D: {
			// 絵文字の結合（肌の色・U+FE0F を挟んでもよい）と、インド系・アラビア系の文字の中
			return matches(EXTENDED_PICTOGRAPHIC, previous) && matches(EXTENDED_PICTOGRAPHIC, next)
				|| matches(JOINING_SCRIPTS, previous) || matches(JOINING_SCRIPTS, next);
		}
		case 0x200C:
			return matches(JOINING_SCRIPTS, previous) || matches(JOINING_SCRIPTS, next);
		case 0x200B:
			return matches(NO_SPACE_SCRIPTS, previous) || matches(NO_SPACE_SCRIPTS, next);
		case 0xFE0E:
		case 0xFE0F: {
			const previousCodePoint = previous?.codePointAt(0) ?? 0;
			return previousCodePoint >= 0xA9 && (matches(EMOJI, previous) || matches(EXTENDED_PICTOGRAPHIC, previous)) || /^[0-9#*]$/.test(previous ?? '') && next === '\u20E3';
		}
		case 0xFE00:
		case 0xFE01:
		case 0xFE02:
			return matches(SELECTOR_BASES, previous);
		case 0x200E:
		case 0x200F:
		case 0x061C:
			return RIGHT_TO_LEFT.test(line);
		case 0x034F:
			return matches(MARK, previous) || matches(MARK, next);
		case 0x17B4:
		case 0x17B5:
			return matches(KHMER, previous);
		case 0x180B:
		case 0x180C:
		case 0x180D:
		case 0x180E:
		case 0x180F:
			return matches(MONGOLIAN, previous) || matches(MONGOLIAN, next);
		case 0x110BD:
			return matches(BRAHMI, previous) && matches(BRAHMI, next);
		default:
			if (codePoint >= 0x13430 && codePoint <= 0x1343F) {
				return matches(EGYPTIAN, previous) || matches(EGYPTIAN, next);
			}
			if (codePoint >= 0x1BCA0 && codePoint <= 0x1BCA3) {
				return matches(DUPLOYAN, previous) || matches(DUPLOYAN, next);
			}
			return false;
	}
}

function isSkinToneOrEmojiPresentation(codePoint: number): boolean {
	return codePoint >= 0x1F3FB && codePoint <= 0x1F3FF || codePoint === 0xFE0F;
}

/** 直前の見える文字（肌の色と U+FE0F は飛ばす。ZWJ の前の絵文字を見るため）。 */
function previousBase(kept: readonly string[], codePoint: number): string | undefined {
	let index = kept.length - 1;
	if (codePoint === 0x200D) {
		while (index >= 0 && isSkinToneOrEmojiPresentation(kept[index].codePointAt(0) ?? 0)) {
			index--;
		}
	}
	return kept[index];
}

/**
 * Claude Code が送る前に取り除く目に見えない文字を、同じように取り除く。行区切り（U+2028 など）は改行にする。
 * 取り除くものが無ければ同じ文字列を返す。
 */
export function paradisStripAgentInvisibleCharacters(text: string): string {
	// 対になっていないサロゲートは CLI も U+FFFD に置き換えて数える
	const wellFormed = text.toWellFormed();
	if (!/[^\t\n\r\x20-\x7e]/.test(wellFormed)) {
		return wellFormed;
	}
	const chars = Array.from(wellFormed);
	const kept: string[] = [];
	let lineStart = 0;
	for (let index = 0; index < chars.length; index++) {
		const char = chars[index];
		const codePoint = char.codePointAt(0) ?? 0;
		if (codePoint === 0x0A || codePoint === 0x0D) {
			lineStart = index + 1;
			kept.push(char);
			continue;
		}
		if (codePoint === BLACK_FLAG) {
			const length = flagTagLength(chars, index);
			kept.push(...chars.slice(index, index + length + 1));
			index += length;
			continue;
		}
		if (codePoint === 0x0B || codePoint === 0x0C || codePoint === 0x85 || codePoint === 0x2028 || codePoint === 0x2029) {
			lineStart = index + 1;
			kept.push('\n');
			continue;
		}
		if (!isInvisible(codePoint)) {
			kept.push(char);
			continue;
		}
		const lineEnd = chars.findIndex((candidate, at) => at > index && /^[\n\r\v\f\x85\u2028\u2029]$/.test(candidate));
		const line = chars.slice(lineStart, lineEnd === -1 ? chars.length : lineEnd).join('');
		if (keepInContext(codePoint, previousBase(kept, codePoint), chars[index + 1], line)) {
			kept.push(char);
		}
	}
	const result = kept.join('');
	return result === wellFormed ? wellFormed : result;
}
