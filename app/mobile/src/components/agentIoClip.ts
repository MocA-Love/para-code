// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 枠内表示に載せる本文の上限。Yoga/TextKit の測定は可視領域（200pt枠）ではなく**全文サイズ**
 * に対して走るため、数万字級を単一 Text へ流し込むと展開した瞬間に数百ms〜固まり得る。
 * 行数で切ると改行無しの巨大1行（minified JSON 等）を救えないので、文字数でも切る二段構え。
 *
 * クリップボードへのコピーは**全文が対象**（データとしては全文を持っている。EditDiff /
 * HitList の「ほか N 行」パターンと同じ割り切り）。PC側も FULL_TEXT_LIMIT(64KB) で
 * 打ち切っているため、ここより大きくなることはない。
 */
const IO_DISPLAY_LINES = 500;
const IO_DISPLAY_CHARS = 20_000;

export function clipForDisplay(body: string): { text: string; omittedLines: number } {
	const lines = body.split('\n');
	if (lines.length <= IO_DISPLAY_LINES && body.length <= IO_DISPLAY_CHARS) {
		return { text: body, omittedLines: 0 };
	}
	const kept = lines.slice(0, IO_DISPLAY_LINES);
	let text = kept.join('\n');
	if (text.length > IO_DISPLAY_CHARS) {
		text = text.slice(0, IO_DISPLAY_CHARS);
	}
	// 行数上限で切れたぶんに加え、文字数上限でさらに切ったぶんも省略として数える。
	// 改行無しの巨大1行（minified JSON 等）は行数では1行しか減らず、省略表示なしで
	// 黙って切れてしまうため。残りのバイト数から概算する（切り口が行の途中でも
	// 「省略している」ことの提示としては十分）。
	const lineOmitted = Math.max(0, lines.length - kept.length);
	const charOmitted = text.length < body.length && lineOmitted === 0 ? 1 : 0;
	return { text, omittedLines: lineOmitted + charOmitted };
}
