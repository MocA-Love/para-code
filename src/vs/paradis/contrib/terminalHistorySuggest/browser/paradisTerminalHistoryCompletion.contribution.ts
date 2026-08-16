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
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
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
import { getCommandHistory, getShellFileHistory } from '../../../../workbench/contrib/terminalContrib/history/common/history.js';
import { ITerminalCompletion, TerminalCompletionItemKind } from '../../../../workbench/contrib/terminalContrib/suggest/browser/terminalCompletionItem.js';
import { ITerminalCompletionProvider, ITerminalCompletionService } from '../../../../workbench/contrib/terminalContrib/suggest/browser/terminalCompletionService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { ParadisTerminalHistoryCache, paradisTerminalHistoryCacheKey, paradisDecodeZshHistory, paradisParseBashHistory, paradisParseZshHistory, ParadisTerminalHistorySharedValue, ParadisTerminalHistoryWaitResult } from '../common/paradisTerminalHistoryCache.js';

const MAX_RESULTS = 20;

/** シェルファイル履歴の再読込間隔。Superset の 30秒キャッシュと同等の鮮度。 */
const FILE_HISTORY_TTL_MS = 30_000;

interface IParadisTerminalHistoryLocation {
	readonly scheme: string;
	readonly authority: string | undefined;
	readonly home: string;
}

interface IParadisTerminalHistoryFileRequest {
	readonly shellType: PosixShellType.Bash | PosixShellType.Zsh;
	readonly sourceLabel: string;
	readonly resource: URI;
}

interface IFileHistoryResult {
	readonly sourceLabel: string;
	readonly commands: readonly string[];
}

export interface IParadisTerminalHistoryCompletionProviderOptions {
	readonly decodeZshHistory?: (bytes: Uint8Array) => string;
	readonly parseZshHistory?: (content: string) => readonly string[];
	readonly parseBashHistory?: (content: string) => readonly string[];
}

export class ParadisTerminalHistoryCompletionProvider extends Disposable implements ITerminalCompletionProvider {

	static readonly ID = 'para.terminalHistory';

	id = ParadisTerminalHistoryCompletionProvider.ID;
	triggerCharacters?: string[];

	private readonly _decodeZshHistory: (bytes: Uint8Array) => string;
	private readonly _parseZshHistory: (content: string) => readonly string[];
	private readonly _parseBashHistory: (content: string) => readonly string[];
	private readonly _location: ParadisTerminalHistorySharedValue<IParadisTerminalHistoryLocation>;
	private readonly _fileHistoryCache: ParadisTerminalHistoryCache<IFileHistoryResult>;
	private readonly _fallbackHistory: DisposableMap<TerminalShellType | undefined, ParadisTerminalHistorySharedValue<IFileHistoryResult>>;
	private _isDisposed = false;

	constructor(
		options: IParadisTerminalHistoryCompletionProviderOptions | undefined,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IFileService private readonly _fileService: IFileService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
	) {
		super();
		this._decodeZshHistory = options?.decodeZshHistory ?? paradisDecodeZshHistory;
		this._parseZshHistory = options?.parseZshHistory ?? paradisParseZshHistory;
		this._parseBashHistory = options?.parseBashHistory ?? paradisParseBashHistory;
		this._location = this._register(new ParadisTerminalHistorySharedValue(() => this._resolveLocation()));
		this._fileHistoryCache = this._register(new ParadisTerminalHistoryCache(FILE_HISTORY_TTL_MS, FILE_HISTORY_TTL_MS));
		this._fallbackHistory = this._register(new DisposableMap());
	}

