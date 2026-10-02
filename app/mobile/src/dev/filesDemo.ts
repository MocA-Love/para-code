// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useAppStore } from '../appState.js';
import { PcCapability } from '../pcCompat.js';
import type { FsListResult, FsReadResult, ScmStatusResult, SpaceNoteResult, SpaceNoteSetOptions } from '../store.js';

/**
 * 開発ビルド専用: ファイルの一覧（Git の色・無視の印）・メモ・差分の画面を、PC とつながっていないシミュレータで
 * 確かめるための見本。`globalThis.__paraDev.demo()` の後に `__paraDev.filesDemo()` を呼ぶ（`src/devProbe.tsx`）。
 *
 * ストアの fs / scm の要求を差し替え、スペース「para-code」に架空のファイルと変更とメモを出す。データはすべて架空。
 * `fileAt`・`wordDiff`・アイコンのテーマは汎用の要求（`sendPcRequest`）で送るので差し替えられない。見本ではそれらの
 * capability を広告せず、古い PC と同じ見え方（作業ツリーの中身の表示・lucide のアイコン）になる。
 */

interface DemoFile {
	readonly content: string;
}

const FILES: Readonly<Record<string, DemoFile>> = {
	'README.md': { content: '# para-code\n\nスペースとワークツリーの見本です。\n\n- 認証フロー\n- リレーの再接続\n- 差分の配色\n' },
	'package.json': { content: '{\n  "name": "para-code",\n  "version": "1.0.0"\n}\n' },
	'.env': { content: 'TOKEN=demo\n' },
	'src/app/main.ts': { content: 'export function main(): void {\n\tconsole.log("hello");\n\tstart();\n}\n' },
	'src/app/new.ts': { content: 'export const added = true;\n' },
	'src/app/view.tsx': { content: 'export function View() {\n\treturn null;\n}\n' },
	'src/old/keep.ts': { content: 'export const keep = 1;\n' },
	'src/conflict.ts': { content: '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> feat\n' },
	'docs/guide.md': { content: '# ガイド\n\nまだ追跡していない文書です。\n' },
	'node_modules/lodash/index.js': { content: 'module.exports = {};\n' },
	'assets/logo.svg': { content: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#a78bfa"/></svg>' },
};

const IGNORED = new Set(['node_modules', '.env']);

const STATUS: ScmStatusResult = {
	branch: 'feat/auth',
	files: [
		{ x: ' ', y: 'M', path: 'src/app/main.ts', added: 1, removed: 0 },
		{ x: 'A', y: ' ', path: 'src/app/new.ts', stagedAdded: 1, stagedRemoved: 0 },
		{ x: ' ', y: 'D', path: 'src/old/gone.ts', added: 0, removed: 3 },
		{ x: 'U', y: 'U', path: 'src/conflict.ts' },
		{ x: '?', y: '?', path: 'docs/' },
		{ x: ' ', y: 'M', path: 'README.md', added: 1, removed: 1 },
	],
};

const DIFFS: Readonly<Record<string, string>> = {
	'src/app/main.ts': 'diff --git a/src/app/main.ts b/src/app/main.ts\n--- a/src/app/main.ts\n+++ b/src/app/main.ts\n@@ -1,3 +1,4 @@\n export function main(): void {\n \tconsole.log("hello");\n+\tstart();\n }\n',
	'README.md': 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -3,3 +3,3 @@\n スペースとワークツリーの見本です。\n \n-- 認証\n+- 認証フロー\n',
};

let note = '## 今日\n- [ ] 認証フローのテストを足す\n- [x] リレーの再接続を直す\n- [ ] 差分の配色をテーマに寄せる\n  色はトークンから取る\nふつうの行';
let noteVersion = 1;

function listOf(path: string): FsListResult {
	const prefix = path.length > 0 ? `${path}/` : '';
	const dirs = new Set<string>();
	const files: { name: string; dir: boolean; size?: number; ignored?: boolean }[] = [];
	for (const [file, data] of Object.entries(FILES)) {
		if (!file.startsWith(prefix)) {
			continue;
		}
		const rest = file.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash >= 0) {
			dirs.add(rest.slice(0, slash));
		} else {
			files.push({ name: rest, dir: false, size: data.content.length, ...(path.length === 0 && IGNORED.has(rest) ? { ignored: true } : {}) });
		}
	}
	const folders = [...dirs].sort().map(name => ({ name, dir: true, ...(path.length === 0 && IGNORED.has(name) ? { ignored: true } : {}) }));
	return { entries: [...folders, ...files.sort((a, b) => a.name.localeCompare(b.name))] };
}

/** ファイル・メモ・差分の見本を入れる（開発ビルドだけ）。 */
export function installFilesDemo(): void {
	if (!__DEV__) {
		return;
	}
	const workspace = useAppStore.getState().workspace;
	if (workspace === undefined) {
		console.warn('[para-dev] call __paraDev.demo() first');
		return;
	}
	const delay = <T>(value: T, ms = 120) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
	useAppStore.setState({
		workspace: { ...workspace, capabilities: [...(workspace.capabilities ?? []), PcCapability.NoteCas, PcCapability.FsIgnored, PcCapability.NoteTaskOps] },
		fsList: async (_ws: string, path: string) => delay(listOf(path)),
		scmStatus: async () => delay(STATUS),
		scmDiff: async (_ws: string, path?: string) => delay({ diff: path !== undefined ? DIFFS[path] ?? '' : '' }),
		fsRead: async (_ws: string, path: string): Promise<FsReadResult> => delay({ content: FILES[path]?.content ?? '', truncated: false, size: FILES[path]?.content.length ?? 0 }),
		noteGet: async (ws: string): Promise<SpaceNoteResult> => delay({ ws, text: note, updatedAt: noteVersion }),
		// アプリは op を送るときも、当てた後の全文を `text` に入れて送る（古い PC 向け）ので、見本はそれをそのまま使う
		noteSet: async (ws: string, text: string, _options?: SpaceNoteSetOptions): Promise<SpaceNoteResult> => {
			note = text;
			noteVersion++;
			return delay({ ws, text: note, updatedAt: noteVersion });
		},
	});
}
