// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * Codex は MCP のツールを使うたびに許可のメニューを出す。ボードへの報告のツール 2 つだけは、
 * ユーザーが画面で頼んだときに Codex の設定へ「常に許可」を書き足す（メニューの Always allow と同じ形）。
 *
 *   [mcp_servers.para-browser.tools.board_complete_step]
 *   approval_mode = "approve"
 *
 * 設定はユーザーの物で、壊すと Codex がどのペインでも起動しなくなる。そのため、読み方に迷う書き方
 * （サーバー名の引用符、ドット付きのキー、インラインテーブル、para-browser の定義が無い等）を見つけたら
 * 何も書かずに断り、手で足してもらう。
 */

export const CODEX_BOARD_TOOLS = ['board_complete_step', 'board_ask_human'] as const;
const SERVER = 'para-browser';

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}

export class CodexConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CodexConfigError';
	}
}

interface IScannedLine {
	readonly text: string;
	/** 複数行の文字列の中の行（見出しやキーとして読まない）。 */
	readonly inString: boolean;
}

/** 行ごとに、複数行の文字列（""" / '''）の中かどうかを付ける。 */
function scan(text: string): IScannedLine[] {
	let open: '"""' | "'''" | undefined;
	return text.split('\n').map(line => {
		const inString = open !== undefined;
		let rest = line;
		for (; ;) {
			if (open) {
				const at = rest.indexOf(open);
				if (at < 0) {
					break;
				}
				rest = rest.slice(at + 3);
				open = undefined;
				continue;
			}
			const code = rest.replace(/#.*$/, '');
			const dq = code.indexOf('"""');
			const sq = code.indexOf("'''");
			const at = dq < 0 ? sq : sq < 0 ? dq : Math.min(dq, sq);
			if (at < 0) {
				break;
			}
			open = rest.startsWith('"""', at) ? '"""' : "'''";
			rest = rest.slice(at + 3);
		}
		return { text: line, inString };
	});
}

function isHeader(line: IScannedLine): boolean {
	return !line.inString && /^\s*\[/.test(line.text);
}

/** `[a.b.c]  # comment` の a.b.c。引用符を含む見出しは undefined（読み方に迷うので扱わない）。 */
function headerName(line: IScannedLine): string | undefined {
	const m = !line.inString ? /^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(#.*)?$/.exec(line.text) : null;
	return m?.[1];
}

interface IConfigShape {
	readonly lines: IScannedLine[];
	readonly toolTables: ReadonlyMap<string, { start: number; end: number }>;
}

/** 書いてよい形かを確かめる。迷う書き方なら CodexConfigError。 */
function inspect(text: string): IConfigShape {
	const lines = scan(text);
	let serverHeaders = 0;
	let inServer = false;
	const toolTables = new Map<string, { start: number; end: number }>();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.inString) {
			continue;
		}
		if (isHeader(line)) {
			const name = headerName(line);
			if (name === undefined && line.text.includes(SERVER)) {
				throw new CodexConfigError(`${SERVER} の見出しの書き方を読めません（${line.text.trim()}）`);
			}
			if (name === `mcp_servers.${SERVER}.tools`) {
				throw new CodexConfigError(`[mcp_servers.${SERVER}.tools] の中に書かれたツールの設定は読み方に迷うので、手で足してください`);
			}
			inServer = name === `mcp_servers.${SERVER}`;
			if (inServer) {
				serverHeaders++;
			}
			const tool = name?.startsWith(`mcp_servers.${SERVER}.tools.`) ? name.slice(`mcp_servers.${SERVER}.tools.`.length) : undefined;
			if (tool !== undefined) {
				let end = i + 1;
				while (end < lines.length && !isHeader(lines[end])) {
					end++;
				}
				toolTables.set(tool, { start: i, end });
			}
			continue;
		}
		// 見出し以外の行で para-browser の設定を書いている（ドット付きのキー・インラインテーブル）
		if (/^\s*mcp_servers\s*[.=]/.test(line.text) && line.text.includes(SERVER)) {
			throw new CodexConfigError(`${SERVER} がドット付きのキーかインラインテーブルで書かれています（${line.text.trim()}）`);
		}
		if (inServer && /^\s*tools\s*[.=]/.test(line.text)) {
			throw new CodexConfigError(`${SERVER} の tools がドット付きのキーかインラインテーブルで書かれています（${line.text.trim()}）`);
		}
	}
	if (serverHeaders !== 1) {
		throw new CodexConfigError(serverHeaders === 0
			? `Codex の設定に [mcp_servers.${SERVER}] がありません。Para Code の para-browser を Codex に登録してから足してください`
			: `[mcp_servers.${SERVER}] が ${serverHeaders} か所にあります`);
	}
	return { lines, toolTables };
}

const APPROVE_LINE = /^\s*approval_mode\s*=\s*"approve"\s*(#.*)?$/;

/** まだ常に許可になっていないボードのツール。読めない書き方なら全部を返す（帯を出し続け、押したら理由を出す）。 */
export function missingCodexApprovals(text: string): string[] {
	let shape: IConfigShape;
	try {
		shape = inspect(text);
	} catch {
		return [...CODEX_BOARD_TOOLS];
	}
	return CODEX_BOARD_TOOLS.filter(tool => {
		const range = shape.toolTables.get(tool);
		return !range || !shape.lines.slice(range.start + 1, range.end).some(l => !l.inString && APPROVE_LINE.test(l.text));
	});
}

/** 足りない分を書き足した設定の本文。既にある節は approval_mode の行だけを差し替える。読めない書き方なら CodexConfigError。 */
export function withCodexApprovals(text: string): string {
	const shape = inspect(text);
	const out = shape.lines.map(l => l.text);
	const missing = missingCodexApprovals(text);
	// 後ろの節から差し替える（前の行番号がずれないように）
	const existing = missing.filter(t => shape.toolTables.has(t)).sort((a, b) => shape.toolTables.get(b)!.start - shape.toolTables.get(a)!.start);
	for (const tool of existing) {
		const range = shape.toolTables.get(tool)!;
		const body = shape.lines.slice(range.start + 1, range.end).filter(l => l.inString || !/^\s*approval_mode\s*=/.test(l.text)).map(l => l.text);
		out.splice(range.start + 1, range.end - range.start - 1, 'approval_mode = "approve"', ...body);
	}
	for (const tool of missing.filter(t => !shape.toolTables.has(t))) {
		while (out.length && out[out.length - 1].trim() === '') {
			out.pop();
		}
		out.push('', `[mcp_servers.${SERVER}.tools.${tool}]`, 'approval_mode = "approve"');
	}
	return `${out.join('\n').replace(/\n*$/, '')}\n`;
}

export async function codexApprovalState(file = codexConfigPath()): Promise<{ readonly missing: readonly string[]; readonly path: string }> {
	const text = await fs.readFile(file, 'utf8').catch(() => '');
	return { missing: missingCodexApprovals(text), path: file };
}

/**
 * 設定に書き足す。通常のファイルだけを扱い（シンボリックリンク等は断る）、書く前に控えを取る。
 * 読んでから書くまでに他（Codex・Para Code）が書き換えていたら、上書きせずに断る。
 */
export async function addCodexApprovals(file = codexConfigPath()): Promise<void> {
	const stat = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => {
		if (err.code === 'ENOENT') {
			return undefined;
		}
		throw err;
	});
	if (!stat) {
		throw new CodexConfigError(`${file} がありません。Para Code の para-browser を Codex に登録してから足してください`);
	}
	if (!stat.isFile()) {
		throw new CodexConfigError(`${file} は通常のファイルではない（シンボリックリンクなど）ので書きません。手で足してください`);
	}
	const text = await fs.readFile(file, 'utf8');
	const next = withCodexApprovals(text);
	if (next === text) {
		return;
	}
	await fs.copyFile(file, `${file}.taskboard.bak`);
	const temp = `${file}.taskboard-${process.pid}`;
	await fs.writeFile(temp, next, { mode: stat.mode & 0o777 });
	try {
		if (await fs.readFile(file, 'utf8') !== text) {
			throw new CodexConfigError('書き足す間に Codex の設定が変わりました。もう一度押してください');
		}
		await fs.rename(temp, file);
	} finally {
		await fs.rm(temp, { force: true });
	}
}
