/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントを起動したときの控えの台帳（会話のあるマシンの `~/.para-code/agent-launch-profiles.json`）と、
// ペインで動いているエージェントのプロセスの環境の読み取り。許可リストと値の検証は common/paradisAgentLaunchProfile.ts。

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { Queue } from '../../../../base/common/async.js';
import { basename, join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisAgentLaunchLedgerEntry,
	IParadisAgentLaunchProfile,
	ParadisLaunchAgent,
	paradisAgentLaunchFromCommandLine,
	paradisAgentLaunchLedgerKey,
	paradisAgentLaunchRecordMode,
	paradisIsAllowedLaunchEnvName,
	paradisIsEmptyLaunchProfile,
	paradisIsLaunchAgent,
	paradisMergeAgentLaunchProfile,
	paradisPruneAgentLaunchLedger,
	paradisSanitizeAgentLaunchProfile,
} from '../common/paradisAgentLaunchProfile.js';
import { ParadisAgentSessionStartSource } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { PARADIS_RESUME_SESSION_ID_PATTERN } from '../common/paradisSessionResume.js';

export const PARADIS_AGENT_LAUNCH_LEDGER_FILE = 'agent-launch-profiles.json';

/** 台帳のファイルの大きさの上限（壊れた・書き換えられたファイルを読み込まない）。 */
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
/** `ps` の出力の上限と待ち時間。 */
const PS_MAX_BUFFER = 8 * 1024 * 1024;
const PS_TIMEOUT_MS = 3_000;
/** 受け取るコマンド行の長さの上限。 */
const MAX_COMMAND_LINE_LENGTH = 32_768;

/** ペインでの起動（renderer が、会話 ID が分かったときに知らせる）。 */
export interface IParadisAgentLaunchRecordRequest {
	readonly agent: ParadisLaunchAgent;
	readonly sessionId: string;
	/** シェル統合が報告した、ペインで実行中のコマンド行。 */
	readonly commandLine: string;
	/** ペインのシェルの pid（このマシンの上のもの）。子のエージェントのプロセスの環境を読む。分からなければ省く。 */
	readonly shellPid?: number;
	/** その会話の最初の SessionStart の `source`。無ければ、前からある会話として扱う（権限を広げるものを控えない）。 */
	readonly startSource?: ParadisAgentSessionStartSource;
}

function runPs(args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('ps', [...args], { maxBuffer: PS_MAX_BUFFER, timeout: PS_TIMEOUT_MS, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
}

/** `ps` の 1 行（`<pid> <ppid> <コマンド行>`）。 */
interface IProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly command: string;
}

export function paradisParseProcessRows(output: string): IProcessRow[] {
	const rows: IProcessRow[] = [];
	for (const line of output.split('\n')) {
		const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<command>.*)$/.exec(line)?.groups;
		if (match !== undefined) {
			rows.push({ pid: Number(match.pid), ppid: Number(match.ppid), command: match.command });
		}
	}
	return rows;
}

/** そのコマンド行が、エージェントの CLI のプロセスか（`claude ...`、`/path/codex ...`、`node /path/claude.js ...`）。 */
function isAgentProcess(command: string, agent: ParadisLaunchAgent): boolean {
	const words = command.split(/\s+/, 3);
	const name = (word: string | undefined) => basename(word ?? '').replace(/\.(?:js|mjs|cjs)$/, '');
	return name(words[0]) === agent || (/^(?:node|bun)$/.test(name(words[0])) && name(words[1]) === agent);
}

/**
 * シェルの子孫のうち、シェルにいちばん近いエージェントのプロセスの pid。エージェントが自分で起こした子
 * （サブエージェントや `claude -p`）は、それより深いので選ばない。無ければ undefined。
 */
export function paradisFindAgentProcess(rows: readonly IProcessRow[], shellPid: number, agent: ParadisLaunchAgent): number | undefined {
	const children = new Map<number, IProcessRow[]>();
	for (const row of rows) {
		const list = children.get(row.ppid);
		if (list === undefined) { children.set(row.ppid, [row]); } else { list.push(row); }
	}
	let level = children.get(shellPid) ?? [];
	const seen = new Set<number>([shellPid]);
	while (level.length > 0) {
		// 同じ深さに複数あれば、新しいもの（pid の大きいもの）
		const found = level.filter(row => isAgentProcess(row.command, agent)).sort((a, b) => b.pid - a.pid)[0];
		if (found !== undefined) {
			return found.pid;
		}
		const next: IProcessRow[] = [];
		for (const row of level) {
			if (!seen.has(row.pid)) {
				seen.add(row.pid);
				next.push(...children.get(row.pid) ?? []);
			}
		}
		level = next;
	}
	return undefined;
}

