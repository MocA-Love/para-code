/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの「まだ応答がありません（待つ / 中止）」の、main と renderer で共有する決まりと、
// Sentry へ送る中身を作る純関数。見張り本体は platform/browserView/electron-main/paraBrowserViewLoadWatchdog.ts。
//
// Sentry には URL そのものを送らない。送るのは URL の種類（loopback / 私設 / 外部、http / https）、
// 接続先の種類（ssh-remote など `+` より前だけ。後ろにはホスト名が入る）、トンネルの有無、経過時間、
// 待った回数、メモリの数字だけ。

import { IParaBrowserViewLoadStall, ParaBrowserViewLoadStallOutcome } from '../../../../platform/browserView/common/paraBrowserViewLoadStall.js';
import type { ParadisDiagnosticSafeData } from '../../sentry/common/paradisSentryDiagnostics.js';

export const PARADIS_BROWSER_LOAD_STALL_CHANNEL = 'paradisBrowserLoadStall';

/** チャネルのイベント（どのビューが質問を出した / 引っ込めたか）。 */
export interface IParadisBrowserLoadStallChange {
	readonly viewId: string;
	readonly stall: IParaBrowserViewLoadStall | undefined;
}

/** 読み込みを始めてから `now` までの時間。質問を出した時刻より前の時計には戻らない。 */
export function paradisBrowserLoadStallElapsed(stall: IParaBrowserViewLoadStall, now: number): number {
	return stall.elapsedMs + Math.max(0, now - stall.askedAt);
}

export type ParadisBrowserUrlScheme = 'http' | 'https' | 'other';
export type ParadisBrowserUrlHostKind = 'loopback' | 'private-network' | 'public' | 'none';

/** URL を種類に畳む。ホスト名・パス・クエリは返さない。 */
export function paradisClassifyBrowserUrl(url: string): { readonly scheme: ParadisBrowserUrlScheme; readonly hostKind: ParadisBrowserUrlHostKind } {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { scheme: 'other', hostKind: 'none' };
	}
	const scheme: ParadisBrowserUrlScheme = parsed.protocol === 'http:' ? 'http' : parsed.protocol === 'https:' ? 'https' : 'other';
	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (!host) {
		return { scheme, hostKind: 'none' };
	}
	return { scheme, hostKind: paradisClassifyHost(host) };
}

function paradisClassifyHost(host: string): ParadisBrowserUrlHostKind {
	if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || host === '::') {
		return 'loopback';
	}
	const ipv4 = /^(?<a>\d{1,3})\.(?<b>\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
	if (ipv4?.groups) {
		const a = Number(ipv4.groups.a);
		const b = Number(ipv4.groups.b);
		if (a === 127) {
			return 'loopback';
		}
		if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) {
			return 'private-network';
		}
		return 'public';
	}
	if (host.includes(':')) {
		// IPv6: ULA (fc00::/7) とリンクローカル (fe80::/10) を私設として扱う。
		if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) {
			return 'private-network';
		}
		// IPv4 を写した IPv6（::ffff:127.0.0.1）。URL は ::ffff:7f00:1 の形に直すので、両方を IPv4 に戻して判定する。
		const mapped = /^::ffff:(?:(?<dotted>\d{1,3}(?:\.\d{1,3}){3})|(?<hi>[0-9a-f]{1,4}):(?<lo>[0-9a-f]{1,4}))$/.exec(host);
		if (mapped?.groups) {
			const { dotted, hi, lo } = mapped.groups;
			if (dotted) {
				return paradisClassifyHost(dotted);
			}
			const high = parseInt(hi, 16);
			const low = parseInt(lo, 16);
			return paradisClassifyHost(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
		}
		return 'public';
	}
	// 点の無い名前（社内の短い名前）や mDNS / 社内向けの末尾は、外へ出ない名前として扱う。
	if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
		return 'private-network';
	}
	return 'public';
}

/** 送ってよい接続先の種類（authority の `+` より前）。これ以外は `other` に畳む。 */
const KNOWN_REMOTE_KINDS: ReadonlySet<string> = new Set(['ssh-remote', 'wsl', 'dev-container', 'attached-container', 'tunnel', 'codespaces', 'k8s-container']);

/** ウィンドウの接続先の種類。ローカルなら `none`。 */
export function paradisBrowserRemoteKind(remoteAuthority: string | undefined): string {
	if (!remoteAuthority) {
		return 'none';
	}
	const plus = remoteAuthority.indexOf('+');
	const kind = (plus === -1 ? remoteAuthority : remoteAuthority.substring(0, plus)).toLowerCase();
	return KNOWN_REMOTE_KINDS.has(kind) ? kind : 'other';
}

/** 見張りから受け取った1回分（URL は種類に畳む前の生のもの）。 */
export interface IParadisBrowserLoadStallFacts {
	readonly outcome: ParaBrowserViewLoadStallOutcome;
	readonly url: string;
	readonly elapsedMs: number;
	readonly waits: number;
	readonly remoteAuthority: string | undefined;
	readonly tunnelProxy: boolean;
	readonly agentTab: boolean;
	/** 止まった時点のメモリ（MB）。キーは {@link PARADIS_BROWSER_LOAD_STALL_SAMPLE_KEYS} のどれか。 */
	readonly sample: Readonly<Record<string, number>>;
}

/** メモリの数字として受け付けるキー。見張りから来た任意のキーをそのまま送らないための一覧。 */
export const PARADIS_BROWSER_LOAD_STALL_SAMPLE_KEYS = ['safe_main_rss_mb', 'safe_system_free_mb', 'safe_system_total_mb', 'safe_page_memory_mb', 'safe_app_memory_mb'] as const;

/** Sentry に1件として送る形。 */
export interface IParadisBrowserLoadStallEvent {
	readonly operation: string;
	readonly tags: Record<`para.${string}`, string>;
	readonly data: ParadisDiagnosticSafeData;
}

export function paradisBuildBrowserLoadStallEvent(facts: IParadisBrowserLoadStallFacts): IParadisBrowserLoadStallEvent {
	const { scheme, hostKind } = paradisClassifyBrowserUrl(facts.url);
	const remoteKind = paradisBrowserRemoteKind(facts.remoteAuthority);
	const data: ParadisDiagnosticSafeData = {
		safe_outcome: facts.outcome,
		safe_elapsed_ms: Math.max(0, Math.round(facts.elapsedMs)),
		safe_waits: Math.max(0, Math.round(facts.waits)),
		safe_url_scheme: scheme,
		safe_url_host_kind: hostKind,
		safe_remote_kind: remoteKind,
		safe_tunnel_proxy: facts.tunnelProxy,
		safe_agent_tab: facts.agentTab,
	};
	for (const key of PARADIS_BROWSER_LOAD_STALL_SAMPLE_KEYS) {
		const value = facts.sample[key];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
			data[key] = Math.round(value);
		}
	}
	return {
		// 結果ごとに指紋を分ける（同じ指紋は10分3件まで。止めた例が答えた例の枠を使い切らないように）。
		operation: `load-stall-${facts.outcome}`,
		tags: {
			'para.browser_load_outcome': facts.outcome,
			'para.browser_url_host_kind': hostKind,
			'para.browser_remote_kind': remoteKind,
		},
		data,
	};
}
