/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルのシェル実行履歴(全シェル横断で永続化されているコマンド履歴、"Run Recent Command"
// が使っているのと同じデータソース)を、既存のターミナル入力候補ポップアップ(Ctrl+Space /
// quickSuggestions)に候補として追加する。VS Code純正のterminal suggestはPATH上のコマンドや
// ファイルパス補完が中心でシェルの実行履歴そのものは含まないため、その差分を埋める。
// さらにシェル自身の履歴ファイル(~/.zsh_history / ~/.bash_history 等)もマージし、VS Code内履歴と
// 重複除去して候補化する(Superset の ~/.zsh_history 直読みに相当)。
//
// シェルファイル履歴の読み込みは upstream の getShellFileHistory(ウィンドウ生存中は永久キャッシュ)
// ではなく、zsh/bash については 30秒TTL の自前キャッシュで再読込する(Superset と同じ鮮度)。
// zsh は履歴ファイルが metafy エンコード(0x83 メタ文字)されているため、生バイトを読んで
// デコードしてから UTF-8 解釈する(upstream は文字列として読むため非ASCII履歴が化ける)。
// zsh/bash 以外のシェルは従来どおり upstream の getShellFileHistory にフォールバックする。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { isWindows, OperatingSystem } from '../../../../base/common/platform.js';
import { env } from '../../../../base/common/process.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { PosixShellType, TerminalShellType } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { fetchBashHistory, getCommandHistory, getShellFileHistory } from '../../../../workbench/contrib/terminalContrib/history/common/history.js';
import { ITerminalCompletion, TerminalCompletionItemKind } from '../../../../workbench/contrib/terminalContrib/suggest/browser/terminalCompletionItem.js';
import { ITerminalCompletionProvider, ITerminalCompletionService } from '../../../../workbench/contrib/terminalContrib/suggest/browser/terminalCompletionService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';

const MAX_RESULTS = 20;

/** シェルファイル履歴の再読込間隔。Superset の 30秒キャッシュと同等の鮮度。 */
const FILE_HISTORY_TTL_MS = 30_000;

interface IFileHistoryResult {
	sourceLabel: string;
	commands: string[];
}

/**
 * zsh は非ASCIIバイトを metafy して履歴ファイルへ書く: 0x83 (Meta) が現れたら
 * 次のバイトを ^ 0x20 して元のバイトに戻す。これを施してから UTF-8 デコードする。
 */
function unmetafy(bytes: Uint8Array): Uint8Array {
	if (!bytes.includes(0x83)) {
		return bytes;
	}
	const out = new Uint8Array(bytes.length);
	let outLength = 0;
	for (let i = 0; i < bytes.length; i++) {
		let byte = bytes[i];
		if (byte === 0x83 && i + 1 < bytes.length) {
			byte = bytes[++i] ^ 0x20;
		}
		out[outLength++] = byte;
	}
	return out.subarray(0, outLength);
}

/** upstream fetchZshHistory と同じ書式解釈(extended format / 行継続)。入力は unmetafy 済み文字列。 */
function parseZshHistory(content: string): string[] {
	const isExtendedHistory = /^:\s\d+:\d+;/.test(content);
	const lines = content.split(isExtendedHistory ? /:\s\d+:\d+;/ : /(?<!\\)\n/);
	const result = new Set<string>();
	for (const line of lines) {
		const sanitized = line.replace(/\\\n/g, '\n').trim();
		if (sanitized.length > 0) {
			result.add(sanitized);
		}
	}
	return Array.from(result);
}

class ParadisTerminalHistoryCompletionProvider implements ITerminalCompletionProvider {

	static readonly ID = 'para.terminalHistory';

	id = ParadisTerminalHistoryCompletionProvider.ID;
	triggerCharacters?: string[];

	/** shellType → 直近の読込結果。TTL 内は再読込しない。 */
	private readonly _fileHistoryCache = new Map<TerminalShellType, { timestamp: number; result: IFileHistoryResult | undefined }>();

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IFileService private readonly _fileService: IFileService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService
	) { }

	async provideCompletions(value: string, cursorPosition: number, token: CancellationToken): Promise<ITerminalCompletion[] | undefined> {
		const prefix = value.substring(0, cursorPosition);
		if (prefix.trim().length === 0) {
			return undefined;
		}

		const history = this._instantiationService.invokeFunction(getCommandHistory);
		// Most recently used entries are appended last, prefer those first.
		const entries = Array.from(history.entries).reverse();

		const seen = new Set<string>();
		const completions: ITerminalCompletion[] = [];
		const addCompletion = (command: string, detail: string): void => {
			if (command === prefix || !command.startsWith(prefix) || seen.has(command)) {
				return;
			}
			seen.add(command);
			completions.push({
				label: command,
				provider: this.id,
				kind: TerminalCompletionItemKind.Method,
				// Opt out of the PowerShell "kind === Method && start === 0 → treat as file" heuristic
				// in TerminalCompletionService, which would escape spaces in multi-word history entries.
				isFileOverride: false,
				detail,
				replacementRange: [0, cursorPosition]
			});
		};

		const historyDetail = localize('para.terminalHistory.detail', "History");
		for (const [command] of entries) {
			if (completions.length >= MAX_RESULTS) {
				break;
			}
			addCompletion(command, historyDetail);
		}

		// シェル自身の履歴ファイル(~/.zsh_history 等)からもマージする。補完要求はフォーカス中の
		// ターミナルからしか発生しないため、シェル種別は activeInstance から取得する
		// (ITerminalCompletionProvider.provideCompletions には shellType が渡ってこないための代替)。
		if (completions.length < MAX_RESULTS) {
			const shellType = this._terminalService.activeInstance?.shellType;
			const fileHistory = await this._getFileHistory(shellType);
			if (token.isCancellationRequested) {
				return undefined;
			}
			if (fileHistory) {
				// File order is oldest first, prefer the most recent entries.
				for (let i = fileHistory.commands.length - 1; i >= 0; i--) {
					if (completions.length >= MAX_RESULTS) {
						break;
					}
					addCompletion(fileHistory.commands[i], fileHistory.sourceLabel);
				}
			}
		}
		return completions;
	}

	/**
	 * zsh/bash は 30秒TTL で履歴ファイルを再読込する(セッション中に増えた履歴を追従させる)。
	 * それ以外のシェルは upstream の getShellFileHistory(ウィンドウ生存中キャッシュ)へフォールバック。
	 */
	private async _getFileHistory(shellType: TerminalShellType | undefined): Promise<IFileHistoryResult | undefined> {
		if (shellType === PosixShellType.Zsh || shellType === PosixShellType.Bash) {
			const cached = this._fileHistoryCache.get(shellType);
			if (cached && Date.now() - cached.timestamp < FILE_HISTORY_TTL_MS) {
				return cached.result;
			}
			let result: IFileHistoryResult | undefined;
			try {
				result = shellType === PosixShellType.Zsh
					? await this._fetchZshHistoryFresh()
					: await this._fetchBashHistoryFresh();
			} catch {
				// 読込失敗(権限等)は候補なし扱いにし、TTL 間は再試行しない
				result = undefined;
			}
			this._fileHistoryCache.set(shellType, { timestamp: Date.now(), result });
			return result;
		}
		const upstreamHistory = await this._instantiationService.invokeFunction(getShellFileHistory, shellType);
		return upstreamHistory ? { sourceLabel: upstreamHistory.sourceLabel, commands: upstreamHistory.commands } : undefined;
	}

	private async _fetchBashHistoryFresh(): Promise<IFileHistoryResult | undefined> {
		// upstream の fetch 関数(パースロジック)をキャッシュ層を通さず直接呼ぶ
		const fresh = await this._instantiationService.invokeFunction(fetchBashHistory);
		return fresh ? { sourceLabel: fresh.sourceLabel, commands: fresh.commands } : undefined;
	}

	private async _fetchZshHistoryFresh(): Promise<IFileHistoryResult | undefined> {
		// upstream fetchZshHistory 相当だが、metafy デコードのため生バイトで読む
		const remoteEnvironment = await this._remoteAgentService.getEnvironment();
		if (remoteEnvironment?.os === OperatingSystem.Windows || !remoteEnvironment && isWindows) {
			return undefined;
		}
		const home = remoteEnvironment?.userHome?.fsPath ?? env['HOME'];
		if (!home) {
			return undefined;
		}
		const connection = this._remoteAgentService.getConnection();
		const isRemote = !!connection?.remoteAuthority;
		const resource = URI.from({
			scheme: isRemote ? Schemas.vscodeRemote : Schemas.file,
			authority: isRemote ? connection.remoteAuthority : undefined,
			path: URI.file(join(home, '.zsh_history')).path
		});
		let content;
		try {
			content = await this._fileService.readFile(resource);
		} catch (e: unknown) {
			if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return undefined;
			}
			throw e;
		}
		const decoded = new TextDecoder().decode(unmetafy(content.value.buffer));
		return { sourceLabel: '~/.zsh_history', commands: parseZshHistory(decoded) };
	}
}

class ParadisTerminalHistoryCompletionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalHistoryCompletion';

	constructor(
		@ITerminalCompletionService terminalCompletionService: ITerminalCompletionService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this._register(terminalCompletionService.registerTerminalCompletionProvider(
			'para',
			ParadisTerminalHistoryCompletionProvider.ID,
			instantiationService.createInstance(ParadisTerminalHistoryCompletionProvider)
		));
	}
}

registerWorkbenchContribution2(ParadisTerminalHistoryCompletionContribution.ID, ParadisTerminalHistoryCompletionContribution, WorkbenchPhase.AfterRestored);