/**
 * macOS の `ps eww -o args=` の出力（引数の後ろに、起動時の環境が空白でつながる）から、環境の部分の語を取り出す。
 * 引数だけの出力（`ps -ww -o args=`）と同じ前の部分を外す: 依頼文の中の `名前=値` を環境と読まないため。
 * 前の部分が一致しなければ読まない。
 */
export function paradisProcessEnvironmentWords(argsOutput: string, argsAndEnvironmentOutput: string): string[] {
	const args = argsOutput.replace(/\n+$/, '');
	const all = argsAndEnvironmentOutput.replace(/\n+$/, '');
	if (args.length === 0 || !all.startsWith(args)) {
		return [];
	}
	return all.slice(args.length).split(/\s+/).filter(word => word.length > 0);
}

/** 環境の語（`名前=値`）から、許可リストの環境変数だけを残す。値の文字種は {@link paradisSanitizeAgentLaunchProfile} が確かめる。 */
export function paradisAllowedEnvironment(agent: ParadisLaunchAgent, words: Iterable<string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const word of words) {
		const equals = word.indexOf('=');
		if (equals > 0 && paradisIsAllowedLaunchEnvName(agent, word.slice(0, equals))) {
			env[word.slice(0, equals)] = word.slice(equals + 1);
		}
	}
	return env;
}

/**
 * ペインのシェルの子のエージェントのプロセスが、起動されたときの環境から、許可リストの環境変数を読む
 * （`export` した値はコマンド行に現れないため）。
 *
 * - Linux: `/proc/<pid>/environ`
 * - macOS: `ps eww`（自分のユーザーのプロセスは読める。OS 付属のバイナリは読めないが、エージェントの CLI は違う）
 * - Windows: ほかのプロセスの環境を読む手段が OS の標準のコマンドに無いので読まない
 *
 * 読めなければ空。ほかの環境変数（鍵など）は、ここで捨てて外へ出さない。
 */
