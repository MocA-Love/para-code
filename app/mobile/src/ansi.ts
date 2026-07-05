// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 端末出力からANSIエスケープシーケンスを除去してプレーンテキスト化する簡易実装。
 * （xterm.js導入までの暫定。CSI/OSC/単純エスケープと、カーソルの行内移動・行内消去を
 * 最低限「同じ行を上書きする」仮想端末として処理する。）
 *
 * 背景: zshの非同期プロンプト（gitステータス等を後から追記するテーマ）は、
 * いったん描いたプロンプト行を `\r`（行頭復帰）+ `\x1b[K`（カーソルから行末まで消去）+
 * 再描画、で更新する。これを素朴に「`\r`→改行」として扱うと、更新前後のプロンプトが
 * 別々の行として重複表示されてしまう（1コマンド送っただけで数行増えて見えるバグ）。
 * 実端末と同じく「同一行の上書き」として解釈することでこれを防ぐ。
 */

// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE = /\x1b\[([0-9;?]*)([ -/]*[@-~])/g;
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const SINGLE_ESC = /\x1b[@-Z\\-_]/g;

export function stripAnsi(input: string): string {
	// OSC（タイトル設定等、視覚効果なし）と単純ESCは事前に除去してから仮想端末を流す。
	const withoutOsc = input.replace(OSC, '').replace(SINGLE_ESC, '');

	const lines: string[][] = [[]];
	let row = 0;
	let col = 0;

	const ensureLine = (): string[] => {
		while (lines.length <= row) {
			lines.push([]);
		}
		return lines[row]!;
	};
	const writeChar = (ch: string): void => {
		const line = ensureLine();
		while (line.length < col) {
			line.push(' ');
		}
		line[col] = ch;
		col++;
	};

	let i = 0;
	while (i < withoutOsc.length) {
		const ch = withoutOsc[i];
		if (ch === undefined) {
			break;
		}
		if (ch === '\x1b') {
			// CSI (\x1b[ ... final byte) をカーソル移動・行内消去として解釈する。
			CSI_SEQUENCE.lastIndex = i;
			const match = CSI_SEQUENCE.exec(withoutOsc);
			if (match && match.index === i) {
				const full = match[0];
				const params = match[1] ?? '';
				const final = match[2] ?? '';
				const n = Number.parseInt(params, 10);
				if (final === 'K') {
					// EL: 行内消去。0/省略=カーソル以降、1=行頭からカーソルまで、2=行全体。
					const line = ensureLine();
					if (params === '1') {
						// Ps=1はカーソル位置自身を含めて消去する(ECMA-48/xterm仕様)。
						for (let c = 0; c <= col && c < line.length; c++) {
							line[c] = ' ';
						}
					} else if (params === '2') {
						line.length = 0;
					} else {
						line.length = Math.min(line.length, col);
					}
				} else if (final === 'G' || final === '`') {
					col = Math.max(0, (Number.isFinite(n) ? n : 1) - 1);
				} else if (final === 'C') {
					col += Number.isFinite(n) ? n : 1;
				} else if (final === 'D') {
					col = Math.max(0, col - (Number.isFinite(n) ? n : 1));
				}
				// それ以外（色・カーソル上下移動等）は視覚効果なしとして無視する。
				i += full.length;
				continue;
			}
			// 認識できないESC列は1文字読み飛ばす。
			i++;
			continue;
		}
		if (ch === '\r') {
			col = 0;
			i++;
			continue;
		}
		if (ch === '\n') {
			row++;
			col = 0;
			i++;
			continue;
		}
		if (ch === '\b') {
			col = Math.max(0, col - 1);
			i++;
			continue;
		}
		writeChar(ch);
		i++;
	}

	// 末尾の \n で終わる入力でも空行が失われないよう、現在行を確定させておく。
	ensureLine();
	return lines.map(line => line.join('')).join('\n');
}
