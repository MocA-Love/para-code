/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export type ParadisDesktopPlatform = 'darwin' | 'win32' | 'linux';

export interface IParadisDesktopUpdatePlatformOptions {
	readonly darwinUniversalAssetId?: string;
	readonly isArchive?: boolean;
	readonly target?: string;
}

export function getParadisDesktopUpdatePlatform(platform: ParadisDesktopPlatform, arch: string, options: IParadisDesktopUpdatePlatformOptions = {}): string {
	switch (platform) {
		case 'darwin':
			return options.darwinUniversalAssetId ?? (arch === 'x64' ? 'darwin' : 'darwin-arm64');
		case 'win32': {
			const base = `win32-${arch}`;
			if (options.isArchive) {
				return `${base}-archive`;
			}
			return options.target === 'user' ? `${base}-user` : base;
		}
		case 'linux':
			return `linux-${arch}`;
	}
}
