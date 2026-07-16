/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントhookの「発信元プロセス所有権」分類。
//
// ペイントークン (PARA_CODE_TERMINAL_PANE_ID) はターミナル配下の全子プロセスへ環境変数として
// 継承されるため、ペインのルートエージェント（例: Claude Code）が子プロセスとして別エージェント
// （例: plugin 経由の `codex exec`）を起動すると、子のhookも親と同じトークンで届く。
// これを無検証で受けると、ペインの親セッションが子のtranscriptへ乗っ取られ（モバイルの
// 「親セッションが切り替わりました」）、子の Stop が親ペインの完了通知を誤発火させる。
//
// 対策として notify スクリプト (schema v3) が自身のPIDを併送し、shared process 側が
// プロセス祖先チェーンから「transcriptのエージェント種別と一致する最も近いエージェント
// プロセス (emitter)」を特定して、ペインごとの所有者と照合する:
//   - emitter が現所有者と同一プロセス (PID+開始時刻) → owner（/clear 等のrebindも許可）
//   - 現所有者が emitter の祖先に生存           → nested（子エージェント。状態を汚染させない）
//   - 現所有者が死亡/PID再利用                  → owner を昇格
//   - 現所有者が生存しているのに祖先にいない     → invalid（誤配送。破棄）
// PIDが取れない場合（旧スクリプト・プロセス消滅・ps失敗）は fail-closed:
// 既知の所有者と同じtranscriptへのイベントだけを通す。

import { exec } from 'child_process';
import { promisify } from 'util';
import { sep } from '../../../../base/common/path.js';
import { paradisCodexHome } from './paradisAgentHome.js';

const execAsync = promisify(exec);

const EXEC_TIMEOUT_MS = 5_000;
/** プロセス表スナップショットの再利用時間。hookのバーストで ps/CIM 実行を連発させない。 */
const SNAPSHOT_TTL_MS = 2_000;
/** 祖先チェーンの探索上限（wrapper シェルの多段起動を考慮しても十分な深さ）。 */
const MAX_ANCESTOR_DEPTH = 15;
/** 所有者レコードの上限（ペイン数を大きく超える値。無制限な成長の防止のみが目的）。 */
const MAX_OWNER_RECORDS = 4_096;

export type ParadisHookAgentKind = 'claude' | 'codex';

export type ParadisHookOrigin = 'owner' | 'nested' | 'invalid';

/** プロセス表スナップショットの1行。 */
export interface IParadisHookProcessInfo {
	readonly pid: number;
	readonly ppid: number | undefined;
	/** プロセス開始時刻由来の識別子（PID再利用の検出に使う。取得不能なら undefined）。 */
	readonly startKey: string | undefined;
	readonly command: string;
}

/** プロセス表の取得（テストではfakeへ差し替える）。 */
export interface IParadisHookProcessInspector {
	snapshot(): Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined>;
}

interface IOwnerRecord {
	pid: number | undefined;
	startKey: string | undefined;
	agentKind: ParadisHookAgentKind | undefined;
	transcriptPath: string | undefined;
	at: number;
}

/** transcript_path からエージェント種別を判定する（mobileRelay 側の判定と同一規約）。 */
export function paradisHookAgentKindForTranscript(transcriptPath: string): ParadisHookAgentKind {
	if (/[\\/]\.codex[\\/]/.test(transcriptPath) || /[\\/]rollout-[^\\/]*\.jsonl$/.test(transcriptPath)) {
		return 'codex';
	}
	const codexHome = paradisCodexHome();
	return (transcriptPath === codexHome || transcriptPath.startsWith(codexHome + sep)) ? 'codex' : 'claude';
}

/** インタープリタ等、エージェント本体ではないコマンド名。 */
const NON_AGENT_BASENAMES = new Set(['node', 'bun', 'deno', 'sh', 'bash', 'zsh', 'fish', 'dash', 'env', 'powershell', 'pwsh', 'cmd']);

/**
 * プロセスのコマンドラインからエージェント種別を推定する。
 * 「claude」「codex」という basename のトークン（実行ファイルまたはスクリプト引数）を探す。
 * `codex-companion.mjs` や `.claude/...` のようなパス断片には一致しない。
 */
