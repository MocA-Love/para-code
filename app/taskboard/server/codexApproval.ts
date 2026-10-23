// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findTomlAssignment, type MultilineDelimiter, parseTomlKeyPath, scanTomlLine } from '../../../src/vs/paradis/contrib/agentBrowser/common/paradisTomlScan.js';
import { PARADIS_TASK_BOARD_SCREENSHOT_TOOLS } from '../../../src/vs/paradis/contrib/taskBoard/common/paradisTaskBoardToolApprovals.js';
import { paraCodeDataDirectories } from './paraCode.js';

/*
 * Codex は MCP のツールを使うたびに許可のメニューを出す。ボードへの報告のツール 2 つと、スクショの工程が使う
 * 読むだけ・撮るだけのツール（PARADIS_TASK_BOARD_SCREENSHOT_TOOLS）だけは、ユーザーが画面で頼んだときに
 * Codex の設定へ「常に許可」を書き足す（メニューの Always allow と同じ形）。
 *
 *   [mcp_servers.para-browser.tools.board_complete_step]
 *   approval_mode = "approve"
 *
 * 設定はユーザーの物で、壊すと Codex がどのペインでも起動しなくなる。行の読み方（コメント・引用符・複数行の
 * 文字列）は Para Code 本体と同じ paradisTomlScan.ts を使う。読み方に迷う書き方（ドット付きのキー、インライン
 * テーブル、approval_mode を複数行の文字列やドット付きで書いたもの、para-browser の定義が無い等）を見つけたら
 * 何も書かずに断り、手で足してもらう。
 */

export const CODEX_BOARD_TOOLS = ['board_complete_step', 'board_ask_human'] as const;
/** 帯で常に許可にするツールの全部（ボードへの報告と、スクショの工程の読むだけ・撮るだけのツール）。 */
export const CODEX_APPROVAL_TOOLS: readonly string[] = [...CODEX_BOARD_TOOLS, ...PARADIS_TASK_BOARD_SCREENSHOT_TOOLS];
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
	/** 行の頭が複数行の文字列の中（見出しやキーとして読まない）。 */
	readonly inString: boolean;
	/** コメントと複数行の文字列を除いた、キーと値の部分（前後の空白は除く）。 */
	readonly code: string;
}

/** 行ごとに、Para Code 本体と同じ読み方（paradisTomlScan.ts）でキーと値の部分を取り出す。 */
function scan(text: string): IScannedLine[] {
	let multiline: MultilineDelimiter | undefined;
	return text.split('\n').map(line => {
		const inString = multiline !== undefined;
		const scanned = scanTomlLine(line.replace(/\r$/, ''), multiline);
		multiline = scanned.multiline;
		return { text: line, inString, code: scanned.code.trim() };
	});
}

function isHeader(line: IScannedLine): boolean {
	return !line.inString && line.code.startsWith('[');
}

/** `[a."b".c]  # comment` のキーの並び。配列の表（`[[...]]`）と読めない見出しは undefined。 */
function headerPath(line: IScannedLine): readonly string[] | undefined {
	const code = line.code;
	if (!isHeader(line) || code.startsWith('[[') || !code.endsWith(']')) {
		return undefined;
	}
	return parseTomlKeyPath(code.slice(1, -1));
}

/** `key = value` の行のキーの並び（引用符付きのキーも読む）と値。代入でない行は undefined。 */
function assignmentOf(line: IScannedLine): { readonly key: readonly string[]; readonly value: string } | undefined {
	if (line.inString) {
		return undefined;
	}
	const at = findTomlAssignment(line.code);
	const key = at > 0 ? parseTomlKeyPath(line.code.slice(0, at)) : undefined;
	return key ? { key, value: line.code.slice(at + 1).trim() } : undefined;
}

/** その行が approval_mode を書いているか（引用符付きのキー `"approval_mode"` も同じに見る）。 */
function isApprovalMode(line: IScannedLine): boolean {
	return assignmentOf(line)?.key[0] === 'approval_mode';
}