	async provideCompletions(value: string, cursorPosition: number, token: CancellationToken): Promise<ITerminalCompletion[] | undefined> {
		if (this._isDisposed || token.isCancellationRequested) {
			return undefined;
		}
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
			const fileHistoryResult = await this._getFileHistory(shellType, token);
			if (this._isDisposed || token.isCancellationRequested || fileHistoryResult.kind === 'cancelled') {
				return undefined;
			}
			const fileHistory = fileHistoryResult.value;
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
	private async _getFileHistory(shellType: TerminalShellType | undefined, token: CancellationToken): Promise<ParadisTerminalHistoryWaitResult<IFileHistoryResult>> {
		if (shellType === PosixShellType.Zsh || shellType === PosixShellType.Bash) {
			const locationResult = await this._location.get(token);
			if (this._isDisposed || token.isCancellationRequested || locationResult.kind === 'cancelled') {
				return { kind: 'cancelled' };
			}
			if (!locationResult.value) {
				return { kind: 'completed', value: undefined };
			}
			const request = this._createFileRequest(shellType, locationResult.value);
			return this._fileHistoryCache.get(paradisTerminalHistoryCacheKey(shellType, request.resource), token, () => this._loadFileHistory(request));
		}
		let shared = this._fallbackHistory.get(shellType);
		if (!shared) {
			shared = new ParadisTerminalHistorySharedValue(async () => {
				const upstreamHistory = await this._instantiationService.invokeFunction(getShellFileHistory, shellType);
				return upstreamHistory ? Object.freeze({
					sourceLabel: upstreamHistory.sourceLabel,
					commands: Object.freeze([...upstreamHistory.commands]),
				}) : undefined;
			}, false);
			this._fallbackHistory.set(shellType, shared);
		}
		return shared.get(token);
	}

	private async _resolveLocation(): Promise<IParadisTerminalHistoryLocation | undefined> {
		try {
			const remoteEnvironment = await this._remoteAgentService.getEnvironment();
			if (remoteEnvironment?.os === OperatingSystem.Windows || !remoteEnvironment && isWindows) {
				return undefined;
			}
			const home = remoteEnvironment?.userHome?.fsPath ?? env['HOME'];
			if (!home) {
				return undefined;
			}
			const remoteAuthority = this._remoteAgentService.getConnection()?.remoteAuthority;
			return Object.freeze({
				scheme: remoteAuthority ? Schemas.vscodeRemote : Schemas.file,
				authority: remoteAuthority,
				home,
			});
		} catch {
			return undefined;
		}
	}

	private _createFileRequest(shellType: PosixShellType.Bash | PosixShellType.Zsh, location: IParadisTerminalHistoryLocation): IParadisTerminalHistoryFileRequest {
		const isZsh = shellType === PosixShellType.Zsh;
		const filename = isZsh ? '.zsh_history' : '.bash_history';
		return Object.freeze({
			shellType,
			sourceLabel: `~/${filename}`,
			resource: URI.from({
				scheme: location.scheme,
				authority: location.authority,
				path: URI.file(join(location.home, filename)).path,
			}),
		});
	}

	private async _loadFileHistory(request: IParadisTerminalHistoryFileRequest): Promise<IFileHistoryResult | undefined> {
		let content;
		try {
			content = await this._fileService.readFile(request.resource);
		} catch (e: unknown) {
			if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return undefined;
			}
			throw e;
		}
		if (this._isDisposed) {
			return undefined;
		}
		const commands = request.shellType === PosixShellType.Zsh
			? this._parseZshHistory(this._decodeZshHistory(content.value.buffer))
			: this._parseBashHistory(content.value.toString());
		return Object.freeze({ sourceLabel: request.sourceLabel, commands: Object.freeze([...commands]) });
	}

	override dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		super.dispose();
	}
}

export class ParadisTerminalHistoryCompletionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalHistoryCompletion';

	constructor(
		@ITerminalCompletionService terminalCompletionService: ITerminalCompletionService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		const provider = this._register(instantiationService.createInstance(ParadisTerminalHistoryCompletionProvider, undefined));
		this._register(terminalCompletionService.registerTerminalCompletionProvider(
			'para',
			ParadisTerminalHistoryCompletionProvider.ID,
			provider,
		));
	}
}

registerWorkbenchContribution2(ParadisTerminalHistoryCompletionContribution.ID, ParadisTerminalHistoryCompletionContribution, WorkbenchPhase.AfterRestored);
