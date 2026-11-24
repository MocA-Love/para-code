/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { raceTimeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { isWindows, OperatingSystem } from '../../../../base/common/platform.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisClaudeCodeModeShell, IParadisClaudeResumeProfile, PARADIS_SESSION_RESUME_CHANNEL, ParadisResumeAgent, ParadisResumeCli, paradisAgentResumeCommandLine, paradisClaudeCodeModeNeedsSettingsFile } from '../common/paradisSessionResume.js';

/** 会話のあるマシンへの問い合わせを待つ上限。過ぎたら従来どおりのコマンドで再開する。 */
const PROFILE_LOOKUP_TIMEOUT_MS = 3_000;
/** シェルの種類が届くのを待つ上限（pty host がプロセス名から調べて、開いた少し後に送ってくる）。 */
const SHELL_TYPE_WAIT_MS = 2_000;

export interface IParadisTerminalResumeCommandRequest {
	readonly agent: ParadisResumeAgent;
	readonly sessionId: string;
	readonly mode: 'resume' | 'fork';
	readonly dangerouslyBypassPermissions?: boolean;
	readonly cli?: ParadisResumeCli;
	/** 会話を始めたフォルダ（ターミナルのあるマシンの上のパス）。記録を探す手がかりにする。 */
	readonly cwd?: string;
}

export interface IParadisTerminalResumeCommandServices {
	readonly sharedProcessService: ISharedProcessService;
	readonly remoteAgentService: IRemoteAgentService;
	readonly logService: ILogService;
}

/**
 * ターミナルへ送る、会話の再開・分岐のコマンドを用意する。返す関数に、送り先のターミナルを渡すとコマンドになる。
 *
 * Claude Code の会話は、ターミナルのあるマシン（`remote` なら接続先の REH サーバー、そうでなければ手元の shared process）に
 * Code Mode で始めた会話かを聞き、そうなら Code Mode をオンにしてトレースを切る `--settings` を、ターミナルのシェルに
 * 合わせた引用で足す（`paradisClaudeCodeModeSettingsArgument`）。聞けない・時間切れ・引用できないときは、従来どおりの
 * コマンドを返す。ほかのエージェントは {@link paradisAgentResumeCommandLine} のまま。ID が検証に通らなければ undefined。
 *
 * 問い合わせはここで始める。ターミナルを開く前に呼べば、開いている間に答えが届き、開いたターミナルへコマンドを送るまでの
 * 待ちが増えない（待っている間に利用者が打った文字の後ろへ、コマンドと Enter をつなげないため）。
 */
export function paradisPrepareAgentResumeCommand(services: IParadisTerminalResumeCommandServices, remote: boolean, request: IParadisTerminalResumeCommandRequest): (instance: ITerminalInstance) => Promise<string | undefined> {
	const options = { dangerouslyBypassPermissions: request.dangerouslyBypassPermissions, cli: request.cli };
	const plain = paradisAgentResumeCommandLine(request.agent, request.sessionId, request.mode, options);
	const channel = plain === undefined || request.agent !== 'claude' ? undefined : paradisResumeChannel(services, remote);
	if (channel === undefined) {
		return async () => plain;
	}
	const lookup = (wantSettingsFile: boolean): Promise<IParadisClaudeResumeProfile | undefined> => raceTimeout(
		channel.call<IParadisClaudeResumeProfile>('claudeResumeProfile', [request.sessionId, request.cwd, wantSettingsFile]).catch(error => {
			// 古い REH サーバーにはこの問い合わせ口が無い。従来どおりのコマンドで再開する
			services.logService.debug('[ParadisSessionResume] could not ask how to resume the Claude session', error);
			return undefined;
		}),
		PROFILE_LOOKUP_TIMEOUT_MS);
	const profile = lookup(false);
	return async instance => {
		if ((await profile)?.codeMode !== true) {
			return plain;
		}
		if (instance.shellType === undefined) {
			const arrived = Event.toPromise(Event.filter(instance.onDidChangeShellType, type => type !== undefined));
			await raceTimeout(arrived, SHELL_TYPE_WAIT_MS, () => arrived.cancel());
		}
		const shellType = instance.shellType;
		const settingsFile = paradisClaudeCodeModeNeedsSettingsFile(shellType) ? (await lookup(true))?.settingsFile : undefined;
		const claudeCodeMode: IParadisClaudeCodeModeShell = { shellType, windows: paradisTerminalRunsOnWindows(instance), ...(settingsFile !== undefined ? { settingsFile } : {}) };
		return paradisAgentResumeCommandLine(request.agent, request.sessionId, request.mode, { ...options, claudeCodeMode }) ?? plain;
	};
}

/** もう開いているターミナルへ送る、会話の再開・分岐のコマンド（{@link paradisPrepareAgentResumeCommand}）。 */
export function paradisAgentResumeCommandForTerminal(services: IParadisTerminalResumeCommandServices, instance: ITerminalInstance, request: IParadisTerminalResumeCommandRequest): Promise<string | undefined> {
	return paradisPrepareAgentResumeCommand(services, instance.remoteAuthority !== undefined, request)(instance);
}

/** 会話のあるマシンのセッション履歴のチャネル。接続先なのに接続が無ければ undefined。 */
function paradisResumeChannel(services: IParadisTerminalResumeCommandServices, remote: boolean): IChannel | undefined {
	return remote
		? services.remoteAgentService.getConnection()?.getChannel(PARADIS_SESSION_RESUME_CHANNEL)
		: services.sharedProcessService.getChannel(PARADIS_SESSION_RESUME_CHANNEL);
}

/** シェルが Windows で動いているか。まだ分からない手元のターミナルは、このアプリの OS とみなす。 */
function paradisTerminalRunsOnWindows(instance: ITerminalInstance): boolean {
	return instance.os !== undefined ? instance.os === OperatingSystem.Windows : instance.remoteAuthority === undefined && isWindows;
}
