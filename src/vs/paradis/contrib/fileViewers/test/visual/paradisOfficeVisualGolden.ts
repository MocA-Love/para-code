/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export interface IParadisOfficeGoldenRegion {
	readonly id: string;
	readonly pixels: number;
	readonly changedPixels: number;
	readonly requiredLandmarks: readonly string[];
	readonly landmarks: readonly string[];
	readonly rawGeometryHash?: string;
}

export interface IParadisOfficeVisualGolden {
	readonly hash: string;
	readonly regions: readonly IParadisOfficeGoldenRegion[];
}

/** Fails closed when a fixture changes, a required visual landmark is absent, or a region differs by more than 0.5%. */
export function assertParadisOfficeVisualGolden(expected: IParadisOfficeVisualGolden, actual: IParadisOfficeVisualGolden): void {
	if (!/^[a-f0-9]{64}$/.test(expected.hash) || expected.hash !== actual.hash) {
		throw new Error('Office visual fixture hash mismatch');
	}
	for (const expectedRegion of expected.regions) {
		const actualRegion = actual.regions.find(region => region.id === expectedRegion.id);
		if (!actualRegion || !Number.isSafeInteger(actualRegion.pixels) || actualRegion.pixels <= 0
			|| !Number.isSafeInteger(actualRegion.changedPixels) || actualRegion.changedPixels < 0 || actualRegion.changedPixels > actualRegion.pixels
			|| actualRegion.pixels !== expectedRegion.pixels || actualRegion.changedPixels / actualRegion.pixels > 0.005) {
			throw new Error(`Office visual region mismatch: ${expectedRegion.id}`);
		}
		for (const landmark of expectedRegion.requiredLandmarks) {
			if (!actualRegion.landmarks.includes(landmark)) {
				throw new Error(`Office visual landmark missing: ${expectedRegion.id}/${landmark}`);
			}
		}
		if (expectedRegion.rawGeometryHash !== actualRegion.rawGeometryHash) {
			throw new Error(`Office visual raw geometry mismatch: ${expectedRegion.id}`);
		}
	}
}
