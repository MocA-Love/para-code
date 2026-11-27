/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `para` コマンド（CLI）の中身。1 回の呼び出しが 1 つの短いプロセスで、ペインの環境変数（ペインのトークンと
// ポートファイルの場所）から Para Code の受け口を見つけ、JSON-RPC を送って結果を出す。
//
// コマンド・フラグ・--help は、本体が返す品書き（`para-cli/catalog`。MCP の tools/list と同じ元から作る。
// `../common/paradisCliCatalog.ts`）から作る。このファイルは道具の表を持たない。
//
// 単体で実行されるスクリプト（`paradisCli.ts`）から使うので、サービスや DI には依存しない。使うのは node の組み込みと、
// それだけで閉じている `vs/base/common/path.ts`、`paradisCliCatalog.ts` だけ。

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from '../../../../base/common/path.js';
import { IParadisCliCatalog, IParadisCliCallMeta, IParadisCliCommand, PARADIS_CLI_CATALOG_METHOD, PARADIS_CLI_CONVERSATION_MAX_LENGTH, PARADIS_CLI_META_KEY, PARADIS_CLI_PROTOCOL_VERSION, PARADIS_CLI_RESERVED_FLAGS } from '../common/paradisCliCatalog.js';

export const PARADIS_CLI_TOKEN_ENV = 'PARA_CODE_TERMINAL_PANE_ID';
export const PARADIS_CLI_PORT_FILE_ENV = 'PARA_CODE_MCP_PORT_FILE';
/** 受け口が戻らないとき・ペインがまだ知られていないときに、待って送り直す時間の合計（秒）。 */
export const PARADIS_CLI_WAIT_ENV = 'PARA_CLI_WAIT_SECONDS';
/** 既定の待ち。Claude Code のシェルの既定の制限（120 秒）より短くする。 */
export const PARADIS_CLI_DEFAULT_WAIT_SECONDS = 75;
/** ペインを知らない（404）と答えられたときに待つ上限（秒）。窓の再読み込みの直後は、少し待てば知られる。 */
const UNKNOWN_PANE_WAIT_SECONDS = 20;
/** 品書きを使い回す時間。 */
const CATALOG_CACHE_MS = 5 * 60 * 1000;
/** 接続先の受け口（`~/.para-code/gateway.json`）の版と、打ち切りの符丁（`../common/paradisAgentGateway.ts` と同じ値）。 */
const GATEWAY_FILE_NAME = 'gateway.json';
const GATEWAY_FILE_PROTOCOL_VERSION = 1;
const GATEWAY_TIMEOUT_CODE = 'para-code-window-not-connected';
/** 本体が、要求を処理した後の 404 に付ける印（`../common/paradisAgentGateway.ts` と同じ値）。 */
export const PARADIS_CLI_AFTER_DISPATCH_HEADER = 'x-para-code-after-dispatch';
/** 受け口へ、待たせる上限（秒）を伝えるヘッダー（`../common/paradisAgentGateway.ts` と同じ値）。 */
export const PARADIS_CLI_GATEWAY_WAIT_HEADER = 'x-para-code-gateway-wait-seconds';
/** Para Code の専用フォルダ（ホームからの相対）。`--out` に使える場所と、既定の画像の置き場所。 */
const PARA_CODE_FILES_FOLDER = ['.para-code', 'browser-files'];
/** エージェントがシェルへ渡す会話の ID（先に見つかったものを使う）。 */
const CONVERSATION_ENVS = ['PARA_CLI_CONVERSATION', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'];

export const enum ParadisCliExit {
	Ok = 0,
	/** 道具が問題を返した（本文を読む）。 */
	ToolError = 1,
	/** コマンドやフラグの誤り（`para help` を読む）。 */
	Usage = 2,
	/** Para Code に届かない。 */
	Unavailable = 3,
	/** サンドボックスが接続を止めた。 */
	Sandbox = 4,
}

/** 使い方の誤り。 */
export class ParadisCliUsageError extends Error { }

/** Para Code に届かなかった・届いたか分からない。 */
export class ParadisCliUnavailableError extends Error {
	constructor(message: string, readonly exitCode: ParadisCliExit = ParadisCliExit.Unavailable) {
		super(message);
	}
}

// ---- 受け口 --------------------------------------------------------------------------------------------------

export interface IParadisCliEndpoint {
	readonly port: number;
	/** 接続先（SSH）の番号の変わらない受け口。切れている間は応答を返さずに待たせ、打ち切りは 503 と符丁で返す。 */
	readonly gateway: boolean;
}

async function readPort(file: string, requireProtocol?: number): Promise<number | undefined> {
	try {
		const record = JSON.parse(await fs.readFile(file, 'utf8')) as { readonly port?: unknown; readonly protocolVersion?: unknown };
		if (requireProtocol !== undefined && record.protocolVersion !== requireProtocol) {
			return undefined;
		}
		return typeof record.port === 'number' && Number.isSafeInteger(record.port) && record.port > 0 && record.port <= 65_535 ? record.port : undefined;
	} catch {
		// 無い・書きかけ。呼ぶ側が待って読み直す
		return undefined;
	}
}

/**
 * 今つなぐ先の候補（先頭から試す）。試すたびに読み直す（Para Code の再起動で番号が変わる）。
 *
 * 接続先（SSH）のペインのポートファイルは `~/.para-code/` の中（`ports/<PC の印>.json` か直下）にあり、同じ
 * フォルダの `gateway.json` が受け口の番号を持つ。手元のペインのポートファイルはアプリのデータフォルダにあるので、
 * 同じ機械に接続先のサーバーが居て `~/.para-code/gateway.json` があっても、手元のペインは受け口を使わない。
 */
export async function paradisCliEndpoints(portFile: string | undefined): Promise<IParadisCliEndpoint[]> {
	if (portFile === undefined || portFile.length === 0) {
		return [];
	}
	const endpoints: IParadisCliEndpoint[] = [];
	const folder = dirname(portFile);
	const paraCodeFolder = basename(folder) === 'ports' ? dirname(folder) : folder;
	if (basename(paraCodeFolder) === '.para-code') {
		const gatewayPort = await readPort(join(paraCodeFolder, GATEWAY_FILE_NAME), GATEWAY_FILE_PROTOCOL_VERSION);
		if (gatewayPort !== undefined) {
			endpoints.push({ port: gatewayPort, gateway: true });
		}
	}
	const port = await readPort(portFile);
	if (port !== undefined) {
		endpoints.push({ port, gateway: false });
	}
	return endpoints;
}

/** 1 回の送信の結果。 */
export type ParadisCliAttempt =
	| { readonly kind: 'response'; readonly status: number; readonly text: string; /** 本体が要求を処理した後に断った（道具は走ったかもしれない）。 */ readonly afterDispatch?: boolean }
	/** つながる前に失敗した（何も送っていない）。 */
	| { readonly kind: 'not-sent'; readonly code: string }
	/** つながった後に切れた（届いたかは分からない）。 */
	| { readonly kind: 'broken'; readonly code: string };

export type ParadisCliPost = (endpoint: IParadisCliEndpoint, token: string, body: string, headers: Readonly<Record<string, string>>) => Promise<ParadisCliAttempt>;

/** 本物の送信（127.0.0.1 への HTTP の POST を 1 回）。 */
export const paradisCliHttpPost: ParadisCliPost = async (endpoint, token, body, headers) => {
	const { request } = await import('http');
	return new Promise<ParadisCliAttempt>(resolve => {
		let connected = false;
		const req = request({
			host: '127.0.0.1', port: endpoint.port, path: '/', method: 'POST', agent: false,
			headers: { 'content-type': 'application/json', 'accept': 'application/json', 'authorization': `Bearer ${token}`, 'content-length': Buffer.byteLength(body), ...headers },
		}, res => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => resolve({ kind: 'response', status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), ...(res.headers[PARADIS_CLI_AFTER_DISPATCH_HEADER] !== undefined ? { afterDispatch: true } : {}) }));
			res.on('error', (error: NodeJS.ErrnoException) => resolve({ kind: 'broken', code: error.code ?? 'ECONNRESET' }));
		});
		// つながった後の失敗は「届いたかもしれない」。操作を 2 回送らないために、つながる前の失敗と分ける
		req.on('socket', socket => socket.once('connect', () => { connected = true; }));
		req.on('error', (error: NodeJS.ErrnoException) => resolve(connected ? { kind: 'broken', code: error.code ?? 'ECONNRESET' } : { kind: 'not-sent', code: error.code ?? 'ECONNREFUSED' }));
		req.end(body);
	});
};

