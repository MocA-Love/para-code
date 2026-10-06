/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// hook で Claude Code の会話を確かめたペインを、タブ名の側で Claude として固定するかを決める。
//
// タブ名の側（terminalInstance.ts）は、OSC タイトルが「Claude Code」に合うことでしか Claude を見分けない。
// 再開した会話や `/rename` した会話は最初から `✳ <話題>` を送るので見分けられず、タブにプロセス名
// （ネイティブ版は版番号）やプリセットの名前が出る。hook の側は持ち主の判定（ペインのシェルの子孫で、
// 入れ子でない）を済ませた会話を `paneSessions` に載せているので、それを手がかりにする。
//
// 決め方（ペインごと）:
//   - Claude の会話が載っていて、前面がシェルでない（pty の報告が無い・node・Claude）→ 固定する
//   - 前面にシェルが戻ったら、タブ名の側が自分で固定を解く。ここではそのときの hook の時刻を控え、
//     同じ会話の新しい hook が来るまで固定し直さない（落ちた Claude の会話が残ったままでも、後で動かした
//     別のコマンドを Claude と取り違えない）
//   - 前面がシェルと報告されていても、控えた時刻より新しい hook が来たら Claude は動いている。固定する
//     （ウィンドウを読み込み直した直後は、pty の報告が来るまでシェルと推測されている）
//   - 会話が載らなくなった（SessionEnd・ペインの終了）か、持ち主が Claude でなくなった → 固定を解く
//   - 前面が別のエージェント（Codex など）→ 触らない

import { GeneralShellType, PosixShellType, TerminalShellType, WindowsShellType } from '../../../../platform/terminal/common/terminal.js';

/** ペインで動いている会話（状態のスナップショットの `paneSessions` の1件）のうち、判断に使うもの。 */
export interface IParadisTitlePinSession {
	readonly agent: 'claude' | 'codex';
	readonly sessionId: string;
	/** 最後に hook を受けた時刻 (epoch ms)。 */
	readonly at: number;
}

export type ParadisTitlePinAction = 'pin' | 'release';

interface IPinRecord {
	readonly sessionId: string;
	/** この会話でタブを Claude に固定した。 */
	readonly pinned: boolean;
	/** 固定していた間に前面へシェルが戻った時点の hook の時刻。これより新しい hook が来るまで固定し直さない。 */
	readonly releasedAt?: number;
	/** 前面がシェルと見えていた時点の hook の時刻。これより新しい hook が来たら、シェルの報告より hook を信じる。 */
	readonly shellSeenAt?: number;
}

/** OSC タイトルで見分けるエージェントのうち、Claude 以外（前面に出ていたら触らない）。 */
const OTHER_AGENT_SHELL_TYPES: ReadonlySet<TerminalShellType> = new Set<TerminalShellType>([
	GeneralShellType.Codex,
	GeneralShellType.CommandCode,
	GeneralShellType.Copilot,
	GeneralShellType.Gemini,
]);

/** 前面がシェルでなく、Claude が動いていておかしくない報告か（ネイティブ版は版番号の名前で、型が付かない）。 */
function maybeClaudeInFront(shellType: TerminalShellType): boolean {
	return shellType === undefined || shellType === GeneralShellType.Node || shellType === GeneralShellType.Claude;
}

/**
 * タブ（ターミナルのインスタンス）ごとに、hook で確かめた Claude の会話に合わせて固定・解除を決める。
 * 状態を持つのはこのクラスだけで、実際の固定・解除は呼ぶ側が行う。
 */
export class ParadisClaudeTabTitlePinTracker {
	private readonly records = new Map<number, IPinRecord>();

	/**
	 * @param instanceId ターミナルのインスタンス
	 * @param shellType タブ名の側が今持っている種別
	 * @param session そのペインの会話（hook が届かない・会話が無いなら undefined）
	 */
	decide(instanceId: number, shellType: TerminalShellType, session: IParadisTitlePinSession | undefined): ParadisTitlePinAction | undefined {
		const previous = this.records.get(instanceId);
		if (session?.agent !== 'claude') {
			this.records.delete(instanceId);
			return previous?.pinned === true && shellType === GeneralShellType.Claude ? 'release' : undefined;
		}
		// 別の会話になったら控えは引き継がない（新しく起動した Claude は、すぐ固定してよい）
		const record = previous?.sessionId === session.sessionId ? previous : undefined;
		if (OTHER_AGENT_SHELL_TYPES.has(shellType)) {
			return undefined;
		}
		if (maybeClaudeInFront(shellType)) {
			if (record?.pinned === true && shellType === GeneralShellType.Claude) {
				return undefined;
			}
			if (record?.pinned !== true && record?.releasedAt !== undefined && session.at <= record.releasedAt) {
				return undefined;
			}
			this.records.set(instanceId, { sessionId: session.sessionId, pinned: true });
			return 'pin';
		}
		// 前面にシェルがいる
		if (record?.pinned === true) {
			this.records.set(instanceId, { sessionId: session.sessionId, pinned: false, releasedAt: session.at, shellSeenAt: session.at });
			return undefined;
		}
		if (record?.shellSeenAt === undefined) {
			this.records.set(instanceId, { sessionId: session.sessionId, pinned: false, releasedAt: record?.releasedAt, shellSeenAt: session.at });
			return undefined;
		}
		if (session.at > record.shellSeenAt && isKnownShell(shellType)) {
			this.records.set(instanceId, { sessionId: session.sessionId, pinned: true });
			return 'pin';
		}
		return undefined;
	}

	forget(instanceId: number): void {
		this.records.delete(instanceId);
	}

	/** 今あるタブだけを残す。 */
	retain(instanceIds: ReadonlySet<number>): void {
		for (const instanceId of [...this.records.keys()]) {
			if (!instanceIds.has(instanceId)) {
				this.records.delete(instanceId);
			}
		}
	}
}

const KNOWN_SHELL_TYPES: ReadonlySet<string> = new Set<string>([
	PosixShellType.Bash, PosixShellType.Csh, PosixShellType.Fish, PosixShellType.Ksh, PosixShellType.Sh, PosixShellType.Zsh,
	GeneralShellType.PowerShell, GeneralShellType.NuShell, GeneralShellType.Xonsh,
	WindowsShellType.CommandPrompt, WindowsShellType.GitBash, WindowsShellType.Wsl,
]);

function isKnownShell(shellType: TerminalShellType): boolean {
	return shellType !== undefined && KNOWN_SHELL_TYPES.has(shellType);
}
