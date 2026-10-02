// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * アプリの Claude Code / Codex のマークが、PC のヘッダー「AI 使用量」と同じグリフであることを縛る。
 * アプリは PC のソースを import できないので、両方のファイルを文字列として読んでパスを比べる。
 */

function readRelative(path: string): string {
	return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

function constant(source: string, name: string): string | undefined {
	return new RegExp(`${name} = '(?<path>[^']*)'`).exec(source)?.groups?.path;
}

describe('ProviderLogo', () => {
	test('PC の paradisAgentLogoPaths.ts と同じパスを使う', () => {
		const pc = readRelative('../../../../src/vs/paradis/common/paradisAgentLogoPaths.ts');
		const app = readRelative('./providerLogo.tsx');
		const pcPaths = { claude: constant(pc, 'PARADIS_CLAUDE_LOGO_PATH'), codex: constant(pc, 'PARADIS_CODEX_LOGO_PATH') };
		expect(pcPaths.claude).toBeTruthy();
		expect(pcPaths.codex).toBeTruthy();
		expect({ claude: constant(app, 'CLAUDE_LOGO_PATH'), codex: constant(app, 'CODEX_LOGO_PATH') }).toEqual(pcPaths);
	});
});