/** 送った結果をどう扱うか。 */
export type ParadisCliVerdict =
	| { readonly action: 'done' }
	/** 何も実行されていない。待って送り直す。`short` はペインを知らないと言われたとき（待ちの上限が短い）。 */
	| { readonly action: 'retry'; readonly reason: string; readonly short?: boolean }
	/** 受け口がこのペインを知らない。次の候補（直結）を試す。 */
	| { readonly action: 'next-endpoint'; readonly reason: string }
	/** 実行されたか分からない。送り直さない。 */
	| { readonly action: 'unknown-state'; readonly reason: string }
	| { readonly action: 'sandbox' }
	| { readonly action: 'fail'; readonly message: string };

/**
 * 送信の結果の扱いを決める。送り直してよいのは「何も実行されていない」と言えるときだけ:
 * つながる前の失敗、404（ペインを知らない。処理の前に断られたもの）、429（混んでいる）、503（受け口の打ち切り・同期前）。
 * つながった後に切れたとき・502（受け口が手元へ送り始めた後に切れた）・印の付いた 404（本体が処理した後に、ペインが
 * 今のものでなくなっていた）は実行されたか分からないので、読むだけのコマンドだけ送り直す。
 */
export function paradisCliVerdict(attempt: ParadisCliAttempt, endpoint: IParadisCliEndpoint, readOnly: boolean): ParadisCliVerdict {
	if (attempt.kind === 'not-sent') {
		// サンドボックス（Codex の workspace-write など）が接続を断った。待っても変わらない
		return attempt.code === 'EPERM' || attempt.code === 'EACCES' ? { action: 'sandbox' } : { action: 'retry', reason: attempt.code };
	}
	if (attempt.kind === 'broken') {
		return readOnly ? { action: 'retry', reason: attempt.code } : { action: 'unknown-state', reason: attempt.code };
	}
	switch (attempt.status) {
		case 200:
			return { action: 'done' };
		case 404:
			if (attempt.afterDispatch) {
				return readOnly ? { action: 'retry', reason: 'the terminal changed while the request was handled (HTTP 404)', short: true } : { action: 'unknown-state', reason: 'the terminal changed while the request was handled' };
			}
			return endpoint.gateway ? { action: 'next-endpoint', reason: 'HTTP 404' } : { action: 'retry', reason: 'this terminal is not known to Para Code yet (HTTP 404)', short: true };
		case 429:
			return { action: 'retry', reason: 'Para Code is busy (HTTP 429)' };
		case 503:
			return { action: 'retry', reason: attempt.text.includes(GATEWAY_TIMEOUT_CODE) ? 'the Para Code window is not connected' : 'HTTP 503' };
		case 502:
			return readOnly ? { action: 'retry', reason: 'HTTP 502' } : { action: 'unknown-state', reason: 'HTTP 502' };
		default:
			return { action: 'fail', message: `Para Code answered HTTP ${attempt.status}: ${attempt.text.slice(0, 300)}` };
	}
}

/** JSON-RPC のエラー（本体が要求を断った）。 */
export class ParadisCliRpcError extends Error {
	constructor(message: string, readonly code: number | undefined) {
		super(message);
	}
}

export interface IParadisCliRuntime {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly cwd: string;
	readonly home: string;
	readonly argv: readonly string[];
	stdout(text: string): void;
	stderr(text: string): void;
	readonly post?: ParadisCliPost;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
}

function waitSeconds(env: Readonly<Record<string, string | undefined>>): number {
	const value = Number(env[PARADIS_CLI_WAIT_ENV]);
	return env[PARADIS_CLI_WAIT_ENV] !== undefined && Number.isFinite(value) && value >= 0 ? value : PARADIS_CLI_DEFAULT_WAIT_SECONDS;
}

/** 呼び出しに添える印（会話の識別子）。エージェントの会話の ID そのものは送らず、ハッシュにする。 */
export function paradisCliCallMeta(env: Readonly<Record<string, string | undefined>>): IParadisCliCallMeta {
	for (const name of CONVERSATION_ENVS) {
		const value = env[name];
		if (value !== undefined && value.length > 0) {
			return { conversation: createHash('sha256').update(`${name}:${value}`).digest('hex').slice(0, Math.min(32, PARADIS_CLI_CONVERSATION_MAX_LENGTH)) };
		}
	}
	return {};
}

/**
 * JSON-RPC を 1 回送る。Para Code に届かない間（ポートファイルが無い・接続拒否・窓が切れている・ペインがまだ
 * 知られていない）は待って送り直す。操作のコマンドは、届いたかもしれない後には送り直さない。
 */
