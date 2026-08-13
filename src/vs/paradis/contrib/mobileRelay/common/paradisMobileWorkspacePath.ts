/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { extUri, extUriBiasedIgnorePathCase, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/**
 * Resolves a mobile file request to its canonical target below the workspace root.
 * Returning the canonical URI prevents a checked symlink alias from being swapped
 * to an outside target before the caller performs the file operation.
 */
export async function paradisResolveMobileWorkspacePath(fileService: Pick<IFileService, 'realpath'>, root: URI, relPath: string): Promise<URI | undefined> {
	// The mobile protocol carries slash-separated relative paths. Reject every other
	// path namespace before joining so Windows drive and UNC paths cannot be reinterpreted.
	if (relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relPath)) {
		return undefined;
	}
	const segments = relPath.split('/').filter(segment => segment.length > 0);
	if (segments.some(segment => segment === '.' || segment === '..')) {
		return undefined;
	}
	// fileService.realpath can return native Windows syntax in URI.path. Normalize it
	// before comparing it with the URI-form workspace root.
	const normalizeRealUri = (resource: URI): URI => resource.scheme === 'file' && (resource.path.includes('\\') || !resource.path.startsWith('/'))
		? URI.file(resource.path)
		: resource;
	const candidate = segments.length === 0 ? root : joinPath(root, ...segments);
	const resolveOnce = async (): Promise<URI | undefined> => {
		const [real, realRoot] = await Promise.all([
			fileService.realpath(candidate),
			fileService.realpath(root),
		]);
		if (!real || !realRoot) {
			return undefined;
		}
		const realUri = normalizeRealUri(real);
		const realRootUri = normalizeRealUri(realRoot);
		// Remote providers can be case-sensitive regardless of the renderer host OS. Only
		// local file URIs use the host-aware comparison; every other scheme is conservative.
		const identity = realRootUri.scheme === 'file' ? extUriBiasedIgnorePathCase : extUri;
		if (!identity.isEqualOrParent(realUri, realRootUri)) {
			return undefined;
		}
		return identity.isEqualOrParent(realUri, realRootUri) ? realUri : undefined;
	};
	// Run the same verification immediately before returning to the caller. This detects
	// replacement of the target or an ancestor during the first realpath resolution.
	const first = await resolveOnce();
	const second = first ? await resolveOnce() : undefined;
	const identity = root.scheme === 'file' ? extUriBiasedIgnorePathCase : extUri;
	return first && second && identity.isEqual(first, second) ? second : undefined;
}

/** Creates the dedicated, sanitized destination used for a mobile attachment upload. */
export function paradisCreateMobileUploadTarget(userRoamingDataHome: URI, originalName: string, timestamp = Date.now(), randomSuffix = Math.random().toString(36).slice(2, 8)): URI {
	const dot = originalName.lastIndexOf('.');
	const extension = dot >= 0 ? originalName.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) : '';
	const safeSuffix = randomSuffix.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
	const directory = joinPath(userRoamingDataHome, 'paraMobileUploads');
	return joinPath(directory, `attachment-${timestamp}-${safeSuffix}${extension ? `.${extension}` : ''}`);
}
