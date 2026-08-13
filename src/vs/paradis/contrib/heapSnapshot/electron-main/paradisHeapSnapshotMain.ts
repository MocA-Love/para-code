/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { app } from 'electron';
import { statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { getHeapSpaceStatistics, writeHeapSnapshot } from 'v8';
import { isLinux } from '../../../../base/common/platform.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisHeapSnapshotChannelHost, IParadisHeapSnapshotDependencies, ParadisHeapSnapshotMainService, paradisRegisterHeapSnapshot as registerHeapSnapshot } from './paradisHeapSnapshotCore.js';

const defaultDependencies: IParadisHeapSnapshotDependencies = {
	isLinux,
	userDataDirectory: () => app.getPath('userData'),
	temporaryDirectory: tmpdir,
	uptime: process.uptime,
	heapSpaceStatistics: getHeapSpaceStatistics,
	writeHeapSnapshot,
	stat: statSync,
	unlink: unlinkSync,
};

/** app.ts の PARA-PATCH 点から既存 heap snapshot channel を登録する。 */
export function paradisRegisterHeapSnapshot(channelHost: IParadisHeapSnapshotChannelHost): IDisposable {
	return registerHeapSnapshot(channelHost, new ParadisHeapSnapshotMainService(defaultDependencies));
}
