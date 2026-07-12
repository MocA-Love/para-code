/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING, PARADIS_CODEX_TERMINAL_TITLE_ITEMS } from '../common/paradisCodexTerminalTitle.js';

function replaceTerminalTitleInTuiSection(config: string): string {
	const titleLine = `terminal_title = [${PARADIS_CODEX_TERMINAL_TITLE_ITEMS.map(item => `"${item}"`).join(', ')}]`;
	const tuiHeader = /^\[tui\][^\n]*(?:\n|$)/m;
	const headerMatch = tuiHeader.exec(config);
	if (!headerMatch || headerMatch.index === undefined) {
		return `${config.trimEnd()}\n\n[tui]\n${titleLine}\n`;
	}

	const sectionStart = headerMatch.index + headerMatch[0].length;
	const nextSection = /^\[/m;
	const nextSectionMatch = nextSection.exec(config.slice(sectionStart));
	const sectionEnd = nextSectionMatch?.index === undefined ? config.length : sectionStart + nextSectionMatch.index;
	const section = config.slice(sectionStart, sectionEnd);
	const titleKey = /^[\t ]*terminal_title[\t ]*=/m;
	const titleKeyMatch = titleKey.exec(section);
	if (!titleKeyMatch || titleKeyMatch.index === undefined) {
		return `${config.slice(0, sectionStart)}${titleLine}\n${config.slice(sectionStart)}`;
	}

	const valueStart = titleKeyMatch.index + titleKeyMatch[0].length;
	let valueEnd = valueStart;
	let arrayDepth = 0;
	let inString = false;
	let escaped = false;
	for (; valueEnd < section.length; valueEnd++) {
		const character = section[valueEnd];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === '[') {
			arrayDepth++;
		} else if (character === ']') {
			arrayDepth--;
			if (arrayDepth === 0) {
				valueEnd++;
				break;
			}
		} else if (character === '\n' && arrayDepth === 0) {
			break;
		}
	}

	return `${config.slice(0, sectionStart + titleKeyMatch.index)}${titleLine}${config.slice(sectionStart + valueEnd)}`;
}

class ParadisCodexTerminalTitleContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisCodexTerminalTitle';

	private writeQueue = Promise.resolve();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
		this.applySetting();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING)) {
				this.applySetting();
			}
		}));
	}

	private applySetting(): void {
		if (this.configurationService.getValue<boolean>(PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING) !== false) {
			this.writeQueue = this.writeQueue.then(async () => {
				if (this.configurationService.getValue<boolean>(PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING) !== false) {
					await this.writeCodexConfig();
				}
			}).catch(error => {
				this.logService.warn('[ParadisCodexTerminalTitle] failed to update Codex terminal title', error);
			});
		}
	}

	private async writeCodexConfig(): Promise<void> {
		const userHome = await this.pathService.userHome();
		const codexHome = joinPath(userHome, '.codex');
		const configFile = joinPath(codexHome, 'config.toml');
		if (!(await this.fileService.exists(codexHome))) {
			await this.fileService.createFolder(codexHome);
		}
		const currentConfig = (await this.fileService.exists(configFile))
			? (await this.fileService.readFile(configFile)).value.toString()
			: '';
		const nextConfig = replaceTerminalTitleInTuiSection(currentConfig);
		if (nextConfig !== currentConfig) {
			await this.fileService.writeFile(configFile, VSBuffer.fromString(nextConfig));
		}
	}
}

registerWorkbenchContribution2(ParadisCodexTerminalTitleContribution.ID, ParadisCodexTerminalTitleContribution, WorkbenchPhase.Ready);
