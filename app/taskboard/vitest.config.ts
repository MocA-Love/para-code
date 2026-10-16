// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: { alias: { '@engine': path.resolve(here, '../../src/vs/paradis/contrib/taskBoard/common') } },
	test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
