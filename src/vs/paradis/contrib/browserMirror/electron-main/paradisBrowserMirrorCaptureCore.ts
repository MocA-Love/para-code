/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WebFrameMain } from 'electron';

export const PARADIS_MIRROR_CAPTURE_ENV = 'PARADIS_MIRROR_CAPTURE_VIEW';

interface IParadisMirrorCaptureWebContents {
	readonly mainFrame: WebFrameMain | null;
	isDestroyed(): boolean;
}

export interface IParadisMirrorCaptureHost {
	fromDevToolsTargetId(targetId: string): IParadisMirrorCaptureWebContents | undefined;
	getAllWebContents(): readonly IParadisMirrorCaptureWebContents[];
	isBrowserViewWebContents(webContents: IParadisMirrorCaptureWebContents): boolean;
}

export class ParadisBrowserMirrorCapture {

	private static readonly armTtl = 15_000;

	private armedTargetId: string | undefined;
	private armedExpiresAt = 0;

	constructor(private readonly host: IParadisMirrorCaptureHost) { }

	arm(targetId: string): void {
		this.armedTargetId = targetId;
		this.armedExpiresAt = Date.now() + ParadisBrowserMirrorCapture.armTtl;
	}

	resolve(): WebFrameMain | 'deny' | undefined {
		if (this.armedTargetId !== undefined) {
			const targetId = this.armedTargetId;
			const expired = Date.now() > this.armedExpiresAt;
			this.armedTargetId = undefined;
			if (expired) {
				return 'deny';
			}
			const webContents = this.host.fromDevToolsTargetId(targetId);
			if (webContents && !webContents.isDestroyed() && webContents.mainFrame) {
				return webContents.mainFrame;
			}
			return 'deny';
		}

		if (!process.env[PARADIS_MIRROR_CAPTURE_ENV]) {
			return undefined;
		}

		for (const webContents of this.host.getAllWebContents()) {
			if (webContents.isDestroyed()) {
				continue;
			}
			if (this.host.isBrowserViewWebContents(webContents)) {
				return webContents.mainFrame ?? undefined;
			}
		}

		return undefined;
	}
}