export function paradisHookAgentKindFromCommandLine(command: string): ParadisHookAgentKind | undefined {
	for (const rawToken of command.split(/\s+/)) {
		const token = rawToken.replace(/^["']+|["']+$/g, '');
		if (token.length === 0 || token.startsWith('-')) {
			continue;
		}
		const basename = token.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
		const normalized = basename.toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, '');
		if (normalized === 'claude') {
			return 'claude';
		}
		if (normalized === 'codex') {
			return 'codex';
		}
		if (NON_AGENT_BASENAMES.has(normalized)) {
			continue;
		}
	}
	return undefined;
}

/** POSIX: `ps ax` 1回でプロセス表を取得する（LC_ALL=C で lstart を5トークン固定にする）。 */
async function posixProcessSnapshot(): Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined> {
	try {
		const { stdout } = await execAsync('ps ax -o pid=,ppid=,lstart=,command= 2>/dev/null || true', {
			timeout: EXEC_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, LC_ALL: 'C' },
		});
		const result = new Map<number, IParadisHookProcessInfo>();
		for (const line of stdout.split('\n')) {
			// 形式: <pid> <ppid> <曜日 月 日 時刻 年 (5トークン)> <command...>
			const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
			if (!match) {
				continue;
			}
			const pid = Number(match[1]);
			result.set(pid, { pid, ppid: Number(match[2]), startKey: match[3], command: match[4] });
		}
		return result.size > 0 ? result : undefined;
	} catch {
		return undefined;
	}
}

/** Windows: Win32_Process を1回で取得する。CreationDate はPID再利用検出用の不透明文字列。 */
async function windowsProcessSnapshot(): Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined> {
	try {
		const command = 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine | ConvertTo-Json -Compress"';
		const { stdout } = await execAsync(command, { timeout: EXEC_TIMEOUT_MS * 2, maxBuffer: 32 * 1024 * 1024 });
		const parsed: unknown = JSON.parse(stdout);
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		const result = new Map<number, IParadisHookProcessInfo>();
		for (const entry of entries) {
			if (typeof entry !== 'object' || entry === null) {
				continue;
			}
			const row = entry as Record<string, unknown>;
			const pid = typeof row['ProcessId'] === 'number' ? row['ProcessId'] : undefined;
			if (pid === undefined) {
				continue;
			}
			const ppid = typeof row['ParentProcessId'] === 'number' ? row['ParentProcessId'] : undefined;
			const creation = row['CreationDate'];
			const commandLine = typeof row['CommandLine'] === 'string' && row['CommandLine'].length > 0
				? row['CommandLine']
				: typeof row['Name'] === 'string' ? row['Name'] : '';
			result.set(pid, {
				pid, ppid,
				startKey: typeof creation === 'string' ? creation : typeof creation === 'object' && creation !== null ? JSON.stringify(creation) : undefined,
				command: commandLine,
			});
		}
		return result.size > 0 ? result : undefined;
	} catch {
		return undefined;
	}
}

/** 既定のプロセス表取得（TTL付きキャッシュ。失敗キャッシュはしない）。 */
export class ParadisDefaultHookProcessInspector implements IParadisHookProcessInspector {
	private cached: { at: number; value: Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined> } | undefined;

	snapshot(): Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined> {
		const now = Date.now();
		if (this.cached !== undefined && now - this.cached.at < SNAPSHOT_TTL_MS) {
			return this.cached.value;
		}
		const value = (process.platform === 'win32' ? windowsProcessSnapshot() : posixProcessSnapshot())
			.then(snapshot => {
				if (snapshot === undefined && this.cached?.value === value) {
					this.cached = undefined;
				}
				return snapshot;
			});
		this.cached = { at: now, value };
		return value;
	}
}

export interface IParadisHookClassification {
	readonly origin: ParadisHookOrigin;
	/** nested の場合の子エージェント種別（活動ツリーへの投影に使う）。 */
	readonly agentKind: ParadisHookAgentKind | undefined;
}

