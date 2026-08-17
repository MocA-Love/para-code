/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CLIエージェント(Claude Code/Codex等)がターミナルに出す file:// リンク(特にSMB共有をUNC形式で
// 表した file://host/path のようなもの)は、標準の TerminalUriLinkDetector がローカルファイル
// システムへの stat 検証に失敗すると黙って読み捨てる。捨てられたトークンは最下位の
// TerminalWordLinkDetector が拾い、TerminalSearchLinkOpener 経由でワークスペース内検索→不一致→
// クイックオープン検索窓に文字列が入力されるだけ、という体験になってしまう
// (https://... のリンクが upstream 標準の TerminalUrlLinkOpener で外部へ開けるのと対照的)。
//
// このdetectorは Uri detector の後・Word detector の前に挿入し、authorityを持つ(=UNC/SMB形式の)
// file:// のうち stat 検証に失敗したものだけを拾う。authorityなしのローカルパス(file:///Users/...)は
// 対象外とする — 実在すれば Uri detector が LocalFile として正しくエディタで開くし、実在しなければ
// 開いても意味がないため。
//
// type: TerminalBuiltinLinkType.Url を返すことで、既存の TerminalUrlLinkOpener
// (terminalLinkOpeners.ts の _openFileSchemeLink) にそのまま委譲する — file:// を stat して
// 失敗すれば `openerService.open(link.text, { openExternal: true, allowContributedOpeners: true })`
// で OS 既定のハンドラに投げてくれる経路が既にupstreamにあるため、独自の activate/opener は書かない
// (URIの再エンコードでパーセントエンコードが変わる、telemetry/allowTunnelingが効かなくなる、といった
// 劣化を避けるため)。

import { Schemas } from '../../../../base/common/network.js';
import { isString } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { ILinkComputerTarget, LinkComputer } from '../../../../editor/common/languages/linkComputer.js';
import { ITerminalBackend } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalConfigurationService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ITerminalLinkDetector, ITerminalLinkResolver, ITerminalSimpleLink, TerminalBuiltinLinkType } from '../../../../workbench/contrib/terminalContrib/links/browser/links.js';
import { convertLinkRangeToBuffer, getXtermLineContent } from '../../../../workbench/contrib/terminalContrib/links/browser/terminalLinkHelpers.js';
import { ITerminalProcessManager } from '../../../../workbench/contrib/terminal/common/terminal.js';
import type { IBufferLine, Terminal } from '@xterm/xterm';

const enum Constants {
	/**
	 * Mirrors TerminalUriLinkDetector.MaxResolvedLinksInLine: avoid resolving (and stat-ing) an
	 * unbounded number of links per line, which could block on unreachable SMB/UNC hosts.
	 */
	MaxResolvedLinksInLine = 10
}

export class ParadisTerminalFileUriLinkDetector implements ITerminalLinkDetector {
	static id = 'paradis-file-uri';

	// Mirrors TerminalUriLinkDetector: 2048 is the maximum URL length.
	readonly maxLinkLength = 2048;

	constructor(
		readonly xterm: Terminal,
		private readonly _processManager: Pick<ITerminalProcessManager, 'initialCwd' | 'os' | 'remoteAuthority' | 'userHome'> & { backend?: Pick<ITerminalBackend, 'getWslPath'> },
		private readonly _linkResolver: ITerminalLinkResolver,
		@ITerminalConfigurationService private readonly _terminalConfigurationService: ITerminalConfigurationService,
	) {
	}

	async detect(lines: IBufferLine[], startLine: number, endLine: number): Promise<ITerminalSimpleLink[]> {
		// Respect the user's allowed link schemes the same way the native xterm link handler does
		// (terminalLinkManager.ts) — this detector's links end up shelling out to the OS' default
		// handler via TerminalUrlLinkOpener, same as a plain http(s) link would.
		if (this._terminalConfigurationService.config.allowedLinkSchemes.indexOf(Schemas.file) === -1) {
			return [];
		}

		const links: ITerminalSimpleLink[] = [];

		const linkComputerTarget = new ParadisFileUriLinkAdapter(this.xterm, startLine, endLine);
		const computedLinks = LinkComputer.computeLinks(linkComputerTarget);

		let resolvedLinkCount = 0;
		for (const computedLink of computedLinks) {
			if (!isString(computedLink.url) || !computedLink.url.toLowerCase().startsWith(`${Schemas.file}://`) || computedLink.url.length > this.maxLinkLength) {
				continue;
			}
			const text = computedLink.url;

			let uri: URI;
			try {
				uri = URI.parse(this._excludeLineAndColSuffix(text));
			} catch {
				continue;
			}

			if (uri.scheme !== Schemas.file || uri.authority.length === 0) {
				continue;
			}

			// If it resolves locally (e.g. an already-mounted SMB share), leave it to the
			// built-in Uri detector's LocalFile/LocalFolder handling.
			const linkStat = await this._linkResolver.resolveLink(this._processManager, text, uri);
			if (linkStat) {
				continue;
			}

			const bufferRange = convertLinkRangeToBuffer(lines, this.xterm.cols, computedLink.range, startLine);
			links.push({
				text,
				uri,
				bufferRange,
				type: TerminalBuiltinLinkType.Url
			});

			if (++resolvedLinkCount >= Constants.MaxResolvedLinksInLine) {
				break;
			}
		}

		return links;
	}

	private _excludeLineAndColSuffix(path: string): string {
		return path.replace(/:\d+(:\d+)?$/, '');
	}
}

class ParadisFileUriLinkAdapter implements ILinkComputerTarget {
	constructor(
		private _xterm: Terminal,
		private _lineStart: number,
		private _lineEnd: number
	) { }

	getLineCount(): number {
		return 1;
	}

	getLineContent(): string {
		return getXtermLineContent(this._xterm.buffer.active, this._lineStart, this._lineEnd, this._xterm.cols);
	}
}