export async function paradisCliRpc(runtime: IParadisCliRuntime, method: string, params: Record<string, unknown> | undefined, readOnly: boolean): Promise<unknown> {
	const token = runtime.env[PARADIS_CLI_TOKEN_ENV];
	if (token === undefined || token.length === 0) {
		throw new ParadisCliUnavailableError(`${PARADIS_CLI_TOKEN_ENV} is not set. Run para in a terminal of Para Code.`);
	}
	const post = runtime.post ?? paradisCliHttpPost;
	const now = runtime.now ?? Date.now;
	const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { [PARADIS_CLI_META_KEY]: paradisCliCallMeta(runtime.env) } } });
	const budgetSeconds = waitSeconds(runtime.env);
	const startedAt = now();
	const deadline = startedAt + budgetSeconds * 1000;
	let unknownPaneSince: number | undefined;
	let announced = false;
	let reason = '';
	for (let attempt = 0; ; attempt++) {
		const endpoints = await paradisCliEndpoints(runtime.env[PARADIS_CLI_PORT_FILE_ENV]);
		reason = endpoints.length === 0 ? (runtime.env[PARADIS_CLI_PORT_FILE_ENV] ? 'the Para Code port file has no port yet' : `${PARADIS_CLI_PORT_FILE_ENV} is not set`) : reason;
		let short = false;
		for (const endpoint of endpoints) {
			// 受け口には、自分が待てる残りの時間を伝える（受け口の既定の 120 秒より先に答えてもらう）
			const remainingSeconds = Math.max(1, Math.ceil((deadline - now()) / 1000));
			const result = await post(endpoint, token, body, endpoint.gateway ? { [PARADIS_CLI_GATEWAY_WAIT_HEADER]: String(remainingSeconds) } : {});
			const verdict = paradisCliVerdict(result, endpoint, readOnly);
			if (verdict.action === 'done') {
				let parsed: { readonly result?: unknown; readonly error?: { readonly message?: unknown; readonly code?: unknown } };
				try {
					parsed = JSON.parse((result as { text: string }).text);
				} catch {
					throw new ParadisCliUnavailableError('Para Code sent an answer that is not JSON.');
				}
				if (parsed.error) {
					throw new ParadisCliRpcError(typeof parsed.error.message === 'string' ? parsed.error.message : 'Request failed', typeof parsed.error.code === 'number' ? parsed.error.code : undefined);
				}
				if (announced) {
					runtime.stderr('para: connected again.\n');
				}
				return parsed.result;
			}
			if (verdict.action === 'sandbox') {
				throw new ParadisCliUnavailableError('Your sandbox blocked the connection to Para Code (Para Code is running; do not restart it). Run this same command again outside the sandbox (ask for escalated permissions). Nothing was done.', ParadisCliExit.Sandbox);
			}
			if (verdict.action === 'unknown-state') {
				throw new ParadisCliUnavailableError(`Para Code did not confirm the request after it was sent (${verdict.reason}). The action may or may not have happened: check the state (for example read the page) before you repeat it.`);
			}
			if (verdict.action === 'fail') {
				throw new ParadisCliUnavailableError(verdict.message);
			}
			reason = verdict.reason;
			if (verdict.action === 'retry') {
				short = verdict.short === true;
				break;
			}
			// next-endpoint: 受け口がこのペインを知らない。直結を試す（候補が尽きたら待って最初から）
			short = true;
		}
		if (short) {
			unknownPaneSince ??= now();
		} else {
			unknownPaneSince = undefined;
		}
		const giveUpAt = unknownPaneSince !== undefined ? Math.min(deadline, unknownPaneSince + UNKNOWN_PANE_WAIT_SECONDS * 1000) : deadline;
		if (now() >= giveUpAt) {
			const waited = Math.round((now() - startedAt) / 1000);
			throw new ParadisCliUnavailableError(unknownPaneSince !== undefined
				? `Para Code does not know this terminal (waited ${waited} s). Run para in a terminal that Para Code opened; a terminal that was open before Para Code restarted may need to be reopened. Nothing was done.`
				: `Para Code did not answer for ${waited} seconds (${reason}). It may be restarting or its window may be disconnected: wait a little and run the command again. Nothing was done.`);
		}
		if (!announced) {
			runtime.stderr(`para: Para Code is not reachable (${reason}); waiting up to ${Math.round((giveUpAt - now()) / 1000)} s...\n`);
			announced = true;
		}
		// 待ちの上限を越えて眠らない（合計の待ちを、エージェントのシェルの制限より短く保つ）
		await sleep(Math.max(1, Math.min(250 * 2 ** Math.min(attempt, 3), 2000, giveUpAt - now())));
	}
}

// ---- 品書き --------------------------------------------------------------------------------------------------

function paraCodeFolder(runtime: IParadisCliRuntime, ...rest: string[]): string {
	return join(runtime.home, '.para-code', ...rest);
}

function catalogCacheFile(runtime: IParadisCliRuntime): string {
	const key = createHash('sha256').update(runtime.env[PARADIS_CLI_TOKEN_ENV] ?? '').digest('hex').slice(0, 16);
	return paraCodeFolder(runtime, 'cli-cache', `catalog-${key}.json`);
}

function isCatalog(value: unknown): value is IParadisCliCatalog {
	const catalog = value as IParadisCliCatalog | undefined;
	return catalog !== null && typeof catalog === 'object' && Array.isArray(catalog.groups) && Array.isArray(catalog.commands);
}

