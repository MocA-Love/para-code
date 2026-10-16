// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(here, '../../src/vs/paradis/contrib/taskBoard/common');
// Para Code の使用量の表示と同じ Claude Code / Codex のロゴ
const logos = path.resolve(here, '../../src/vs/paradis/common/paradisAgentLogoPaths.ts');

export default defineConfig({
	plugins: [react()],
	resolve: { alias: { '@engine': engine, '@paradis-logos': logos } },
	// 初回の読み込みで依存の最適化が走り直して React が二重になるのを防ぐ
	optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime'] },
	server: {
		allowedHosts: ['127.0.0.1', 'localhost'],
		fs: { allow: [here, engine, logos] },
	},
	build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
});