function samePath(a: readonly string[] | undefined, b: readonly string[]): boolean {
	return a !== undefined && a.length === b.length && a.every((part, i) => part === b[i]);
}

interface IConfigShape {
	readonly lines: IScannedLine[];
	readonly toolTables: ReadonlyMap<string, { start: number; end: number }>;
}

/** 書いてよい形かを確かめる。迷う書き方なら CodexConfigError。 */
function inspect(text: string): IConfigShape {
	const lines = scan(text);
	const server = ['mcp_servers', SERVER];
	let serverHeaders = 0;
	let inServer = false;
	const toolTables = new Map<string, { start: number; end: number }>();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.inString && line.code.length === 0) {
			continue;
		}
		if (isHeader(line)) {
			const name = headerPath(line);
			if (name === undefined && line.text.includes(SERVER)) {
				throw new CodexConfigError(`${SERVER} の見出しの書き方を読めません（${line.text.trim()}）`);
			}
			if (samePath(name, [...server, 'tools'])) {
				throw new CodexConfigError(`[mcp_servers.${SERVER}.tools] の中に書かれたツールの設定は読み方に迷うので、手で足してください`);
			}
			inServer = samePath(name, server);
			if (inServer) {
				serverHeaders++;
			}
			const tool = name && name.length === 4 && samePath(name.slice(0, 3), [...server, 'tools']) ? name[3] : undefined;
			if (tool !== undefined) {
				let end = i + 1;
				while (end < lines.length && !isHeader(lines[end])) {
					end++;
				}
				toolTables.set(tool, { start: i, end });
				for (let j = i + 1; j < end; j++) {
					const assignment = assignmentOf(lines[j]);
					if (assignment?.key[0] !== 'approval_mode') {
						continue;
					}
					// 差し替えると壊れる書き方（ドット付き・複数行の文字列）は断る
					if (assignment.key.length !== 1 || (j + 1 < lines.length && lines[j + 1].inString)) {
						throw new CodexConfigError(`${tool} の approval_mode の書き方を読めません（${lines[j].text.trim()}）`);
					}
				}
			}
			continue;
		}
		const assignment = findTomlAssignment(line.code);
		const key = assignment > 0 ? parseTomlKeyPath(line.code.slice(0, assignment)) : undefined;
		// 見出し以外の行で para-browser の設定を書いている（ドット付きのキー・インラインテーブル）
		if (key?.[0] === 'mcp_servers' && (key.includes(SERVER) || line.code.slice(assignment).includes(SERVER))) {
			throw new CodexConfigError(`${SERVER} がドット付きのキーかインラインテーブルで書かれています（${line.text.trim()}）`);
		}
		if (inServer && key?.[0] === 'tools') {
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

/** 常に許可になっている行か（`approval_mode = "approve"`。キーと値の引用符の種類は問わない）。 */
function isApproveLine(line: IScannedLine): boolean {
	const assignment = assignmentOf(line);
	return assignment !== undefined && assignment.key.length === 1 && assignment.key[0] === 'approval_mode'
		&& (assignment.value === '"approve"' || assignment.value === "'approve'");
}

/** まだ常に許可になっていない帯のツール。読めない書き方なら全部を返す（帯を出し続け、押したら理由を出す）。 */
export function missingCodexApprovals(text: string): string[] {
	let shape: IConfigShape;
	try {
		shape = inspect(text);
	} catch {
		return [...CODEX_APPROVAL_TOOLS];
	}
	return CODEX_APPROVAL_TOOLS.filter(tool => {
		const range = shape.toolTables.get(tool);
		return !range || !shape.lines.slice(range.start + 1, range.end).some(isApproveLine);
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
		const body = shape.lines.slice(range.start + 1, range.end).filter(l => !isApprovalMode(l)).map(l => l.text);
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

/** `~` を展開した絶対パス。相対パスは使わない（Para Code の paradisNormalizeCodexHomePath と同じ）。 */
function normalizeHome(raw: unknown, home: string): string | undefined {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		return undefined;
	}
	const trimmed = raw.trim();
	const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(home, trimmed.slice(1)) : trimmed;
	return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
}

/** Para Code の設定 `paradis.limitsMonitor.codexHomes` で足したホーム（読めなければ空）。 */
export function codexHomesFromSettings(text: string): unknown[] {
	const match = /"paradis\.limitsMonitor\.codexHomes"\s*:\s*(\[[^\]]*\])/.exec(text);
	if (!match) {
		return [];
	}
	try {
		// 配列の中のコメントと末尾のカンマを外す（設定は JSONC）
		const parsed: unknown = JSON.parse(match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*\]$/, ']'));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * 書き足す候補の設定ファイル。Para Code はペインごとに Codex のアカウント（CODEX_HOME）を変えられるので、
 * Para Code が para-browser を入れるホームと同じものを見る: $CODEX_HOME、~/.codex、使用量パネルが作る
 * ~/.codex-<数字>（~/.codex-backup のように手で作ったものは含めない）、設定 `paradis.limitsMonitor.codexHomes`。
 * そのうち para-browser を登録しているものだけを返す。同じ実体（シンボリックリンク）は 1 つにまとめる。
 */
export async function codexConfigCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), configured?: readonly unknown[]): Promise<string[]> {
	const dirs: string[] = [];
	const fromEnv = normalizeHome(env.CODEX_HOME, home);
	if (fromEnv) {
		dirs.push(fromEnv);
	}
	dirs.push(path.join(home, '.codex'));
	const entries = (await fs.readdir(home, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	for (const entry of entries) {
		if (/^\.codex-\d+$/.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
			dirs.push(path.join(home, entry.name));
		}
	}
	for (const raw of configured ?? await settingsCodexHomes()) {
		const dir = normalizeHome(raw, home);
		if (dir) {
			dirs.push(dir);
		}
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const dir of dirs) {
		const real = await fs.realpath(dir).catch(() => undefined);
		if (real === undefined || seen.has(real) || !(await fs.stat(real).then(st => st.isDirectory(), () => false))) {
			continue;
		}
		seen.add(real);
		const file = path.join(dir, 'config.toml');
		const text = await fs.readFile(file, 'utf8').catch(() => undefined);
		if (text !== undefined && text.split('\n').some(l => /^\s*\[\s*mcp_servers\.(para-browser|"para-browser")[\].]/.test(l))) {
			out.push(file);
		}
	}
	return out;
}

async function settingsCodexHomes(): Promise<unknown[]> {
	for (const dir of paraCodeDataDirectories()) {
		const text = await fs.readFile(path.join(dir, 'User', 'settings.json'), 'utf8').catch(() => undefined);
		if (text !== undefined) {
			return codexHomesFromSettings(text);
		}
	}
	return [];
}

/** まだ常に許可になっていない設定ファイルと、足りないツール。`manual` は書けない理由（手で足してもらう）。 */
export async function codexApprovalStates(): Promise<{ readonly path: string; readonly missing: readonly string[]; readonly manual?: string }[]> {
	const states = await Promise.all((await codexConfigCandidates()).map(file => codexApprovalState(file)));
	return states.filter(s => s.missing.length > 0);
}

export async function codexApprovalState(file = codexConfigPath()): Promise<{ readonly missing: readonly string[]; readonly path: string; readonly manual?: string }> {
	const text = await fs.readFile(file, 'utf8').catch(() => '');
	const missing = missingCodexApprovals(text);
	const manual = missing.length ? codexWriteRefusal(text) : undefined;
	return manual === undefined ? { missing, path: file } : { missing, path: file, manual };
}

/** ボードが書き足せない書き方なら、その理由。書けるなら undefined。 */
export function codexWriteRefusal(text: string): string | undefined {
	try {
		inspect(text);
		return undefined;
	} catch (err) {
		return err instanceof CodexConfigError ? err.message : String(err);
	}
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
	const temp = `${file}.taskboard-${process.pid}-${randomBytes(4).toString('hex')}`;
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
