/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先に置く「番号の変わらない受け口」の取り決め。
//
// 接続先のエージェント（para-browser の MCP、これから作る CLI）は、手元の Para Code の HTTP へ
// 戻りトンネル（`ssh -R`）の番号で話しかけていた。その番号は張り直しで変わり、切れている間は
// 接続拒否になるので、走っているエージェントは起動時に覚えた URL を失う。受け口は接続先の
// サーバーが 127.0.0.1 の決まった番号で待ち、要求ごとに今のポートファイルを読んで戻りトンネルへ
// 流す。戻りトンネルが無い間は断らずに待たせる。
//
// 受け口は MCP 専用ではない。パスもメソッドもそのまま流し、`Authorization: Bearer <ペインの
// トークン>` でどの PC へ流すかを決める中継で、状態はポートファイルにしか無い。だから接続先の
// サーバーが入れ替わっても、番号を持っているサーバーが誰であっても同じ動きをする。

/** 窓が接続先のサーバーへ受け口の番号を聞くチャネル。 */
export const PARADIS_AGENT_GATEWAY_CHANNEL = 'paradisAgentGateway';

/**
 * 接続先の `~/.para-code` の中の、受け口の番号を書いたファイルの名前。
 * 接続先のプロセス（CLI など）はこれを読んで `http://127.0.0.1:<port>/` へ話しかける。
 */
export const PARADIS_AGENT_GATEWAY_FILE_NAME = 'gateway.json';

/** {@link PARADIS_AGENT_GATEWAY_FILE_NAME} の形の版。読む側は知らない版なら使わない。 */
export const PARADIS_AGENT_GATEWAY_FILE_PROTOCOL_VERSION = 1;

/**
 * 受け口の実装の版。新しい版のサーバーは、古い版の受け口から番号を譲り受ける。
 * 中継の動きを変えたら上げる。
 */
export const PARADIS_AGENT_GATEWAY_VERSION = 1;

/** 受け口が自分のことを答えるパス（GET）。 */
export const PARADIS_AGENT_GATEWAY_INFO_PATH = '/paradis-gateway/info';
/** 新しい版のサーバーが番号を譲り受けるパス（POST）。 */
export const PARADIS_AGENT_GATEWAY_HANDOVER_PATH = '/paradis-gateway/handover';
/** 譲り受けの合い言葉を載せるヘッダー。値は {@link PARADIS_AGENT_GATEWAY_FILE_NAME}（0600）にだけある。 */
export const PARADIS_AGENT_GATEWAY_HANDOVER_KEY_HEADER = 'x-para-code-gateway-handover-key';

/** 受け口が手元へ流す要求に付ける印。手元は、同期前のトークンを抱えて待たずにすぐ答える。 */
export const PARADIS_AGENT_GATEWAY_REQUEST_HEADER = 'x-para-code-gateway';
/** 手元が「このトークンはまだ同期していないだけかもしれない」と答えるときの印（503 に付ける）。 */
export const PARADIS_AGENT_GATEWAY_UNSYNCED_HEADER = 'x-para-code-unsynced';

/**
 * 受け口が、本体を送る前に手元の生存を確かめる GET のパス。手元の `PARADIS_MCP_HEALTH_PATH` と同じ値
 * （あちらは道具の定義ごと読み込むファイルにあるので、接続先のサーバーへは持ち込まず、テストで一致を確かめる）。
 */
export const PARADIS_AGENT_GATEWAY_PROBE_PATH = '/paradis-mcp/health';

/** 待たせる上限。エージェントの道具の制限（300 秒）より短い。 */
export const PARADIS_AGENT_GATEWAY_WAIT_LIMIT_MS = 120_000;

/**
 * 待たせる上限を、要求の側から短くするヘッダー（秒。{@link PARADIS_AGENT_GATEWAY_WAIT_LIMIT_MS} より長くはならない）。
 * `para` コマンドが、自分の待てる残りの時間を伝えるのに使う（エージェントのシェルの制限より先に答えを返すため）。
 */
export const PARADIS_AGENT_GATEWAY_WAIT_SECONDS_HEADER = 'x-para-code-gateway-wait-seconds';

