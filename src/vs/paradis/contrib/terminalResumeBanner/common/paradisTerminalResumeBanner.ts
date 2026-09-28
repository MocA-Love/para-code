/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 復元したターミナルタブから前の会話を続けるための台帳と、コマンドの組み立て。
//
// Para Code を終了して開き直すと、エディタのターミナルタブは中身ごと戻るが、中で動いていた
// Claude Code / Codex は終了してシェルに戻っている。そのタブで何の会話が動いていたかを、
// ペイントークン（シェル統合の nonce。再起動をまたいで変わらない）ごとに控えておく。

import { DeferredPromise, raceTimeout, timeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { PARADIS_RESUME_SESSION_ID_PATTERN, ParadisResumeAgent, paradisAgentResumeCommandLine } from '../../sessionResume/common/paradisSessionResume.js';
import { paradisCodexThreadIdFromTerminalTitle } from '../../codexTerminalTitle/common/paradisCodexTerminalTitle.js';

const LEDGER_KEY_PATTERN = /^[0-9a-f]{40}$/;

/**
 * 台帳のキー（ペイントークンのハッシュ）。ペイントークンは MCP やペインの app-server の Bearer を
 * 兼ねるので、平文ではディスクへ書かない。同期で引けることが要る（タブの切り替えのたびに引く）
 * ので SHA-1 を使う。目的は「読めても元のトークンに戻せない」ことで、衝突への強さは要らない。
 */
export function paradisResumeLedgerKey(token: string): string {
	const sha = new StringSHA1();
	sha.update(`paradis-resume-ledger:${token}`);
	return sha.digest();
}

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
		// 前の版はトークンをそのままキーにしていた。読んだ時点でハッシュへ置き換える。
		result.set(LEDGER_KEY_PATTERN.test(token) ? token : paradisResumeLedgerKey(token), {
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
	return paradisAgentResumeCommandLine(agent, sessionId, mode);
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
	return paradisCodexThreadIdFromTerminalTitle(title.trim());
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

/**
 * 会話を始めたフォルダ（台帳の `cwd`）と、タブのシェルの今のフォルダが違うか。
 *
 * 違うまま `claude --resume` を送ると、Claude Code は会話を今のフォルダのプロジェクトへ複製して
 * 続けてしまう（別のスペースのフォルダで起き直したタブで実際に起きた）。記録が無ければ比べようが
 * ないので違わない扱い、今のフォルダが分からなければ違う扱い（移ってから再開する方が安全）にする。
 * 末尾の区切りは無視し、Windows のパス（ドライブ文字）は大文字小文字を区別しない。
 */
export function paradisResumeNeedsFolderChange(recordedCwd: string | undefined, currentCwd: string | undefined): boolean {
	if (recordedCwd === undefined || recordedCwd.length === 0) {
		return false;
	}
	if (currentCwd === undefined || currentCwd.length === 0) {
		return true;
	}
	return comparablePath(recordedCwd) !== comparablePath(currentCwd);
}

function comparablePath(path: string): string {
	const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
	const normalized = trimmed.length === 0 ? path : trimmed;
	return /^[a-zA-Z]:/.test(normalized) ? normalized.replace(/\//g, '\\').toLowerCase() : normalized;
}

/** 再開の前に会話のフォルダへ移るとき、シェルとのやりとりに使う口（テストで差し替えられるように分けてある）。 */
export interface IParadisChangeDirectoryDriver {
	/** コマンドが終わった（シェル統合の終了の知らせ）。 */
	readonly onCommandFinished: Event<{ readonly exitCode: number | undefined }>;
	/** 次のプロンプトで入力を受け付け始めた（シェル統合の入力開始の知らせ）。 */
	readonly onPromptInputStarted: Event<unknown>;
	/** ターミナルへ入った入力。自分で送ったコマンドも流れてくる。 */
	readonly onInput: Event<string>;
	send(text: string): Promise<void>;
	/** 前面にプログラムが居らず、入力欄が空か。 */
	isAtEmptyPrompt(): boolean;
	/** 今のフォルダが移り先になっているか（少し待ってよい）。 */
	confirmFolder(): Promise<boolean>;
}

/**
 * - `moved`: 移れて、次のプロンプトが入力を待っていて、その間に打たれた文字も無い
 * - `failed`: `cd` が失敗した、時間切れ、フォルダが変わらなかった
 * - `typed`: 移れたが、その間に打たれた文字がある（再開コマンドを続けて送ると、その文字とつながって実行される）
 * - `not-ready`: 移れたが、次のプロンプトが入力を受け付け始めたことを確かめられなかった
 */
export type ParadisChangeDirectoryOutcome = 'moved' | 'failed' | 'typed' | 'not-ready';

export interface IParadisChangeDirectoryTiming {
	readonly finishMs: number;
	readonly promptMs: number;
	/** プロンプトの入力開始の後に待つ時間。先に打たれていた文字をシェルが読み込んで表示し終えるまで。 */
	readonly settleMs: number;
}

export const PARADIS_CHANGE_DIRECTORY_TIMING: IParadisChangeDirectoryTiming = { finishMs: 5_000, promptMs: 2_000, settleMs: 250 };

/**
 * `cd` を送り、次のプロンプトが入力を待つ状態になって落ち着くまで見届ける。
 *
 * `cd` の終了だけ見て再開コマンドを送ってはいけない。`cd` の最中に打たれた文字は端末の入力
 * バッファに溜まっていて、シェルが次のプロンプトで読み込むまで入力欄には現れない。その時点で
 * 「空」と判定して送ると、先打ちの文字と再開コマンドがつながり、Enter を押していないのに実行
 * される（実機で確認）。速い `cd` でも、プロンプトの描画前に送るとエコーが1行余分に出る。
 * そこで、終了 → 次のプロンプトの入力開始 → 少し待つ、の後で、途中に打たれた文字が無く入力欄が
 * 空であることを確かめる。打たれた文字の判定は入力そのものも見る（入力欄の読み取りより早く分かる）。
 * エスケープで始まる入力（端末の自動応答、フォーカスの知らせ、矢印キー）は文字として数えない。
 * 矢印キーで履歴を呼び出した場合は、最後の入力欄の確認で止まる。
 */
export async function paradisChangeDirectoryBeforeResume(driver: IParadisChangeDirectoryDriver, command: string, timing: IParadisChangeDirectoryTiming = PARADIS_CHANGE_DIRECTORY_TIMING): Promise<ParadisChangeDirectoryOutcome> {
	const store = new DisposableStore();
	const finished = new DeferredPromise<{ readonly exitCode: number | undefined }>();
	const promptStarted = new DeferredPromise<void>();
	let finishSeen = false;
	let typed = false;
	let ownInput: string | undefined = command.endsWith('\r') ? command : `${command}\r`;
	store.add(driver.onCommandFinished(result => {
		if (!finishSeen) {
			finishSeen = true;
			void finished.complete(result);
		}
	}));
	// 終了と次のプロンプトの入力開始は同じデータのかたまりで届くことが多いので、終了を見てから
	// 購読したのでは取りこぼす。先に購読しておき、終了より後のものだけを数える。
	store.add(driver.onPromptInputStarted(() => {
		if (finishSeen) {
			void promptStarted.complete();
		}
	}));
	store.add(driver.onInput(data => {
		if (ownInput !== undefined && data === ownInput) {
			ownInput = undefined;
			return;
		}
		if (data.length > 0 && !data.startsWith('\x1b')) {
			typed = true;
		}
	}));
	try {
		await driver.send(command);
		const result = await raceTimeout(finished.p, timing.finishMs);
		if (result === undefined || (result.exitCode !== undefined && result.exitCode !== 0)) {
			return 'failed';
		}
		if (!await driver.confirmFolder()) {
			return 'failed';
		}
		if (await raceTimeout(promptStarted.p.then(() => true), timing.promptMs) !== true) {
			return 'not-ready';
		}
		await timeout(timing.settleMs);
		return typed || !driver.isAtEmptyPrompt() ? 'typed' : 'moved';
	} finally {
		store.dispose();
	}
}
