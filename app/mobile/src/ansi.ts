// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 端末出力からANSIエスケープシーケンスを除去してプレーンテキスト化する簡易実装。
 * （xterm.js導入までの暫定。CSI/OSC/単純エスケープと復帰・後退を最低限処理する。）
 */

// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const SINGLE_ESC = /\x1b[@-Z\\-_]/g;

export function stripAnsi(input: string): string {
	let out = input.replace(OSC, '').replace(CSI, '').replace(SINGLE_ESC, '');
	// キャリッジリターンを行頭復帰として素朴に処理（\r\n はそのまま改行に）。
	out = out.replace(/\r\n/g, '\n');
	// 残る単独 \r は行の先頭に戻す挙動を近似（直前行を消さず、視認性優先で改行に寄せる）。
	out = out.replace(/\r/g, '\n');
	// バックスペースを1文字削除として処理。
	// eslint-disable-next-line no-control-regex
	out = collapseBackspaces(out);
	return out;
}

function collapseBackspaces(s: string): string {
	const result: string[] = [];
	for (const ch of s) {
		if (ch === '\b') {
			result.pop();
		} else {
			result.push(ch);
		}
	}
	return result.join('');
}
