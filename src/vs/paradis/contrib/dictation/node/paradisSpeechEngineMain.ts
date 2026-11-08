/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 音声認識の utility process の入口（upstream の localTranscriptionMain の代わり）。renderer の
// ParadisLocalTranscriptionService がウィンドウごとに、初めて音声入力をしたときに起動する。
// 配布版に入れるため build/next/index.ts の desktopEntryPoints にも載せてある。

import { dirname } from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../../base/parts/sandbox/node/electronTypes.js';
import { PARADIS_SPEECH_ENGINE_CHANNEL } from '../common/paradisSpeechEngine.js';
import { createParadisSpeechEngineHost, ParadisSpeechEngine } from './paradisSpeechEngineService.js';

if (!isUtilityProcess(process)) {
	throw new Error('paradisSpeechEngineMain must run in a utility process');
}

// FileAccess.asFileUri('') は out/ を指す。その親がアプリの root（配布版は Contents/Resources/app）
const appRoot = dirname(FileAccess.asFileUri('').fsPath);
const server = new UtilityProcessServer();
const engine = new ParadisSpeechEngine(createParadisSpeechEngineHost(process.platform, appRoot, !!process.env['VSCODE_DEV']));
server.registerChannel(PARADIS_SPEECH_ENGINE_CHANNEL, ProxyChannel.fromService(engine, new DisposableStore()));