/** 品書きを取る（ホームの `~/.para-code/cli-cache` に 5 分控える。控えにトークンは入らない）。 */
export async function paradisCliLoadCatalog(runtime: IParadisCliRuntime, refresh: boolean): Promise<IParadisCliCatalog> {
	const file = catalogCacheFile(runtime);
	const now = (runtime.now ?? Date.now)();
	if (!refresh) {
		try {
			const cached = JSON.parse(await fs.readFile(file, 'utf8')) as { readonly savedAt?: unknown; readonly catalog?: unknown };
			if (typeof cached.savedAt === 'number' && now - cached.savedAt < CATALOG_CACHE_MS && now >= cached.savedAt && isCatalog(cached.catalog) && cached.catalog.protocolVersion === PARADIS_CLI_PROTOCOL_VERSION) {
				return cached.catalog;
			}
		} catch {
			// 控えが無い・壊れている
		}
	}
	let catalog: unknown;
	try {
		catalog = await paradisCliRpc(runtime, PARADIS_CLI_CATALOG_METHOD, undefined, true);
	} catch (error) {
		if (error instanceof ParadisCliRpcError && error.code === -32601) {
			throw new ParadisCliUnavailableError('This Para Code does not answer the para command yet (it is older than this command). Update Para Code, or use its MCP tools.');
		}
		throw error;
	}
	if (!isCatalog(catalog) || catalog.protocolVersion !== PARADIS_CLI_PROTOCOL_VERSION) {
		throw new ParadisCliUnavailableError('This para command and Para Code are different versions. Open a new terminal in Para Code and try again.');
	}
	try {
		await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${process.pid}.tmp`;
		await fs.writeFile(temporary, JSON.stringify({ savedAt: now, catalog }), { mode: 0o600 });
		await fs.rename(temporary, file);
	} catch {
		// 書けない（読み取り専用のサンドボックスなど）。次の呼び出しでまた聞く
	}
	return catalog;
}

// ---- フラグ --------------------------------------------------------------------------------------------------

interface ISchemaProperty {
	readonly type?: string | readonly string[];
	readonly enum?: readonly unknown[];
	readonly items?: { readonly type?: string; readonly enum?: readonly unknown[] };
	readonly description?: string;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly exclusiveMinimum?: number;
	readonly exclusiveMaximum?: number;
}

function schemaProperties(command: IParadisCliCommand): Record<string, ISchemaProperty> {
	const schema = command.inputSchema as { readonly properties?: Record<string, ISchemaProperty> } | undefined;
	return schema?.properties ?? {};
}

function schemaRequired(command: IParadisCliCommand): readonly string[] {
	const schema = command.inputSchema as { readonly required?: readonly string[] } | undefined;
	return Array.isArray(schema?.required) ? schema.required : [];
}

const kebab = (name: string) => name.replace(/_/g, '-').replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

function typesOf(schema: ISchemaProperty): readonly string[] {
	return Array.isArray(schema.type) ? schema.type : typeof schema.type === 'string' ? [schema.type] : [];
}

function typeLabel(schema: ISchemaProperty): string {
	if (schema.enum) {
		return schema.enum.join('|');
	}
	const types = typesOf(schema);
	if (types.length === 1 && types[0] === 'array') {
		return schema.items?.type === 'string' ? 'text (repeat the flag)' : 'JSON array';
	}
	if (types.length === 1 && types[0] === 'boolean') {
		return '';
	}
	return types.map(type => type === 'object' ? 'JSON object' : type === 'integer' ? 'number' : type).join('|') || 'JSON';
}

function coerce(flag: string, raw: string, schema: ISchemaProperty): unknown {
	const types = typesOf(schema);
	if (types.includes('integer') || types.includes('number')) {
		const value = Number(raw);
		if (raw.trim() !== '' && Number.isFinite(value)) {
			return value;
		}
		if (types.length === 1) {
			throw new ParadisCliUsageError(`--${flag} takes a number, got "${raw}".`);
		}
	}
	if (types.includes('boolean') && (raw === 'true' || raw === 'false')) {
		return raw === 'true';
	}
	if (types.includes('string')) {
		return raw;
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new ParadisCliUsageError(`--${flag} takes ${typeLabel(schema) || 'JSON'}; "${raw}" is not valid JSON.`);
	}
}

export interface IParadisCliParsedFlags {
	readonly args: Record<string, unknown>;
	readonly help: boolean;
	readonly raw: boolean;
	readonly out: string | undefined;
}

/**
 * ファイルの場所を受ける引数。相対パスは、Para Code の側ではなく `para` を打ったフォルダから解く（道具は絶対パスを
 * 受け取る）。read_download の `path` は道具が返した絶対パスだけを受けるので、ここには入れない。
 */
const PATH_ARGUMENTS: ReadonlySet<string> = new Set(['filePath', 'requestFilePath', 'responseFilePath', 'saveTo', 'outputDirPath']);

/**
 * 道具ごとのファイルの場所の引数。`path` は read_download（道具が返した絶対パスだけを受ける）にもあるので、
 * 名前だけでは決めず、道具を限って解く。
 */
const TOOL_PATH_ARGUMENTS: ReadonlyMap<string, readonly string[]> = new Map([
	['preview_file', ['path']],
	['mobile_install_app', ['path']],
	['adopt_doc', ['paths']],
]);

function resolvePathArguments(args: Record<string, unknown>, cwd: string | undefined, tool: string): Record<string, unknown> {
	if (cwd === undefined) {
		return args;
	}
	// `~/` で始まるパスはそのまま送る（接続先のペインでは、本体が接続先のホームへ展開する）
	const resolveOne = (value: unknown) => typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.startsWith('~') ? resolvePath(cwd, value) : value;
	const resolved: Record<string, unknown> = { ...args };
	for (const name of [...PATH_ARGUMENTS, ...(TOOL_PATH_ARGUMENTS.get(tool) ?? [])]) {
		const value = resolved[name];
		if (value !== undefined) {
			resolved[name] = Array.isArray(value) ? value.map(resolveOne) : resolveOne(value);
		}
	}
	return resolved;
}

/**
 * 範囲の外の値を、道具の側で端に寄せて受ける（断らない）引数。道具名（`*` はすべての道具）→ 引数名。
 * ここに挙げた引数は、CLI でも範囲の外を断らずに道具へ渡す（選択肢の検査はする）。
 * - read_terminal の scrollback_lines・wait_for_terminal の timeout_seconds: `paradisAgentIde.ts` の optionalInteger が端に寄せる
 * - evaluate_script の timeout_seconds: `paradisDevtoolsToolAdjustments.ts` の paradisDevtoolsTimeoutMs が端に寄せる（0 以下は既定）
 * - take_snapshot の offset: 負の値は 0 として読む
 * - settle_seconds（E1 が足す引数。どの道具でも同じ）: `paradisBrowserObserve.ts` が端に寄せる
 */
const CLAMPED_ARGUMENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['read_terminal', new Set(['scrollback_lines'])],
	['wait_for_terminal', new Set(['timeout_seconds'])],
	['evaluate_script', new Set(['timeout_seconds'])],
	['take_snapshot', new Set(['offset'])],
	['*', new Set(['settle_seconds'])],
]);

function isClamped(tool: string, name: string): boolean {
	return CLAMPED_ARGUMENTS.get(tool)?.has(name) === true || CLAMPED_ARGUMENTS.get('*')?.has(name) === true;
}

/**
 * 値が道具のスキーマの選択肢（enum）と範囲（minimum・maximum）に入っているかを確かめる。外れた値を道具へ送ると、
 * 道具の誤り（exit 1）や MCP の検査の生の文になるので、ここで使い方の誤り（exit 2）として断る。
 * null（`number|null` の引数で「無し」の意味）とスキーマに無い名前（--json で渡された分。道具が断る）は見ない。
 * 道具の側で端に寄せる引数（{@link CLAMPED_ARGUMENTS}）は、範囲を見ない。
 */
function checkValues(args: Record<string, unknown>, command: IParadisCliCommand): void {
	const properties = schemaProperties(command);
	for (const [name, value] of Object.entries(args)) {
		const schema = Object.prototype.hasOwnProperty.call(properties, name) ? properties[name] : undefined;
		if (schema === undefined || value === null || value === undefined) {
			continue;
		}
		const flag = kebab(name);
		const choices = schema.enum ?? (Array.isArray(value) ? schema.items?.enum : undefined);
		if (choices !== undefined) {
			const wrong = (Array.isArray(value) && schema.enum === undefined ? value : [value]).find(item => !choices.includes(item));
			if (wrong !== undefined) {
				throw new ParadisCliUsageError(`--${flag} takes ${choices.join('|')}, got ${JSON.stringify(wrong)}. ${flagList(command)}`);
			}
		}
		if (typeof value === 'number' && !isClamped(command.tool, name)) {
			const tooSmall = (schema.minimum !== undefined && value < schema.minimum) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum);
			const tooLarge = (schema.maximum !== undefined && value > schema.maximum) || (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum);
			if (tooSmall || tooLarge) {
				const range = schema.minimum !== undefined && schema.maximum !== undefined
					? `from ${schema.minimum} to ${schema.maximum}`
					: [
						schema.minimum !== undefined ? `at least ${schema.minimum}` : schema.exclusiveMinimum !== undefined ? `more than ${schema.exclusiveMinimum}` : undefined,
						schema.maximum !== undefined ? `at most ${schema.maximum}` : schema.exclusiveMaximum !== undefined ? `less than ${schema.exclusiveMaximum}` : undefined,
					].filter(part => part !== undefined).join(' and ');
				throw new ParadisCliUsageError(`--${flag} takes a number ${range}, got ${value}. ${flagList(command)}`);
			}
		}
	}
}

/**
 * コマンドのフラグを道具の引数にする。`--tab-id x`・`--tab_id x`・`--tab-id=x` のどれでもよい。真偽値は値なしで true、
 * `--no-<名前>` で false。知らないフラグは断る（黙って捨てない）。CLI 自身のフラグ（--json・--out・--raw・--help）と
 * 同じ名前の引数を持つ道具では、引数が勝つ。
 */
export function paradisCliParseFlags(argv: readonly string[], command: IParadisCliCommand, cwd?: string): IParadisCliParsedFlags {
	const properties = schemaProperties(command);
	const byFlag = new Map<string, string>();
	for (const name of Object.keys(properties)) {
		byFlag.set(kebab(name), name);
		// 引数の名前が camelCase の道具（close_browser_tab の tabId など）でも、ほかの道具と同じ `--tab_id` で渡せるようにする
		byFlag.set(kebab(name).replace(/-/g, '_'), name);
	}
	// 引数そのものの名前は、別の引数の別名より強い（tab_id と tabId の両方を持つ道具でも取り違えない）
	for (const name of Object.keys(properties)) {
		byFlag.set(name, name);
	}
	const args: Record<string, unknown> = {};
	let base: Record<string, unknown> = {};
	let help = false;
	let raw = false;
	let out: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith('--') || token.length === 2) {
			throw new ParadisCliUsageError(`Unexpected argument "${token}". Pass values as --flag value. ${flagList(command)}`);
		}
		let flag = token.slice(2);
		let inline: string | undefined;
		const equals = flag.indexOf('=');
		if (equals !== -1) {
			inline = flag.slice(equals + 1);
			flag = flag.slice(0, equals);
		}
		const take = (): string => {
			if (inline !== undefined) {
				return inline;
			}
			if (index + 1 >= argv.length) {
				throw new ParadisCliUsageError(`--${flag} needs a value.`);
			}
			return argv[++index];
		};
		const name = byFlag.get(flag);
		if (name !== undefined) {
			const schema = properties[name];
			const types = typesOf(schema);
			if (types.length === 1 && types[0] === 'boolean') {
				const next = inline ?? argv[index + 1];
				if (next === 'true' || next === 'false') {
					args[name] = take() === 'true';
				} else {
					args[name] = true;
				}
			} else if (types.length === 1 && types[0] === 'array' && schema.items?.type === 'string') {
				const value = take();
				let items: unknown = [value];
				if (value.startsWith('[')) {
					try {
						items = JSON.parse(value);
					} catch {
						items = [value];
					}
				}
				args[name] = [...(Array.isArray(args[name]) ? args[name] as unknown[] : []), ...(Array.isArray(items) ? items : [value])];
			} else {
				args[name] = coerce(flag, take(), schema);
			}
		} else if (flag === 'help') {
			help = true;
		} else if (flag === 'raw') {
			raw = true;
		} else if (flag === 'refresh') {
			// 品書きの取り直し。呼ぶ側で処理済み
		} else if (flag === 'out') {
			out = take();
		} else if (flag === 'json') {
			let parsed: unknown;
			try {
				parsed = JSON.parse(take());
			} catch {
				parsed = undefined;
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new ParadisCliUsageError('--json takes a JSON object with the arguments, for example --json \'{"url":"https://example.com"}\'.');
			}
			// --json のキーも、フラグと同じ別名（tab_id・tab-id → tabId）で受ける。道具の引数に無い名前はそのまま送る（道具が断る）
			base = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [byFlag.get(key) ?? key, value]));
		} else if (flag.startsWith('no-') && byFlag.has(flag.slice(3)) && typesOf(properties[byFlag.get(flag.slice(3))!]).includes('boolean')) {
			args[byFlag.get(flag.slice(3))!] = false;
		} else {
			throw new ParadisCliUsageError(`Unknown flag --${flag}. ${flagList(command)}`);
		}
	}
	const merged = resolvePathArguments({ ...base, ...args }, cwd, command.tool);
	if (!help) {
		const missing = schemaRequired(command).filter(name => merged[name] === undefined);
		if (missing.length > 0) {
			throw new ParadisCliUsageError(`Missing ${missing.map(name => `--${kebab(name)}`).join(', ')}. ${flagList(command)}`);
		}
		checkValues(merged, command);
	}
	return { args: merged, help, raw, out };
}

function flagList(command: IParadisCliCommand): string {
	const names = Object.keys(schemaProperties(command)).map(name => `--${kebab(name)}`);
	return `Flags of para ${command.group} ${command.verb}: ${names.length > 0 ? names.join(' ') : '(none)'}. See para help ${command.group} ${command.verb}.`;
}

// ---- 手引き --------------------------------------------------------------------------------------------------

function firstSentence(text: string): string {
	const match = /^(.*?[.!?])(\s|$)/s.exec(text);
	const sentence = (match ? match[1] : text).replace(/\s+/g, ' ');
	return sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence;
}

/** すべてのコマンドに共通の約束（`para help`）。手引き（スキル）からはここを読むよう案内する。 */
export const PARADIS_CLI_RULES = [
	'Rules:',
	'- Read `para help <group>` before you use a group for the first time: it holds the rules of that group. Read `para help <group> <command>` before the first use of a command: flags with other names or types are refused.',
	'- The rules name commands by their tool name (set_cursor_label, click_by). `para browser set_cursor_label`, `para browser set-cursor-label` and the short name `para browser label` are the same command; arguments are flags (tab_id is --tab-id).',
	'- A command that returns an image saves it to a file and prints the path; open that file with your image viewing tool (Read in Claude Code, view_image in Codex). --out <file> chooses the file: a new file inside the current folder or ~/.para-code/browser-files (not /tmp). Without --out the image goes to ~/.para-code/browser-files/para-cli.',
	'- Exit code 0 = done, 1 = the tool reported a problem (read the text), 2 = wrong command or flags (read para help), 3 = Para Code is not reachable, 4 = your sandbox blocked the connection.',
	'- Exit code 3: para already waited for Para Code. Run the command again later. If the message says the request may have been sent, check the state before you repeat an action.',
	'- Exit code 4: run the same command again outside the sandbox (ask for escalated permissions). Do not restart Para Code.',
	'- Never print the environment (env, printenv, set): it holds the access token of this terminal.',
].join('\n');

function commandLabel(command: IParadisCliCommand): string {
	return command.aliases.length > 0 ? `${command.aliases.join(', ')}, ${command.verb}` : command.verb;
}

export function paradisCliHelpTop(catalog: IParadisCliCatalog): string {
	const lines = [
		'para - use the Para Code browser, terminals, notes and IDE from this terminal.',
		'',
		'Usage: para <group> <command> [--flag value ...]',
		'',
		'Groups:',
	];
	for (const group of catalog.groups) {
		const count = catalog.commands.filter(command => command.group === group.name).length;
		lines.push(`  ${group.name.padEnd(9)} ${group.summary} (${count} commands)`);
	}
	lines.push(
		'',
		'  para help <group>             the rules of a group and its commands, one line each',
		'  para help <group> <command>   the flags and the full description of a command',
		'  para commands [--read-only|--actions] [--json]   every command',
		'  para call <tool_name> --json \'{...}\'              call a tool by its name',
		'  para status                   check that Para Code answers',
		'  para permissions [--all]      permission rules for Claude Code (commands that only read, except reading or waiting for another terminal and switching the pane\'s page; --all adds those and the ones that act)',
		'',
		'Every command takes --json \'<all arguments as a JSON object>\' (flags override it), --out <file> and --raw (print the JSON result).',
		'',
		PARADIS_CLI_RULES,
	);
	return lines.join('\n');
}

export function paradisCliHelpGroup(catalog: IParadisCliCatalog, groupName: string): string {
	const group = catalog.groups.find(candidate => candidate.name === groupName);
	const commands = catalog.commands.filter(command => command.group === groupName);
	const lines = [`para ${groupName} <command> [--flag value ...]${group ? `   ${group.summary}` : ''}`, ''];
	if (group !== undefined && group.guide.length > 0) {
		lines.push('Rules of this group:', group.guide, '');
	}
	lines.push('Commands (R = only reads, A = acts):');
	for (const command of commands) {
		lines.push(`  ${command.readOnly ? 'R' : 'A'} ${commandLabel(command).padEnd(36)} ${firstSentence(command.description)}`);
	}
	lines.push('', `para help ${groupName} <command> shows the flags and the full description.`);
	return lines.join('\n');
}

export function paradisCliHelpCommand(command: IParadisCliCommand): string {
	const required = new Set(schemaRequired(command));
	const lines = [`para ${command.group} ${command.aliases[0] ?? command.verb} [flags]   (${command.readOnly ? 'only reads' : 'acts'}; tool ${command.tool}${command.aliases.length > 0 ? `; also para ${command.group} ${command.verb}` : ''})`, '', command.description, '', 'Flags:'];
	const properties = schemaProperties(command);
	for (const [name, schema] of Object.entries(properties)) {
		const label = typeLabel(schema);
		const limits = [schema.minimum !== undefined ? `min ${schema.minimum}` : '', schema.maximum !== undefined ? `max ${schema.maximum}` : ''].filter(Boolean).join(', ');
		lines.push(`  --${kebab(name)}${label ? ` <${label}>` : ''}${required.has(name) ? '  (required)' : ''}${limits ? `  [${limits}]` : ''}`);
		if (schema.description) {
			lines.push(`      ${schema.description}`);
		}
	}
	const taken = PARADIS_CLI_RESERVED_FLAGS.filter(flag => Object.keys(properties).some(name => kebab(name) === flag));
	lines.push('  --json <JSON object>   All arguments at once (flags override it).');
	if (!taken.includes('out')) {
		lines.push('  --out <file>           Where to save a returned image (a new file in the current folder or ~/.para-code/browser-files).');
	}
	if (!taken.includes('raw')) {
		lines.push('  --raw                  Print the JSON result as is.');
	}
	return lines.join('\n');
}

/**
 * 読むだけの印（MCP の `readOnlyHint`）は付いているが、Claude Code の許可の一覧には入れない道具（q.html Q682 の 2）。
 * ほかのペインの画面を読む・ほかのエージェントを待つ・ペインの今のページを替えるもので、実行のたびに利用者へ聞く。
 * 読むだけの印そのもの（手引きの R と、切れたときの送り直し）は変えない。
 */
const ASK_EVERY_TIME_TOOLS: ReadonlySet<string> = new Set(['read_terminal', 'wait_for_terminal', 'select_page']);

/**
 * Claude Code の許可の規則（`permissions.allow` に入れる形）。読むだけのコマンド（{@link ASK_EVERY_TIME_TOOLS} を除く）と、
 * 手引き・一覧だけを許す。`all` なら残りのコマンドも入れる。`para call` と `--json` だけの形は入れない（どの道具でも呼べるため）。
 */
export function paradisCliClaudePermissions(catalog: IParadisCliCatalog, all: boolean): string[] {
	const rules = ['Bash(para help:*)', 'Bash(para --help)', 'Bash(para commands:*)', 'Bash(para status)', 'Bash(para permissions:*)'];
	for (const command of catalog.commands) {
		if ((command.readOnly && !ASK_EVERY_TIME_TOOLS.has(command.tool)) || all) {
			for (const name of [command.verb, ...command.aliases, ...(command.tool !== command.verb ? [command.tool] : [])]) {
				rules.push(`Bash(para ${command.group} ${name}:*)`);
			}
		}
	}
	return rules;
}

// ---- 画像 ----------------------------------------------------------------------------------------------------

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

function isInside(root: string, target: string): boolean {
	const rest = relative(root, target);
	return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

/** 存在するいちばん近い親までを実体のパス（リンクを解いたもの）にし、残りをつなぐ。 */
async function realpathOfNearest(target: string): Promise<string> {
	const tail: string[] = [];
	let current = target;
	for (; ;) {
		try {
			return join(await fs.realpath(current), ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				return target;
			}
			tail.push(basename(current));
			current = parent;
		}
	}
}

/**
 * `--out` の場所を確かめて絶対パスで返す（要求を送る前に見る）。許すのは、作業フォルダの中と Para Code の専用フォルダ
 * （`~/.para-code/browser-files`）の中の、まだ無いファイルだけ。/tmp や作業フォルダの外へは書かない（画像を撮る
 * コマンドは「読むだけ」として許可されるので、ここで書ける場所を絞る）。判定はリンクを解いたパスで行う。
 */
export async function paradisCliCheckOutputPath(out: string, cwd: string, home: string): Promise<string> {
	if (out.length === 0) {
		throw new ParadisCliUsageError('--out needs a file name.');
	}
	const full = resolvePath(cwd, out.startsWith('~/') ? join(home, out.slice(2)) : out);
	const real = await realpathOfNearest(full);
	const roots = [await realpathOfNearest(cwd), await realpathOfNearest(join(home, ...PARA_CODE_FILES_FOLDER))];
	if (!roots.some(root => real !== root && isInside(root, real))) {
		throw new ParadisCliUsageError(`--out must be a new file inside the current folder (${cwd}) or ~/${PARA_CODE_FILES_FOLDER.join('/')}. /tmp and other folders are not allowed.`);
	}
	if (relative(roots[0], real).split(/[\\/]/).some(part => part === '.git' || part === '.hg' || part === '.svn')) {
		throw new ParadisCliUsageError('--out must not be inside .git, .hg or .svn.');
	}
	if (await fs.lstat(full).then(() => true, () => false)) {
		throw new ParadisCliUsageError(`${full} already exists; pass a new file name to --out.`);
	}
	return full;
}

async function imageFile(runtime: IParadisCliRuntime, out: string | undefined, mimeType: string | undefined, position: number, total: number, stamp: string): Promise<string> {
	const extension = IMAGE_EXTENSIONS[mimeType ?? ''] ?? '.bin';
	if (out === undefined) {
		return join(runtime.home, ...PARA_CODE_FILES_FOLDER, 'para-cli', `shot-${stamp}-${position + 1}${extension}`);
	}
	if (total === 1) {
		return out;
	}
	const ext = extname(out);
	return paradisCliCheckOutputPath(`${out.slice(0, out.length - ext.length)}-${position + 1}${ext || extension}`, runtime.cwd, runtime.home);
}

interface IContentBlock {
	readonly type?: string;
	readonly text?: string;
	readonly data?: string;
	readonly mimeType?: string;
}

/** 道具の結果を出す。文字はそのまま、画像はファイルへ保存して場所を 1 行で出す。 */
export async function paradisCliPrintResult(runtime: IParadisCliRuntime, result: unknown, flags: Pick<IParadisCliParsedFlags, 'raw' | 'out'>): Promise<ParadisCliExit> {
	const record = result as { readonly content?: unknown; readonly isError?: unknown } | undefined;
	const exit = record?.isError === true ? ParadisCliExit.ToolError : ParadisCliExit.Ok;
	if (flags.raw) {
		runtime.stdout(`${JSON.stringify(result)}\n`);
		return exit;
	}
	const content: readonly IContentBlock[] = Array.isArray(record?.content) ? record.content : [];
	const images = content.filter(block => block.type === 'image');
	const stamp = `${(runtime.now ?? Date.now)().toString(36)}-${process.pid.toString(36)}`;
	let position = 0;
	for (const block of content) {
		if (block.type === 'text' && typeof block.text === 'string') {
			runtime.stdout(block.text.endsWith('\n') ? block.text : `${block.text}\n`);
		} else if (block.type === 'image' && typeof block.data === 'string') {
			const file = await imageFile(runtime, flags.out, block.mimeType, position++, images.length, stamp);
			try {
				await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
				await fs.writeFile(file, Buffer.from(block.data, 'base64'), { flag: 'wx', mode: 0o600 });
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				throw new ParadisCliUsageError(code === 'EEXIST' ? `${file} already exists; pass a new file name to --out.` : `Could not write ${file} (${code}).`);
			}
			runtime.stdout(`[image saved: ${file}] Open this file with your image viewing tool to see it.\n`);
		} else {
			runtime.stdout(`${JSON.stringify(block)}\n`);
		}
	}
	if (content.length === 0 && result !== undefined) {
		runtime.stdout(`${JSON.stringify(result)}\n`);
	}
	if (flags.out !== undefined && images.length === 0) {
		runtime.stderr('para: this command returned no image, so --out was not used.\n');
	}
	return exit;
}

// ---- 入口 ----------------------------------------------------------------------------------------------------

function findCommand(catalog: IParadisCliCatalog, groupName: string, name: string): IParadisCliCommand | undefined {
	const commands = catalog.commands.filter(command => command.group === groupName);
	return commands.find(command => command.verb === name)
		?? commands.find(command => command.aliases.includes(name))
		?? commands.find(command => command.tool === name || command.tool === name.replace(/-/g, '_'));
}

function unknownCommand(catalog: IParadisCliCatalog, groupName: string, name: string): ParadisCliUsageError {
	// 別の分野にある道具の名前で呼ばれたら、正しい分野を教える
	const elsewhere = catalog.commands.find(command => command.tool === name.replace(/-/g, '_') || command.verb === name);
	if (elsewhere !== undefined) {
		return new ParadisCliUsageError(`"${name}" is in the group ${elsewhere.group}: para ${elsewhere.group} ${elsewhere.verb}.`);
	}
	const close = catalog.commands.filter(command => command.group === groupName && (command.verb.includes(name) || name.includes(command.verb.split('-')[0]))).slice(0, 6).map(command => command.verb);
	return new ParadisCliUsageError(`Unknown command "para ${groupName} ${name}".${close.length > 0 ? ` Did you mean: ${close.join(', ')}?` : ''} Run para help ${groupName}.`);
}

async function run(runtime: IParadisCliRuntime): Promise<ParadisCliExit> {
	const argv = runtime.argv;
	const refresh = argv.includes('--refresh');
	const [first, second, ...rest] = argv.filter(arg => arg !== '--refresh');
	if (first === 'status') {
		const now = runtime.now ?? Date.now;
		const startedAt = now();
		await paradisCliRpc(runtime, 'ping', undefined, true);
		runtime.stdout(`Para Code answers (${now() - startedAt} ms).\n`);
		return ParadisCliExit.Ok;
	}
	let catalog = await paradisCliLoadCatalog(runtime, refresh);
	// 控えの品書きに無いコマンド・分野は、取り直してからもう一度だけ探す（設定で道具が増えた直後など）
	const withFresh = async <T>(find: (catalog: IParadisCliCatalog) => T | undefined): Promise<T | undefined> => {
		const found = find(catalog);
		if (found !== undefined || refresh) {
			return found;
		}
		catalog = await paradisCliLoadCatalog(runtime, true);
		return find(catalog);
	};
	if (first === undefined || first === '--help' || (first === 'help' && second === undefined)) {
		runtime.stdout(`${paradisCliHelpTop(catalog)}\n`);
		return ParadisCliExit.Ok;
	}
	if (first === 'help') {
		const group = await withFresh(current => current.groups.find(candidate => candidate.name === second));
		if (group === undefined) {
			throw new ParadisCliUsageError(`Unknown group "${second}". Groups: ${catalog.groups.map(candidate => candidate.name).join(', ')}.`);
		}
		if (rest[0] === undefined) {
			runtime.stdout(`${paradisCliHelpGroup(catalog, group.name)}\n`);
			return ParadisCliExit.Ok;
		}
		const command = await withFresh(current => findCommand(current, group.name, rest[0]));
		if (command === undefined) {
			throw unknownCommand(catalog, group.name, rest[0]);
		}
		runtime.stdout(`${paradisCliHelpCommand(command)}\n`);
		return ParadisCliExit.Ok;
	}
	if (first === 'commands') {
		const flags = new Set([second, ...rest]);
		const commands = catalog.commands.filter(command => flags.has('--read-only') ? command.readOnly : flags.has('--actions') ? !command.readOnly : true);
		runtime.stdout(flags.has('--json')
			? `${JSON.stringify(commands.map(command => ({ command: `para ${command.group} ${command.verb}`, aliases: command.aliases, tool: command.tool, readOnly: command.readOnly })))}\n`
			: `${commands.map(command => `${command.readOnly ? 'R' : 'A'} para ${command.group} ${command.verb}`).join('\n')}\n`);
		return ParadisCliExit.Ok;
	}
	if (first === 'permissions') {
		const flags = new Set([second, ...rest]);
		runtime.stdout(`${JSON.stringify({ permissions: { allow: paradisCliClaudePermissions(catalog, flags.has('--all')) } }, undefined, 2)}\n`);
		return ParadisCliExit.Ok;
	}
	let command: IParadisCliCommand | undefined;
	if (first === 'call') {
		command = second === undefined ? undefined : await withFresh(current => current.commands.find(candidate => candidate.tool === second));
		if (command === undefined) {
			throw new ParadisCliUsageError(`Unknown tool "${second ?? ''}". para commands --json lists the tool names.`);
		}
	} else {
		const group = await withFresh(current => current.groups.find(candidate => candidate.name === first));
		if (group === undefined) {
			throw new ParadisCliUsageError(`Unknown group "${first}". Groups: ${catalog.groups.map(candidate => candidate.name).join(', ')}. Run para help.`);
		}
		if (second === undefined || second === '--help') {
			runtime.stdout(`${paradisCliHelpGroup(catalog, group.name)}\n`);
			return ParadisCliExit.Ok;
		}
		command = await withFresh(current => findCommand(current, group.name, second));
		if (command === undefined) {
			throw unknownCommand(catalog, group.name, second);
		}
	}
	const flags = paradisCliParseFlags(rest, command, runtime.cwd);
	if (flags.help) {
		runtime.stdout(`${paradisCliHelpCommand(command)}\n`);
		return ParadisCliExit.Ok;
	}
	const out = flags.out !== undefined ? await paradisCliCheckOutputPath(flags.out, runtime.cwd, runtime.home) : undefined;
	const result = await paradisCliRpc(runtime, 'tools/call', { name: command.tool, arguments: flags.args }, command.readOnly);
	return paradisCliPrintResult(runtime, result, { raw: flags.raw, out });
}

/**
 * 出力の読み手が先に閉じた（`para … | head -1`）ときの EPIPE を黙って受ける。受け手が無いと、Node が
 * 「Unhandled 'error' event」のスタックを出して落ちる。読み手はもう居ないので、残りの出力は捨てる。
 * 閉じた後に書いた分の誤り（ERR_STREAM_DESTROYED）も同じ。ほかの誤りは今までどおり投げる。
 */
export function paradisCliIgnoreClosedOutput(stream: Pick<NodeJS.EventEmitter, 'on'>): void {
	stream.on('error', (error: NodeJS.ErrnoException) => {
		if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
			throw error;
		}
	});
}

/** `para` の 1 回の実行。終了コードを返す（例外は文にして stderr へ出す）。 */
export async function paradisRunCli(runtime: IParadisCliRuntime): Promise<ParadisCliExit> {
	try {
		return await run(runtime);
	} catch (error) {
		if (error instanceof ParadisCliUsageError) {
			runtime.stderr(`para: ${error.message}\n`);
			return ParadisCliExit.Usage;
		}
		if (error instanceof ParadisCliUnavailableError) {
			runtime.stderr(`para: ${error.message}\n`);
			return error.exitCode;
		}
		if (error instanceof ParadisCliRpcError) {
			runtime.stderr(`para: Para Code refused the request: ${error.message}\n`);
			return ParadisCliExit.ToolError;
		}
		runtime.stderr(`para: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		return ParadisCliExit.ToolError;
	}
}
