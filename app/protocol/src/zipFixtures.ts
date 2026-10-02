// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { strToU8, zipSync } from 'fflate';

/**
 * テスト専用: 名前と中身（文字列）から zip を作る。アプリのテストが fflate を直接 import しないよう、ここに置く
 * （アプリの依存に fflate は無い。`@para/protocol` の依存として入っている）。本番のコードからは使わない。
 */
export function zipForTest(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
	return zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value])));
}
