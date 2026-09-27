/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 復元したターミナルタブから前の会話を続ける（Q53 案B・Q54 案A）ための台帳と、コマンドの組み立て。
//
// Para Code を終了して開き直すと、エディタのターミナルタブは中身ごと戻るが、中で動いていた
// Claude Code / Codex は終了してシェルに戻っている。そのタブで何の会話が動いていたかを、
// ペイントークン（シェル統合の nonce。再起動をまたいで変わらない）ごとに控えておく。

import { PARADIS_RESUME_SESSION_ID_PATTERN, ParadisResumeAgent } from '../../sessionResume/common/paradisSessionResume.js';

/** 1つのタブで最後に動いていた会話。 */
export interface IParadisResumeLedgerEntry {
	readonly agent: ParadisResumeAgent;
	readonly sessionId: string;
	/** 会話を始めたフォルダ（hook が報告したもの）。分岐のターミナルをここで開く。 */
	readonly cwd?: string;
	/** タブの見出しに出ていた会話の名前。 */
	readonly title?: string;
	/** 最後に動いていた時刻 (epoch ms)。 */
	readonly at: number;
}

/** 台帳の上限。古いものから捨てる。 */
export const PARADIS_RESUME_LEDGER_MAX_ENTRIES = 200;
/** これより古い会話は案内しない（CLI 側の履歴も消えていることが多い）。 */
export const PARADIS_RESUME_LEDGER_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function isAgent(value: unknown): value is ParadisResumeAgent {
	return value === 'claude' || value === 'codex';
}

/** 保存した台帳を読む。壊れた行は捨て、期限切れと上限超えも落とす。 */
export function paradisParseResumeLedger(raw: string | undefined, now: number): Map<string, IParadisResumeLedgerEntry> {
	const result = new Map<string, IParadisResumeLedgerEntry>();
	if (!raw) {
		return result;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return result;
	}
	if (!Array.isArray(parsed)) {
		return result;
	}
	for (const item of parsed) {
		if (typeof item !== 'object' || item === null) {
			continue;
		}
		const { token, agent, sessionId, cwd, title, at } = item as Record<string, unknown>;
		if (typeof token !== 'string' || token.length === 0 || token.length > 200
			|| !isAgent(agent)
			|| typeof sessionId !== 'string' || !PARADIS_RESUME_SESSION_ID_PATTERN.test(sessionId)
			|| typeof at !== 'number' || !Number.isFinite(at) || now - at > PARADIS_RESUME_LEDGER_TTL_MS) {
			continue;
		}
		result.set(token, {
			agent,
			sessionId,
			at,
			...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
			...(typeof title === 'string' && title.length > 0 ? { title: title.slice(0, 200) } : {}),
		});
	}
	return paradisTrimResumeLedger(result, now);
}

/** 期限切れを落とし、新しい順に上限まで残す。 */
export function paradisTrimResumeLedger(ledger: ReadonlyMap<string, IParadisResumeLedgerEntry>, now: number): Map<string, IParadisResumeLedgerEntry> {
	const fresh = [...ledger].filter(([, entry]) => now - entry.at <= PARADIS_RESUME_LEDGER_TTL_MS);
	fresh.sort(([, left], [, right]) => right.at - left.at);
	return new Map(fresh.slice(0, PARADIS_RESUME_LEDGER_MAX_ENTRIES));
}

export function paradisSerializeResumeLedger(ledger: ReadonlyMap<string, IParadisResumeLedgerEntry>): string {
	return JSON.stringify([...ledger].map(([token, entry]) => ({ token, ...entry })));
}

/**
 * 会話を続ける（`resume`）／分岐する（`fork`、CLI の fork で会話ごと複製する）コマンド。
 * ID はホワイトリスト（先頭に `-` を許さない）を通ったものだけを使い、シェルの特殊文字を含まない。
 * 通らなければ undefined。
 */
export function paradisResumeCommandLine(agent: ParadisResumeAgent, sessionId: string, mode: 'resume' | 'fork'): string | undefined {
	if (!PARADIS_RESUME_SESSION_ID_PATTERN.test(sessionId)) {
		return undefined;
	}
	if (agent === 'claude') {
		return mode === 'fork' ? `claude --resume ${sessionId} --fork-session` : `claude --resume ${sessionId}`;
	}
	return mode === 'fork' ? `codex fork ${sessionId}` : `codex resume ${sessionId}`;
}

/**
 * タブの見出しから会話の名前を取り出す。Claude Code は作業中の印（回転する点字や ✳）を先頭に
 * 付けるので落とす。シェル名・エージェント名だけのもの、Codex のスレッド ID は名前として使わない。
 */
export function paradisResumeTitleFromTab(title: string): string | undefined {
	const trimmed = title.replace(/^[⠀-⣿✀-➿•·●*\s]+/u, '').trim();
	if (trimmed.length === 0
		|| /^(zsh|bash|fish|sh|pwsh|powershell|cmd|node|claude|claude code|codex)$/i.test(trimmed)
		|| /^(?:codex \| )?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
		return undefined;
	}
	return trimmed.slice(0, 200);
}

/** Codex が起動直後にタイトルへ出すスレッド ID（`codex | <uuid>`）。 */
export function paradisCodexThreadIdFromTitle(title: string): string | undefined {
	return /^(?:codex \| )?([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(title.trim())?.[1];
}

/**
 * 復元したタブで、前に動いていたエージェントがもう居ないか。
 *
 * ウィンドウの再読み込みではシェル（とその中のエージェント）が生きたまま繋ぎ直されるので
 * プロセス ID は変わらない。Para Code を終了して開き直した場合はシェルを作り直すので変わる。
 * 常駐ターミナルが引き取った（`paradisAdopted`）シェルはエージェントごと生きている。
 */
export function paradisRestoredShellWasRestarted(previousPid: number | undefined, currentPid: number | undefined, adopted: boolean): boolean {
	return !adopted && previousPid !== undefined && previousPid > 0 && currentPid !== undefined && currentPid !== previousPid;
}