/**
 * ペイントークンごとのhook発信元所有権レジストリ。
 * `/agent-hook` ingress が全副作用（hookバス発火・ペイン状態更新）より前に参照する。
 */
export class ParadisAgentHookOwnership {

	private readonly owners = new Map<string, IOwnerRecord>();

	constructor(private readonly inspector: IParadisHookProcessInspector = new ParadisDefaultHookProcessInspector()) { }

	/** ペイン終了時に所有権を破棄する。 */
	clear(token: string): void {
		this.owners.delete(token);
	}

	async classify(input: { readonly token: string; readonly hookPid: number | undefined; readonly transcriptPath: string | undefined; readonly at: number }): Promise<IParadisHookClassification> {
		try {
			return await this.doClassify(input);
		} catch {
			// 分類の失敗でhookを失わない: 所有権が不明なら fail-closed ポリシーへ。
			return this.classifyWithoutIdentity(input.token, input.transcriptPath, input.at, undefined);
		}
	}

	private async doClassify(input: { readonly token: string; readonly hookPid: number | undefined; readonly transcriptPath: string | undefined; readonly at: number }): Promise<IParadisHookClassification> {
		const { token, hookPid, transcriptPath, at } = input;
		const eventKind = transcriptPath !== undefined ? paradisHookAgentKindForTranscript(transcriptPath) : undefined;
		if (hookPid === undefined) {
			return this.classifyWithoutIdentity(token, transcriptPath, at, eventKind);
		}
		const snapshot = await this.inspector.snapshot();
		if (snapshot === undefined) {
			return this.classifyWithoutIdentity(token, transcriptPath, at, eventKind);
		}
		const chain = this.ancestorChain(snapshot, hookPid);
		const emitter = this.findEmitter(chain, eventKind);
		if (emitter === undefined) {
			return this.classifyWithoutIdentity(token, transcriptPath, at, eventKind);
		}
		const emitterKind = paradisHookAgentKindFromCommandLine(emitter.command);
		let owner = this.owners.get(token);
		const ownerProcess = owner?.pid !== undefined ? snapshot.get(owner.pid) : undefined;
		const ownerAlive = owner?.pid !== undefined && ownerProcess !== undefined && this.startKeyMatches(owner.startKey, ownerProcess.startKey);
		if (owner === undefined || owner.pid === undefined || !ownerAlive) {
			// 所有者が未確定（初回・旧スクリプト由来のtranscriptのみのレコード）または死亡
			// （PID再利用含む）→ このチェーンで「ペインのシェルに最も近い（最外側の）エージェント
			// プロセス」を所有者にする。emitter 自身を無条件に所有者へすると、所有者の最初の
			// hookより先にネストした子のhookが届いた場合（shared process 再起動直後など）に
			// 子が所有者として bootstrap されてしまう。
			const outermost = this.findOutermostAgent(chain) ?? emitter;
			owner = {
				pid: outermost.pid, startKey: outermost.startKey,
				agentKind: paradisHookAgentKindFromCommandLine(outermost.command),
				transcriptPath: outermost.pid === emitter.pid ? transcriptPath : undefined, at,
			};
			this.setOwner(token, owner);
		}
		if (owner.pid === emitter.pid && this.startKeyMatches(owner.startKey, emitter.startKey)) {
			// 所有者自身からのイベント。/clear 等でtranscriptが変わるrebindも許可する。
			this.setOwner(token, { ...owner, startKey: owner.startKey ?? emitter.startKey, transcriptPath: transcriptPath ?? owner.transcriptPath, at });
			return { origin: 'owner', agentKind: emitterKind };
		}
		const emitterIndex = chain.findIndex(entry => entry.pid === emitter.pid);
		const ownerPid = owner.pid;
		const ownerIsAncestor = emitterIndex >= 0 && chain.slice(emitterIndex + 1).some(entry => entry.pid === ownerPid);
		if (ownerIsAncestor) {
			// 生存中の所有者の配下で動く別エージェントプロセス = ネストした子エージェント。
			return { origin: 'nested', agentKind: emitterKind };
		}
		// 所有者が生存しているのに祖先関係が無い = 兄弟や誤配送。ペイン状態を触らせない。
		return { origin: 'invalid', agentKind: emitterKind };
	}

