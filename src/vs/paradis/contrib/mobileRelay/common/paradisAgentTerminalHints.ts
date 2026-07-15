/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

const RAW_BUFFER_LIMIT = 16_384;
const NORMALIZED_BUFFER_LIMIT = 4_096;
const SCAN_INTERVAL_MS = 400;
const EMIT_INTERVAL_MS = 800;

export interface IParadisAgentTerminalHint {
	readonly elapsedSeconds?: number;
	readonly tokenCount?: number;
}

/** 高頻度出力経路のscan/正規化回数を検証するための計測hook。 */
export interface IParadisAgentTerminalHintParserMetrics {
	readonly onScan?: () => void;
	readonly onNormalize?: () => void;
}

/** 非Agent端末ではparserへ入る前に定数時間で打ち切る。 */
export function paradisShouldAcceptAgentTerminalHint(enabled: boolean, paneToken: string | undefined, isAgentPane: boolean): boolean {
	return enabled && paneToken !== undefined && isAgentPane;
}

export function stripTerminalControls(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function parseElapsed(value: string): number | undefined {
	const hours = /(?<hours>\d+)h/.exec(value)?.groups?.['hours'];
	const minutes = /(?<minutes>\d+)m/.exec(value)?.groups?.['minutes'];
	const seconds = /(?<seconds>\d+)s/.exec(value)?.groups?.['seconds'];
	if (hours === undefined && minutes === undefined && seconds === undefined) {
		return undefined;
	}
	return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

function parseTokenCount(value: string): number | undefined {
	const match = /(?<value>\d+(?:\.\d+)?)\s*(?<unit>[kKmM]?)\s*tokens?\b/.exec(value);
	if (match?.groups === undefined) {
		return undefined;
	}
	const amount = Number(match.groups['value']);
	const unit = match.groups['unit'].toLowerCase();
	const multiplier = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1;
	return Number.isFinite(amount) ? Math.round(amount * multiplier) : undefined;
}

/**
 * PTY出力の生バイト列から、CLIが画面に出した経過時間/トークン数だけをbest-effort抽出する。
 * 状態の開始・終了や本文には使わず、hook/transcriptで確定済みのライブ状態を装飾するだけ。
 */
export class ParadisAgentTerminalHintParser {
	private rawChunks: string[] = [];
	private rawChunkHead = 0;
	private rawLength = 0;
	private normalizedBuffer = '';
	private lastFingerprint: string | undefined;
	private lastScannedAt = 0;
	private lastEmittedAt = 0;

	constructor(
		private readonly now: () => number = Date.now,
		private readonly metrics?: IParadisAgentTerminalHintParserMetrics,
	) { }

	/** buffer上限の回帰検証に使う現在のraw tail長。 */
	get rawBufferLength(): number { return this.rawLength; }
	/** buffer上限の回帰検証に使う現在のnormalized tail長。 */
	get normalizedBufferLength(): number { return this.normalizedBuffer.length; }

	/** Agent command世代終了時に、前世代の画面tailとdedupe状態を完全に破棄する。 */
	reset(): void {
		this.rawChunks = [];
		this.rawChunkHead = 0;
		this.rawLength = 0;
		this.normalizedBuffer = '';
		this.lastFingerprint = undefined;
		this.lastScannedAt = 0;
		this.lastEmittedAt = 0;
	}

	accept(data: string): IParadisAgentTerminalHint | undefined {
		this.append(data);
		const now = this.now();
		if (now - this.lastScannedAt < SCAN_INTERVAL_MS) {
			return undefined;
		}
		return this.scanAt(now);
	}

	/** timer-latched production hot path向け。Date.nowや正規化を行わずraw tailだけ更新する。 */
	append(data: string): void {
		this.appendRawTail(data);
	}

	/** timerがscanDueへ遷移した後だけ呼ぶ。時刻参照・正規化・抽出を1回行う。 */
	scan(): IParadisAgentTerminalHint | undefined {
		return this.scanAt(this.now());
	}

	private scanAt(now: number): IParadisAgentTerminalHint | undefined {
		this.lastScannedAt = now;
		this.metrics?.onScan?.();
		const rawTail = this.rawChunks.slice(this.rawChunkHead).join('');
		this.normalizedBuffer = stripTerminalControls(rawTail).slice(-NORMALIZED_BUFFER_LIMIT);
		this.metrics?.onNormalize?.();
		// Codexは `Working (1m 02s • esc to interrupt)`。旧Claude/Omnara互換として
		// `esc to interrupt` / `ctrl+b to run in background` を含む末尾も補助対象にする。
		const codexMatches = [...this.normalizedBuffer.matchAll(/Working\s+\((?<meta>[^)]*?)\s*•\s*esc to interrupt\)/gi)];
		const codexMeta = codexMatches.at(-1)?.groups?.['meta'];
		const activeMarker = codexMeta !== undefined
			|| /esc to interrupt|ctrl\+b to run in background/i.test(this.normalizedBuffer.slice(-1_000));
		if (!activeMarker) {
			return undefined;
		}
		const recent = this.normalizedBuffer.slice(-1_000);
		const elapsedSeconds = codexMeta !== undefined ? parseElapsed(codexMeta) : parseElapsed(recent);
		const tokenCount = parseTokenCount(recent);
		if (elapsedSeconds === undefined && tokenCount === undefined) {
			return undefined;
		}
		const fingerprint = `${elapsedSeconds ?? ''}:${tokenCount ?? ''}`;
		if (fingerprint === this.lastFingerprint || now - this.lastEmittedAt < EMIT_INTERVAL_MS) {
			return undefined;
		}
		this.lastFingerprint = fingerprint;
		this.lastEmittedAt = now;
		return {
			...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
			...(tokenCount !== undefined ? { tokenCount } : {}),
		};
	}

	/**
	 * 毎chunkで既存16KiBを再連結せず、末尾chunk列と先頭indexだけを更新する。
	 * 先頭の部分切り詰め・配列compactはいずれも償却O(1)、文字列全体の実体化はscan時だけ。
	 */
	private appendRawTail(data: string): void {
		if (data.length === 0) {
			return;
		}
		if (data.length >= RAW_BUFFER_LIMIT) {
			this.rawChunks = [data.slice(-RAW_BUFFER_LIMIT)];
			this.rawChunkHead = 0;
			this.rawLength = RAW_BUFFER_LIMIT;
			return;
		}
		this.rawChunks.push(data);
		this.rawLength += data.length;
		let excess = this.rawLength - RAW_BUFFER_LIMIT;
		while (excess > 0) {
			const first = this.rawChunks[this.rawChunkHead];
			if (first.length <= excess) {
				this.rawChunkHead++;
				this.rawLength -= first.length;
				excess -= first.length;
				continue;
			}
			this.rawChunks[this.rawChunkHead] = first.slice(excess);
			this.rawLength -= excess;
			excess = 0;
		}
		if (this.rawChunkHead >= 64 && this.rawChunkHead * 2 >= this.rawChunks.length) {
			this.rawChunks = this.rawChunks.slice(this.rawChunkHead);
			this.rawChunkHead = 0;
		}
	}
}
