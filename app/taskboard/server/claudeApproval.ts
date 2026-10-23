// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PARADIS_TASK_BOARD_SCREENSHOT_TOOLS } from '../../../src/vs/paradis/contrib/taskBoard/common/paradisTaskBoardToolApprovals.js';
import { CODEX_BOARD_TOOLS } from './codexApproval.js';

/*
 * Claude Code も、既定の許可のモードでは MCP のツールを初めて使うたびに許可を求める（permissions.allow に
 * 当てはまる規則があれば聞かない）。Codex と同じツール（ボードへの報告と、スクショの工程の読むだけ・撮るだけの
 * ツール）を、ユーザーが画面で頼んだときにユーザーの設定 `<CLAUDE_CONFIG_DIR か ~/.claude>/settings.json` の
 * `permissions.allow` へ `mcp__para-browser__<ツール>` として書き足す。
 *
 * 作業場所の `.claude/settings*.json` には書かない（クローンが dirty になり、返却後に貸し出せなくなる）。
 * settings.json は Para Code の hook の設置と同じく JSON として読み、読めない・形が違うときは書かずに断る。
 */

const SERVER = 'para-browser';
/** 帯で常に許可にするツールの全部。 */
export const CLAUDE_APPROVAL_TOOLS: readonly string[] = [...CODEX_BOARD_TOOLS, ...PARADIS_TASK_BOARD_SCREENSHOT_TOOLS];

export class ClaudeConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ClaudeConfigError';
	}
}

function ruleOf(tool: string): string {
	return `mcp__${SERVER}__${tool}`;
}

interface ISettingsShape {
	readonly settings: Record<string, unknown>;
	readonly allow: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 書いてよい形かを確かめる。空のファイルは `{}` と同じに扱う。迷う形なら ClaudeConfigError。 */
function inspect(text: string): ISettingsShape {
	let settings: unknown = {};
	if (text.trim().length > 0) {
		try {
			settings = JSON.parse(text);
		} catch {
			throw new ClaudeConfigError('settings.json を JSON として読めません（コメントや末尾のカンマなど）');
		}
	}
	if (!isRecord(settings)) {
		throw new ClaudeConfigError('settings.json の中身がオブジェクトではありません');
	}
	const permissions = settings.permissions;
	if (permissions !== undefined && !isRecord(permissions)) {
		throw new ClaudeConfigError('settings.json の permissions がオブジェクトではありません');
	}
	const allow = permissions?.allow;
	if (allow !== undefined && !Array.isArray(allow)) {
		throw new ClaudeConfigError('settings.json の permissions.allow が配列ではありません');
	}
	return { settings, allow: allow ?? [] };
}

/** まだ許可されていない帯のツール。サーバー全体の規則（`mcp__para-browser`・`mcp__para-browser__*`）があれば全部済み。読めない形なら全部を返す。 */
export function missingClaudeApprovals(text: string): string[] {
	let shape: ISettingsShape;
	try {
		shape = inspect(text);
	} catch {
		return [...CLAUDE_APPROVAL_TOOLS];
	}
	const rules = new Set(shape.allow.filter((rule): rule is string => typeof rule === 'string').map(rule => rule.trim()));
	if (rules.has(`mcp__${SERVER}`) || rules.has(`mcp__${SERVER}__*`)) {
		return [];
	}
	return CLAUDE_APPROVAL_TOOLS.filter(tool => !rules.has(ruleOf(tool)));
}

/** 足りない規則を permissions.allow の末尾に足した本文。ほかの項目と並びはそのまま残す。読めない形なら ClaudeConfigError。 */
export function withClaudeApprovals(text: string): string {
	const shape = inspect(text);
	const missing = missingClaudeApprovals(text);
	if (missing.length === 0) {
		return text;
	}
	const permissions = isRecord(shape.settings.permissions) ? shape.settings.permissions : {};
	const next = { ...shape.settings, permissions: { ...permissions, allow: [...shape.allow, ...missing.map(ruleOf)] } };
	return `${JSON.stringify(next, undefined, 2)}\n`;
}

/** ボードが書き足せない形なら、その理由。書けるなら undefined。 */
export function claudeWriteRefusal(text: string): string | undefined {
	try {
		inspect(text);
		return undefined;
	} catch (err) {
		return err instanceof ClaudeConfigError ? err.message : String(err);
	}
}

/** `~` を展開した絶対パス。相対パスは使わない（Para Code の paradisClaudeConfigDir と同じく絶対パスだけを見る）。 */
function normalizeDir(raw: string | undefined, home: string): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return undefined;
	}
	const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(home, trimmed.slice(1)) : trimmed;
	return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
}

