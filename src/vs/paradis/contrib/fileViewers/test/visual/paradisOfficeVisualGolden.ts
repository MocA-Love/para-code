/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export interface IParadisOfficeGoldenRegion {
	readonly id: string;
	readonly serializedGeometryBytes: number;
	readonly changedGeometryBytes: number;
	readonly requiredLandmarks: readonly string[];
	readonly landmarks: readonly string[];
	readonly rawGeometryHash?: string;
}

export interface IParadisOfficeSerializedGeometryGolden {
	readonly hash: string;
	readonly regions: readonly IParadisOfficeGoldenRegion[];
}

/** Compares serialized geometry metadata. This is not a rendered-pixel comparison. */
export function assertParadisOfficeSerializedGeometryGolden(expected: IParadisOfficeSerializedGeometryGolden, actual: IParadisOfficeSerializedGeometryGolden): void {
	if (!/^[a-f0-9]{64}$/.test(expected.hash) || expected.hash !== actual.hash) {
		throw new Error('Office serialized geometry fixture hash mismatch');
	}
	for (const expectedRegion of expected.regions) {
		const actualRegion = actual.regions.find(region => region.id === expectedRegion.id);
		if (!actualRegion || !Number.isSafeInteger(actualRegion.serializedGeometryBytes) || actualRegion.serializedGeometryBytes <= 0
			|| !Number.isSafeInteger(actualRegion.changedGeometryBytes) || actualRegion.changedGeometryBytes < 0 || actualRegion.changedGeometryBytes > actualRegion.serializedGeometryBytes
			|| actualRegion.serializedGeometryBytes !== expectedRegion.serializedGeometryBytes || actualRegion.changedGeometryBytes / actualRegion.serializedGeometryBytes > 0.005) {
			throw new Error(`Office serialized geometry region mismatch: ${expectedRegion.id}`);
		}
		for (const landmark of expectedRegion.requiredLandmarks) {
			if (!actualRegion.landmarks.includes(landmark)) {
				throw new Error(`Office serialized geometry landmark missing: ${expectedRegion.id}/${landmark}`);
			}
		}
		if (expectedRegion.rawGeometryHash !== actualRegion.rawGeometryHash) {
			throw new Error(`Office serialized raw geometry mismatch: ${expectedRegion.id}`);
		}
	}
}
