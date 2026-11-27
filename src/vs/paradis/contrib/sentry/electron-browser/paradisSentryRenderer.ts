/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { env } from '../../../../base/common/process.js';
import { context } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import type { INativeWindowConfiguration } from '../../../../platform/window/common/window.js';
import { isParadisSentryDevelopmentBuild } from '../common/paradisSentryConfiguration.js';

// Builds run out of sources do not report (see isParadisSentryDevelopmentBuild). Main skips its own
// init under the same test, so there would be nothing to forward renderer events to anyway. Without a
// client, the diagnostic reporter and span runner stay unset and their callers are no-ops.
// The same goes when the user turned crash reporting off: main decides that and passes it in the
// window configuration (not the environment, which a Linux renderer forked from the zygote may miss).
//
// This file must not import `@sentry/...` (statically or through another module): builds run out of
// sources load `out/` as plain browser ESM, where a bare specifier cannot resolve, and one failed
// import fails the whole workbench import and leaves the window blank. The client is loaded on
// demand instead; the packaged bundle inlines it (see paradisSentryRendererClient.ts).
if (!isParadisSentryDevelopmentBuild(env) && !(context.configuration() as INativeWindowConfiguration | undefined)?.paradisSentryDisabled) {
	import('./paradisSentryRendererClient.js').then(client => client.startParadisRendererSentry(), error => {
		console.error('[Para Code] Failed to load renderer Sentry.', error);
	});
}