export async function paradisReadAgentProcessEnvironment(shellPid: number, agent: ParadisLaunchAgent, platform: NodeJS.Platform = process.platform): Promise<Record<string, string>> {
	if (platform !== 'linux' && platform !== 'darwin') {
		return {};
	}
	const pid = paradisFindAgentProcess(paradisParseProcessRows(await runPs(['-axww', '-o', 'pid=,ppid=,args='])), shellPid, agent);
	if (pid === undefined) {
		return {};
	}
	if (platform === 'linux') {
		return paradisAllowedEnvironment(agent, (await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0'));
	}
	const [args, all] = await Promise.all([runPs(['-ww', '-o', 'args=', '-p', String(pid)]), runPs(['eww', '-o', 'args=', '-p', String(pid)])]);
	return paradisAllowedEnvironment(agent, paradisProcessEnvironmentWords(args, all));
}

/** 会話ごとの起動の控えの台帳。1 つのファイルに持ち、書くたびに古いものを捨てる。 */
export class ParadisAgentLaunchLedger {
	private readonly queue = new Queue<void>();

	constructor(
		private readonly directory: string,
		private readonly logService: ILogService,
		private readonly readProcessEnvironment: (shellPid: number, agent: ParadisLaunchAgent) => Promise<Record<string, string>> = paradisReadAgentProcessEnvironment,
		private readonly now: () => number = Date.now,
	) { }

	private get file(): string {
		return join(this.directory, PARADIS_AGENT_LAUNCH_LEDGER_FILE);
	}

	/** 台帳を読む。無い・壊れている・大きすぎるときは空。中身は読むたびに許可リストで絞り直す。 */
	private async read(): Promise<Record<string, IParadisAgentLaunchLedgerEntry>> {
		const entries: Record<string, IParadisAgentLaunchLedgerEntry> = {};
		try {
			const stat = await fs.lstat(this.file);
			if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) {
				return entries;
			}
			const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as { readonly entries?: unknown };
			if (typeof parsed?.entries !== 'object' || parsed.entries === null) {
				return entries;
			}
			for (const [key, value] of Object.entries(parsed.entries as Record<string, { readonly at?: unknown } | null>)) {
				const separator = key.indexOf(':');
				const agent = key.slice(0, separator);
				const at = value?.at;
				if (separator > 0 && paradisIsLaunchAgent(agent) && PARADIS_RESUME_SESSION_ID_PATTERN.test(key.slice(separator + 1)) && typeof at === 'number' && Number.isFinite(at)) {
					const profile = paradisSanitizeAgentLaunchProfile(agent, value);
					if (!paradisIsEmptyLaunchProfile(profile)) {
						entries[key] = { ...profile, at };
					}
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.logService.debug('[ParadisAgentLaunchLedger] unable to read the ledger', error);
			}
		}
		return entries;
	}

	/** 別名で書いてから名前を替える（書きかけを読ませない）。利用者だけが読み書きできるようにする。 */
	private async write(entries: Record<string, IParadisAgentLaunchLedgerEntry>): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		await fs.writeFile(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
		await fs.rename(temporary, this.file);
	}

	/**
	 * ペインでの起動を控える。コマンド行のフラグと先頭の `名前=値`、プロセスの環境（読めるとき）を合わせ、
	 * 許可リストで絞って台帳に入れる。控えのある会話は変えない。控えの無い会話は、その起動が作った会話と示せるときだけ
	 * 権限を広げるものまで控える（{@link paradisAgentLaunchRecordMode}・{@link paradisMergeAgentLaunchProfile}）。
	 */
	record(request: IParadisAgentLaunchRecordRequest): Promise<void> {
		return this.queue.queue(async () => {
			if (!paradisIsLaunchAgent(request.agent) || typeof request.sessionId !== 'string' || !PARADIS_RESUME_SESSION_ID_PATTERN.test(request.sessionId)
				|| typeof request.commandLine !== 'string' || request.commandLine.length > MAX_COMMAND_LINE_LENGTH) {
				return;
			}
			const launch = paradisAgentLaunchFromCommandLine(request.commandLine);
			if (launch === undefined || launch.agent !== request.agent) {
				return;
			}
			// コマンド行はペインのプロセスの起動で、届いた会話がその起動で作られたとは限らない（CLI の中の `/resume`、分岐の
			// 直後に届く元の会話の ID）。作った会話と示せないときは、前からある会話として扱うか、控えない
			const mode = paradisAgentLaunchRecordMode(request.commandLine, request.sessionId, typeof request.startSource === 'string' ? request.startSource : undefined);
			if (mode === undefined) {
				return;
			}
			const key = paradisAgentLaunchLedgerKey(request.agent, request.sessionId);
			// 控えのある会話は変えないので、プロセスの環境を読みに行かない
			if ((await this.read())[key] !== undefined) {
				return;
			}
			let processEnvironment: Record<string, string> = {};
			if (typeof request.shellPid === 'number' && Number.isSafeInteger(request.shellPid) && request.shellPid > 1) {
				try {
					processEnvironment = await this.readProcessEnvironment(request.shellPid, request.agent);
				} catch (error) {
					this.logService.debug('[ParadisAgentLaunchLedger] unable to read the environment of the agent process', error);
				}
			}
			const captured = paradisSanitizeAgentLaunchProfile(request.agent, { env: { ...launch.profile.env, ...processEnvironment }, flags: launch.profile.flags });
			const entries = await this.read();
			const merged = paradisMergeAgentLaunchProfile(entries[key], captured, mode);
			if (merged === entries[key] || paradisIsEmptyLaunchProfile(merged)) {
				return;
			}
			entries[key] = { ...merged, at: this.now() };
			try {
				await this.write(paradisPruneAgentLaunchLedger(entries, this.now()));
			} catch (error) {
				this.logService.warn('[ParadisAgentLaunchLedger] unable to write the ledger', error);
			}
		});
	}

	/** 会話の控え。無ければ undefined。 */
	async profile(agent: unknown, sessionId: unknown): Promise<IParadisAgentLaunchProfile | undefined> {
		if (!paradisIsLaunchAgent(agent) || typeof sessionId !== 'string' || !PARADIS_RESUME_SESSION_ID_PATTERN.test(sessionId)) {
			return undefined;
		}
		const entry = (await this.read())[paradisAgentLaunchLedgerKey(agent, sessionId)];
		return entry === undefined ? undefined : { env: entry.env, flags: entry.flags };
	}
}