	/** チェーン内で最も祖先側（ペインのシェルに最も近い）のエージェントプロセスを返す。 */
	private findOutermostAgent(chain: readonly IParadisHookProcessInfo[]): IParadisHookProcessInfo | undefined {
		for (let i = chain.length - 1; i >= 0; i--) {
			if (paradisHookAgentKindFromCommandLine(chain[i].command) !== undefined) {
				return chain[i];
			}
		}
		return undefined;
	}

	/**
	 * 発信元プロセスを特定できないhook（旧v2スクリプト・ps失敗・プロセス消滅）の fail-closed 判定:
	 * 所有者が既知なら、同じtranscriptへのイベントとtranscript無しイベント（状態のみのGET
	 * フォールバック等）だけを通し、別transcriptへのrebindは拒否する。
	 */
	private classifyWithoutIdentity(token: string, transcriptPath: string | undefined, at: number, eventKind: ParadisHookAgentKind | undefined): IParadisHookClassification {
		const owner = this.owners.get(token);
		if (owner === undefined) {
			this.setOwner(token, { pid: undefined, startKey: undefined, agentKind: eventKind, transcriptPath, at });
			return { origin: 'owner', agentKind: eventKind };
		}
		if (transcriptPath === undefined || owner.transcriptPath === undefined || owner.transcriptPath === transcriptPath) {
			if (owner.pid === undefined) {
				this.setOwner(token, { ...owner, transcriptPath: owner.transcriptPath ?? transcriptPath, agentKind: owner.agentKind ?? eventKind, at });
			}
			return { origin: 'owner', agentKind: eventKind ?? owner.agentKind };
		}
		return { origin: 'invalid', agentKind: eventKind };
	}

	/** hookPid 自身を先頭に、親方向の祖先チェーンを返す（循環・深さ上限つき）。 */
	private ancestorChain(snapshot: ReadonlyMap<number, IParadisHookProcessInfo>, hookPid: number): IParadisHookProcessInfo[] {
		const chain: IParadisHookProcessInfo[] = [];
		const seen = new Set<number>();
		let current = snapshot.get(hookPid);
		while (current !== undefined && chain.length < MAX_ANCESTOR_DEPTH && !seen.has(current.pid)) {
			seen.add(current.pid);
			chain.push(current);
			current = current.ppid !== undefined && current.ppid > 0 ? snapshot.get(current.ppid) : undefined;
		}
		return chain;
	}

	/**
	 * チェーン内で「イベントのtranscript種別と一致する最も近いエージェントプロセス」を返す。
	 * 種別不明イベント（transcript無し）は最も近い任意のエージェントプロセスを採用する。
	 * 注意: 単なる「祖先に所有者PIDがいるか」では判定しない。親エージェントは子エージェントの
	 * 祖先にも必ず現れるため、それでは子のhookを所有者由来として誤許可してしまう。
	 */
	private findEmitter(chain: readonly IParadisHookProcessInfo[], eventKind: ParadisHookAgentKind | undefined): IParadisHookProcessInfo | undefined {
		for (const entry of chain) {
			const kind = paradisHookAgentKindFromCommandLine(entry.command);
			if (kind !== undefined && (eventKind === undefined || kind === eventKind)) {
				return entry;
			}
		}
		return undefined;
	}

	private startKeyMatches(recorded: string | undefined, observed: string | undefined): boolean {
		if (recorded === undefined || observed === undefined) {
			return true;
		}
		return recorded === observed;
	}

	private setOwner(token: string, record: IOwnerRecord): void {
		this.owners.delete(token);
		if (this.owners.size >= MAX_OWNER_RECORDS) {
			let oldestToken: string | undefined;
			let oldestAt = Number.POSITIVE_INFINITY;
			for (const [candidate, value] of this.owners) {
				if (value.at < oldestAt) {
					oldestAt = value.at;
					oldestToken = candidate;
				}
			}
			if (oldestToken !== undefined) {
				this.owners.delete(oldestToken);
			}
		}
		this.owners.set(token, record);
	}
}
