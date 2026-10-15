/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// OSC 8 のリンク（Claude Code の Markdown リンク `[a.md](<a.md>)` など）を、ファイルとして開く。
//
// upstream の linkHandler.activate（terminalLinkManager.ts）は、リンク先を常に URL とみなす。
// 最初の `:` の前をスキームとして扱い、`file:` なら手元のファイルシステムで stat して、
// 失敗すると外部プログラムに投げる。そのため次のリンクが開けない:
// - SSH などリモートのウィンドウの `file:///home/...`（手元に無いので外部へ投げて「Invalid URL」）
// - `backend/x.ts:12` や `a.md:3:4`（`backend/x.ts` や `a.md` をスキームとみなす）
// - `:` の無い `a.md` や `src/f.ts#L5-L9`（`Could not find scheme in link` で何も起きない）
// - `file:///home/u/e.md:12`（行番号ごとパスとして stat して失敗する）
//
// Claude Code 2.1.300 の実測では、`<>` の中身がそのまま OSC 8 の URI になり、絶対パスだけは
// `file:///...` に変換される（`#L3`・`:12` はそのまま残り、日本語や空白はパーセントエンコード）。
//
// ここではリンク先をパスとして解決し（リモートでは接続先のファイル）、エディタで行へ飛んで開く。
// 相対パスの起点は TerminalLocalLinkDetector にそろえ、その行の cwd（シェル統合）→ 起動時の cwd
// → ワークスペースフォルダの順に探す。http(s) などの本物の URL と、ホスト付きの file:// は
// 対象外にして upstream の処理へ戻す。解決できないときは外部へ投げず、upstream の Word リンクと
// 同じ検索（クイックオープン）にする。

import { Schemas } from '../../../../base/common/network.js';
import { OperatingSystem, OS } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITextEditorSelection } from '../../../../platform/editor/common/editor.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalCapabilityStore, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalLogService } from '../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalConfiguration, ITerminalProcessInfo, TERMINAL_CONFIG_SECTION } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { ITerminalLinkOpener, ITerminalLinkResolver, TerminalBuiltinLinkType, TerminalLinkType } from '../../../../workbench/contrib/terminalContrib/links/browser/links.js';
import { osPathModule, updateLinkWithRelativeCwd } from '../../../../workbench/contrib/terminalContrib/links/browser/terminalLinkHelpers.js';
import { getLinkSuffix, removeLinkSuffix } from '../../../../workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.js';
import { getTerminalLinkType } from '../../../../workbench/contrib/terminalContrib/links/browser/terminalLocalLinkDetector.js';
import type { IBufferRange } from '@xterm/xterm';

/**
 * An OSC 8 link target that names a file or folder rather than a URL.
 */
export interface IParadisOsc8FileTarget {
	/** The path without the line suffix or fragment, absolute or relative as written. */
	readonly path: string;
	readonly selection: ITextEditorSelection | undefined;
}

const schemeRegex = /^(?<scheme>[a-zA-Z][a-zA-Z0-9+.-]*):(?<rest>.*)$/s;
// Line fragments: `#L3`, `#L3C2`, `#L5-L9`, `#L5-9`, `#L5C1-L9C4` and the plain `#339`.
const lineFragmentRegex = /^L?(?<row>\d+)(?:C(?<col>\d+))?(?:-L?(?<rowEnd>\d+)(?:C(?<colEnd>\d+))?)?$/;
// Common file names without an extension, read as `Makefile:3` rather than as a scheme.
const extensionlessFileNames = new Set(['makefile', 'gnumakefile', 'dockerfile', 'containerfile', 'gemfile', 'rakefile', 'procfile', 'jenkinsfile', 'vagrantfile', 'brewfile', 'justfile', 'license', 'readme', 'changelog']);

/**
 * Reads an OSC 8 link target as a file path. Returns `undefined` for a real URL (http, mailto, ...)
 * and for a `file://` URI with a host, which stay with the upstream handler.
 */
