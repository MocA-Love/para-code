/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as vscode from 'vscode';
import * as fileSchemes from '../configuration/fileSchemes';
import { isJsConfigOrTsConfigFileName, standardLanguageDescriptions } from '../configuration/languageDescription';
import { PluginManager } from '../tsServer/plugins';
import type TypeScriptServiceClientHost from '../typeScriptServiceClientHost';
import { DisposableStore } from '../utils/dispose';
import { Lazy } from '../utils/lazy';
import { ParadisTsServerIdleStop, paradisIdleStopMinutesDefault, paradisIdleStopMinutesKey, paradisIdleStopMinutesSection } from './paradisTsServerIdleStop';

/**
 * Wires {@link ParadisTsServerIdleStop} to the extension host. Documents are counted the same way
 * `lazilyActivateClient` decides to start the client, so a window that never opened JS/TS is left alone.
 * The extension host is the one that runs TS Server, so this also works when it runs on an SSH host.
 */
export function registerParadisTsServerIdleStop(
	lazyClientHost: Lazy<TypeScriptServiceClientHost>,
	pluginManager: PluginManager,
): vscode.Disposable {
	const disposables = new DisposableStore();

	const isSupportedDocument = (document: vscode.TextDocument): boolean => {
		if (fileSchemes.disabledSchemes.has(document.uri.scheme)) {
			return false;
		}
		return isJsConfigOrTsConfigFileName(document.fileName)
			|| standardLanguageDescriptions.some(description => description.languageIds.includes(document.languageId))
			|| pluginManager.plugins.some(plugin => plugin.languages.includes(document.languageId));
	};

	const idleStop = new ParadisTsServerIdleStop({
		countDocuments: () => vscode.workspace.textDocuments.filter(isSupportedDocument).length,
		isStarted: () => lazyClientHost.hasValue,
		stop: () => lazyClientHost.value.serviceClient.paradisStopTsServer(),
		getIdleStopMinutes: () => vscode.workspace.getConfiguration(paradisIdleStopMinutesSection).get<number>(paradisIdleStopMinutesKey, paradisIdleStopMinutesDefault),
		setTimeout: (callback, milliseconds) => {
			const handle = setTimeout(callback, milliseconds);
			return { cancel: () => clearTimeout(handle) };
		},
	});
	disposables.add(idleStop);

	// The server can also start without a document (workspace symbol search, a rename, ...): count from then on.
	let listensToServerStart = false;
	const update = () => {
		if (!listensToServerStart && lazyClientHost.hasValue) {
			listensToServerStart = true;
			disposables.add(lazyClientHost.value.serviceClient.onTsServerStarted(() => idleStop.update()));
		}
		idleStop.update();
	};

	disposables.add(vscode.workspace.onDidOpenTextDocument(update));
	disposables.add(vscode.workspace.onDidCloseTextDocument(update));
	disposables.add(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(`${paradisIdleStopMinutesSection}.${paradisIdleStopMinutesKey}`)) {
			update();
		}
	}));
	update();

	return disposables;
}