/**
 * 書き足す候補の settings.json。Para Code が hook を置くのと同じ設定フォルダ（$CLAUDE_CONFIG_DIR、~/.claude）のうち、
 * フォルダがあるもの（Claude Code を使ったことがある）。同じ実体は 1 つにまとめる。settings.json はまだ無くてもよい。
 */
export async function claudeSettingsCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<string[]> {
	const dirs = [normalizeDir(env.CLAUDE_CONFIG_DIR, home), path.join(home, '.claude')].filter((d): d is string => d !== undefined);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const dir of dirs) {
		const real = await fs.realpath(dir).catch(() => undefined);
		if (real === undefined || seen.has(real) || !(await fs.stat(real).then(st => st.isDirectory(), () => false))) {
			continue;
		}
		seen.add(real);
		out.push(path.join(dir, 'settings.json'));
	}
	return out;
}

export async function claudeApprovalState(file: string): Promise<{ readonly path: string; readonly missing: readonly string[]; readonly manual?: string }> {
	const text = await fs.readFile(file, 'utf8').catch(() => '');
	const missing = missingClaudeApprovals(text);
	// シンボリックリンク（dotfiles の管理など）は書かないので、はじめから手で足す案内にする
	const link = await fs.lstat(file).then(st => !st.isFile(), () => false);
	const manual = missing.length ? (link ? 'settings.json が通常のファイルではない（シンボリックリンクなど）ので、ボードは書きません' : claudeWriteRefusal(text)) : undefined;
	return manual === undefined ? { missing, path: file } : { missing, path: file, manual };
}

/** まだ許可されていない settings.json と、足りないツール。`manual` は書けない理由（手で足してもらう）。 */
export async function claudeApprovalStates(): Promise<{ readonly path: string; readonly missing: readonly string[]; readonly manual?: string }[]> {
	const states = await Promise.all((await claudeSettingsCandidates()).map(file => claudeApprovalState(file)));
	return states.filter(s => s.missing.length > 0);
}

/**
 * settings.json に書き足す。無ければ作る。通常のファイルだけを扱い（シンボリックリンク等は断る）、書く前に控えを取る。
 * 読んでから書くまでに他（Claude Code・Para Code）が書き換えていたら、上書きせずに断る。
 */
export async function addClaudeApprovals(file: string): Promise<void> {
	const stat = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => {
		if (err.code === 'ENOENT') {
			return undefined;
		}
		throw err;
	});
	if (stat && !stat.isFile()) {
		throw new ClaudeConfigError(`${file} は通常のファイルではない（シンボリックリンクなど）ので書きません。手で足してください`);
	}
	const text = stat ? await fs.readFile(file, 'utf8') : '';
	const next = withClaudeApprovals(text);
	if (next === text) {
		return;
	}
	if (stat) {
		await fs.copyFile(file, `${file}.taskboard.bak`);
	}
	const temp = `${file}.taskboard-${process.pid}-${randomBytes(4).toString('hex')}`;
	await fs.writeFile(temp, next, { mode: stat ? stat.mode & 0o777 : 0o600 });
	try {
		const now = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? '' : Promise.reject(err));
		if (now !== text) {
			throw new ClaudeConfigError('書き足す間に Claude Code の設定が変わりました。もう一度押してください');
		}
		await fs.rename(temp, file);
	} finally {
		await fs.rm(temp, { force: true });
	}
}