export function paradisParseOsc8FileTarget(text: string, os: OperatingSystem): IParadisOsc8FileTarget | undefined {
	const scheme = schemeRegex.exec(text)?.groups?.scheme;
	if (scheme !== undefined && scheme.toLowerCase() === Schemas.file) {
		let uri: URI;
		try {
			uri = URI.parse(text);
		} catch {
			return undefined;
		}
		if (uri.authority !== '' && uri.authority.toLowerCase() !== 'localhost') {
			return undefined;
		}
		let path = uri.path;
		if (os === OperatingSystem.Windows && /^\/[a-zA-Z]:/.test(path)) {
			path = path.substring(1);
		}
		return withSelection(path, uri.fragment);
	}

	// Any fragment is dropped like a file URI's (`README.md#install` opens README.md); only a line
	// fragment selects. A `#` followed by a separator belongs to the path.
	const hashIndex = text.lastIndexOf('#');
	const hasFragment = hashIndex > 0 && !/[\\/]/.test(text.substring(hashIndex + 1));
	const pathText = hasFragment ? text.substring(0, hashIndex) : text;
	const fragment = hasFragment ? text.substring(hashIndex + 1) : '';
	if (scheme !== undefined) {
		const isWindowsDrive = os === OperatingSystem.Windows && scheme.length === 1 && /^[\\/]/.test(text.substring(2));
		// `a.md:12` and `Makefile:3:4` look like a scheme followed by a line suffix. The scheme must
		// look like a file name, so `tel:5551234` and `localhost:3000` stay URLs.
		const looksLikeFileName = scheme.includes('.') || extensionlessFileNames.has(scheme.toLowerCase());
		const isFileWithLineSuffix = looksLikeFileName && getLinkSuffix(pathText) !== null && removeLinkSuffix(pathText) === scheme;
		if (!isWindowsDrive && !isFileWithLineSuffix) {
			return undefined;
		}
	}
	return withSelection(pathText, fragment);
}

function withSelection(pathText: string, fragment: string): IParadisOsc8FileTarget | undefined {
	const fragmentMatch = lineFragmentRegex.exec(fragment)?.groups;
	if (fragmentMatch) {
		return pathText === '' ? undefined : {
			path: pathText,
			selection: {
				startLineNumber: Number(fragmentMatch.row),
				startColumn: fragmentMatch.col === undefined ? 1 : Number(fragmentMatch.col),
				endLineNumber: fragmentMatch.rowEnd === undefined ? undefined : Number(fragmentMatch.rowEnd),
				endColumn: fragmentMatch.colEnd === undefined ? undefined : Number(fragmentMatch.colEnd),
			}
		};
	}
	const suffix = getLinkSuffix(pathText);
	const path = suffix ? removeLinkSuffix(pathText) : pathText;
	if (path === '') {
		return undefined;
	}
	return {
		path,
		selection: suffix?.row === undefined ? undefined : {
			startLineNumber: suffix.row,
			startColumn: suffix.col ?? 1,
			endLineNumber: suffix.rowEnd,
			endColumn: suffix.colEnd,
		}
	};
}

/**
 * Lists the paths to try for a target, in order. An absolute path (or `~`) is used as is. A
 * relative path is tried against the line's cwd from shell integration when it is known, otherwise
 * as written (the link resolver joins it to the terminal's initial cwd), then against each
 * workspace folder.
 */
export function paradisOsc8FileCandidates(path: string, os: OperatingSystem, lineCwdCandidates: readonly string[] | undefined, workspaceFolderPaths: readonly string[]): string[] {
	const osPath = osPathModule(os);
	if (osPath.isAbsolute(path) || path.startsWith('~')) {
		return [path];
	}
	const candidates = lineCwdCandidates?.length ? [...lineCwdCandidates] : [path];
	for (const folder of workspaceFolderPaths) {
		candidates.push(osPath.join(folder, path));
	}
	return [...new Set(candidates)];
}

/**
 * The parts of the terminal's link manager needed to open an OSC 8 link.
 */