/**
 * 手元が、要求を処理した後で「このペインはもう今のものではない」と断るとき（404）に付ける印。処理の前に断る 404
 * （知らないトークン）と違い、道具はもう走ったかもしれない。受け口はこの 404 を聞き直さずにそのまま返し、`para` コマンドは
 * 操作を送り直さない。
 */
export const PARADIS_AGENT_GATEWAY_AFTER_DISPATCH_HEADER = 'x-para-code-after-dispatch';

/** 受け口が打ち切ったときの応答に載せる符丁。 */
export const PARADIS_AGENT_GATEWAY_TIMEOUT_CODE = 'para-code-window-not-connected';

/** 受け口の番号の候補の帯（戻りトンネルの候補と同じ。well-known でも Linux の既定の ephemeral でもない）。 */
export const PARADIS_AGENT_GATEWAY_PORT_BASE = 20_000;
export const PARADIS_AGENT_GATEWAY_PORT_RANGE = 32_768 - PARADIS_AGENT_GATEWAY_PORT_BASE;
/** 候補が他のプログラムに取られていたとき、続けて試す番号の数。 */
export const PARADIS_AGENT_GATEWAY_PORT_ATTEMPTS = 8;

/** 窓が受け取る受け口の場所。 */
export interface IParadisAgentGatewayEndpoint {
	readonly port: number;
	readonly version: number;
}

export interface IParadisAgentGatewayService {
	/** 今の受け口の番号。受け口が無い（番号を取れなかった）なら undefined。 */
	getEndpoint(): Promise<IParadisAgentGatewayEndpoint | undefined>;
}

/** {@link PARADIS_AGENT_GATEWAY_FILE_NAME} の中身。 */
export interface IParadisAgentGatewayFile {
	readonly protocolVersion: number;
	readonly port: number;
	/** 番号を持っているサーバーの PID。 */
	readonly pid: number;
	readonly gatewayVersion: number;
	/** 譲り受けの合い言葉。 */
	readonly handoverKey: string;
}

function isPort(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
}

/** 受け口のファイルを読む。壊れている・知らない版なら undefined。 */
export function paradisParseAgentGatewayFile(raw: string): IParadisAgentGatewayFile | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as { readonly [K in keyof IParadisAgentGatewayFile]?: unknown };
	if (record.protocolVersion !== PARADIS_AGENT_GATEWAY_FILE_PROTOCOL_VERSION
		|| !isPort(record.port)
		|| typeof record.pid !== 'number'
		|| typeof record.gatewayVersion !== 'number'
		|| typeof record.handoverKey !== 'string' || record.handoverKey.length < 16) {
		return undefined;
	}
	return {
		protocolVersion: PARADIS_AGENT_GATEWAY_FILE_PROTOCOL_VERSION,
		port: record.port,
		pid: record.pid,
		gatewayVersion: record.gatewayVersion,
		handoverKey: record.handoverKey,
	};
}

/**
 * ポートファイル（`{ protocolVersion, port }`）から番号を読む。
 * ポートファイルは原子的に書かれないので、空・書きかけ・壊れた中身は「まだ」と扱い undefined を返す。
 */
export function paradisParseAgentGatewayPortFile(raw: string): number | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const port = typeof value === 'object' && value !== null ? (value as { readonly port?: unknown }).port : undefined;
	return isPort(port) ? port : undefined;
}

/**
 * 試す番号の順。前に使っていた番号（ファイルの記録）を先に、続けて決まった候補から順に並べる。
 * @param seed 候補を決める 16 ビットの値（接続先のホームから作る）
 */
export function paradisAgentGatewayPortCandidates(seed: number, recordedPort: number | undefined): number[] {
	const candidates: number[] = [];
	if (isPort(recordedPort)) {
		candidates.push(recordedPort);
	}
	for (let i = 0; i < PARADIS_AGENT_GATEWAY_PORT_ATTEMPTS; i++) {
		const port = PARADIS_AGENT_GATEWAY_PORT_BASE + ((seed + i) % PARADIS_AGENT_GATEWAY_PORT_RANGE);
		if (!candidates.includes(port)) {
			candidates.push(port);
		}
	}
	return candidates;
}
