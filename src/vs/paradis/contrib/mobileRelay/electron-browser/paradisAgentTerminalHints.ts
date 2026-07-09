/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

const BUFFER_LIMIT = 4_096;
const SCAN_INTERVAL_MS = 400;
const EMIT_INTERVAL_MS = 800;

export interface IParadisAgentTerminalHint {
	readonly elapsedSeconds?: number;
	readonly tokenCount?: number;
}

function stripTerminalControls(text: string): string {
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
	private buffer = '';
	private lastFingerprint: string | undefined;
	private lastScannedAt = 0;
	private lastEmittedAt = 0;

	accept(data: string): IParadisAgentTerminalHint | undefined {
		this.buffer = (this.buffer + stripTerminalControls(data)).slice(-BUFFER_LIMIT);
		const now = Date.now();
		if (now - this.lastScannedAt < SCAN_INTERVAL_MS) {
			return undefined;
		}
		this.lastScannedAt = now;
		// Codexは `Working (1m 02s • esc to interrupt)`。旧Claude/Omnara互換として
		// `esc to interrupt` / `ctrl+b to run in background` を含む末尾も補助対象にする。
		const codexMatches = [...this.buffer.matchAll(/Working\s+\((?<meta>[^)]*?)\s*•\s*esc to interrupt\)/gi)];
		const codexMeta = codexMatches.at(-1)?.groups?.['meta'];
		const activeMarker = codexMeta !== undefined
			|| /esc to interrupt|ctrl\+b to run in background/i.test(this.buffer.slice(-1_000));
		if (!activeMarker) {
			return undefined;
		}
		const recent = this.buffer.slice(-1_000);
		const elapsedSeconds = codexMeta !== undefined ? parseElapsed(codexMeta) : parseElapsed(recent);
		const tokenCount = parseTokenCount(recent);
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
}