export interface IParadisOsc8LinkRequest {
	readonly text: string;
	readonly range: IBufferRange | undefined;
	readonly processInfo: Pick<ITerminalProcessInfo, 'initialCwd' | 'os' | 'remoteAuthority' | 'userHome'>;
	readonly capabilities: ITerminalCapabilityStore;
	readonly linkResolver: ITerminalLinkResolver;
	readonly openers: ReadonlyMap<TerminalLinkType, ITerminalLinkOpener>;
}

/**
 * Opens an OSC 8 link that names a file. Returns `false` when the link is a URL, file links are
 * turned off, or a `file:` link is not in `allowedLinkSchemes` (upstream then asks first), leaving
 * it to the upstream handler.
 */
export function paradisOpenOsc8FileLink(accessor: ServicesAccessor, request: IParadisOsc8LinkRequest): Promise<boolean> {
	// The accessor is only valid synchronously, so read every service before the first await.
	const configurationService = accessor.get(IConfigurationService);
	const logService = accessor.get(ITerminalLogService);
	const uriIdentityService = accessor.get(IUriIdentityService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);

	const { processInfo } = request;
	const terminalConfiguration = configurationService.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION);
	const enableFileLinks = terminalConfiguration?.enableFileLinks as ITerminalConfiguration['enableFileLinks'] | boolean | undefined;
	if (enableFileLinks === 'off' || enableFileLinks === false || (enableFileLinks === 'notRemote' && processInfo.remoteAuthority)) {
		return Promise.resolve(false);
	}
	if (/^file:/i.test(request.text) && !terminalConfiguration?.allowedLinkSchemes?.includes(Schemas.file)) {
		return Promise.resolve(false);
	}
	const os = processInfo.os ?? OS;
	const target = paradisParseOsc8FileTarget(request.text, os);
	if (!target) {
		return Promise.resolve(false);
	}

	const osPath = osPathModule(os);
	const lineCwdCandidates = request.range && request.capabilities.has(TerminalCapability.CommandDetection)
		? updateLinkWithRelativeCwd(request.capabilities, request.range.start.y, target.path, osPath, logService)
		: undefined;
	const workspaceFolderPaths = workspaceContextService.getWorkspace().folders
		.map(folder => folder.uri)
		.filter(uri => processInfo.remoteAuthority
			? uri.scheme === Schemas.vscodeRemote && uri.authority === processInfo.remoteAuthority
			: uri.scheme === Schemas.file)
		.map(uri => uri.scheme === Schemas.file ? uri.fsPath : uri.path);
	const candidates = paradisOsc8FileCandidates(target.path, os, lineCwdCandidates, workspaceFolderPaths);
	logService.trace('paradisOpenOsc8FileLink#candidates', request.text, candidates);
	return openFirstResolved(request, target, candidates, uriIdentityService, workspaceContextService);
}

async function openFirstResolved(request: IParadisOsc8LinkRequest, target: IParadisOsc8FileTarget, candidates: readonly string[], uriIdentityService: IUriIdentityService, workspaceContextService: IWorkspaceContextService): Promise<boolean> {
	const bufferRange = request.range ?? { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } };
	for (const candidate of candidates) {
		const resolved = await request.linkResolver.resolveLink(request.processInfo, candidate);
		if (!resolved) {
			continue;
		}
		const type = getTerminalLinkType(resolved.uri, resolved.isDirectory, uriIdentityService, workspaceContextService);
		await request.openers.get(type)?.open({ type, text: candidate, uri: resolved.uri, bufferRange, selection: target.selection });
		return true;
	}
	// Not found: search for it like an unresolved word link instead of handing the path to the OS.
	const row = target.selection?.startLineNumber;
	await request.openers.get(TerminalBuiltinLinkType.Search)?.open({
		type: TerminalBuiltinLinkType.Search,
		text: row === undefined ? target.path : `${target.path}:${row}`,
		bufferRange,
	});
	return true;
}
