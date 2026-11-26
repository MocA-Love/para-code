/*---------------------------------------------------------------------------------------------
 *  Para Code additions to the vendored chrome-devtools-mcp (Apache-2.0 package, see ../LICENSE).
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode or in the chrome-devtools-mcp package. See CLAUDE.md.

// The performance tools (`../build/src/tools/performance.js`, PARA-PATCH) call into this file. It lives outside
// `build/` so that replacing `build/` on a package update does not delete it, and it imports nothing so that the
// unit tests can load it without the 6.5 MB DevTools bundle.
//
//   - Saving: Chrome DevTools' "Save performance trace" can keep the script sources ("Include script content",
//     the `v8-source-rundown-sources` events plus `metadata.enhancedTraceVersion`) and the source maps
//     (`metadata.sourceMaps`, read back by the trace engine's `findCachedRawSourceMap`). The upstream tool saves the
//     raw buffer of `Tracing.end` and has neither.
//     Only scripts that the page's DevTools universe knows are kept. In Electron the trace lists the scripts of
//     the whole application (the workbench, Node internals, extensions), and the CDP gateway of Para Code hides the
//     scripts of its own isolated worlds and of browser extensions from `Debugger.scriptParsed`
//     (paradisCdpIsolatedWorldFilter.ts). Neither must reach the agent through the saved file.
//   - Insights: the formatter prints the positions of the generated (minified) code. The DevTools universe of the
//     page has already loaded the source maps, so the original positions are added as extra lines.

/** Categories that list the scripts of the page (URL, source map URL) without their text. */
export const PARADIS_SCRIPT_LIST_CATEGORIES = Object.freeze([
	'disabled-by-default-devtools.target-rundown',
	'disabled-by-default-devtools.v8-source-rundown',
]);

/** Category that carries the text of every script (inline scripts too). */
export const PARADIS_SCRIPT_SOURCE_CATEGORY = 'disabled-by-default-devtools.v8-source-rundown-sources';

/** `metadata.enhancedTraceVersion` that DevTools writes when the script content is kept. */
export const PARADIS_ENHANCED_TRACE_VERSION = 1;

/** How long to wait for source maps that are still loading when the trace stops. */
const SOURCE_MAP_WAIT_MS = 3_000;

/**
 * The save options of one recording, from the arguments of performance_start_trace.
 * @param {{ includeScriptContent?: unknown, includeSourceMaps?: unknown } | undefined} params
 * @returns {{ includeScriptContent: boolean, includeSourceMaps: boolean }}
 */
export function paradisTraceSaveOptions(params) {
	return {
		includeScriptContent: params?.includeScriptContent === true,
		includeSourceMaps: params?.includeSourceMaps === true,
	};
}

/**
 * The trace categories to add for the given save options. The categories are fixed when the recording starts,
 * which is why the options are arguments of performance_start_trace and not of performance_stop_trace.
 * @param {{ includeScriptContent: boolean, includeSourceMaps: boolean }} options
 * @returns {string[]}
 */
export function paradisExtraTraceCategories(options) {
	if (!options.includeScriptContent && !options.includeSourceMaps) {
		return [];
	}
	return options.includeScriptContent ? [...PARADIS_SCRIPT_LIST_CATEGORIES, PARADIS_SCRIPT_SOURCE_CATEGORY] : [...PARADIS_SCRIPT_LIST_CATEGORIES];
}

/**
 * @typedef {{ lineNumber: number, columnNumber: number, sourceURL?: string, sourceLineNumber: number, sourceColumnNumber: number, name?: string }} ParadisSourceMapEntry
 * @typedef {{ url(): string, json(): unknown, findEntry(line: number, column: number): ParadisSourceMapEntry | null }} ParadisSourceMap
 * @typedef {{ byScriptId: Map<string, ParadisSourceMap>, byUrl: Map<string, ParadisSourceMap>, saved: { url: string, sourceMapUrl?: string, sourceMap: unknown }[], visibleScripts: Map<string, string> }} ParadisSourceMaps
 */

/**
 * Collects the scripts the DevTools universe of the page knows (`visibleScripts`, script id -> URL) and the source
 * maps it has loaded (it loads them for the stack traces of console messages already, so nothing new is fetched here).
 * @param {{ scripts(): Iterable<{ scriptId: string, sourceURL: string, sourceMapURL?: string }>, sourceMapManager(): { sourceMapForClientPromise(script: unknown): Promise<ParadisSourceMap | undefined> } } | null | undefined} debuggerModel
 * @param {number} [waitMs]
 * @returns {Promise<ParadisSourceMaps>}
 */
export async function paradisCollectSourceMaps(debuggerModel, waitMs = SOURCE_MAP_WAIT_MS) {
	/** @type {ParadisSourceMaps} */
	const result = { byScriptId: new Map(), byUrl: new Map(), saved: [], visibleScripts: new Map() };
	if (!debuggerModel) {
		return result;
	}
	const manager = debuggerModel.sourceMapManager();
	const allScripts = [...debuggerModel.scripts()];
	for (const script of allScripts) {
		result.visibleScripts.set(String(script.scriptId), script.sourceURL ?? '');
	}
	const scripts = allScripts.filter(script => !!script.sourceMapURL);
	let timer;
	const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve(undefined), waitMs); });
	const loaded = await Promise.all(scripts.map(script => Promise.race([manager.sourceMapForClientPromise(script).catch(() => undefined), timedOut])));
	clearTimeout(timer);
	const savedKeys = new Set();
	scripts.forEach((script, index) => {
		const sourceMap = loaded[index];
		if (!sourceMap) {
			return;
		}
		result.byScriptId.set(String(script.scriptId), sourceMap);
		if (!script.sourceURL) {
			return;
		}
		result.byUrl.set(script.sourceURL, sourceMap);
		// A `data:` source map URL is not written: the trace engine looks those up by the URL of the script.
		const mapUrl = sourceMap.url();
		const sourceMapUrl = mapUrl && !mapUrl.startsWith('data:') ? mapUrl : undefined;
		const key = `${script.sourceURL}\n${sourceMapUrl ?? ''}`;
		if (!savedKeys.has(key)) {
			savedKeys.add(key);
			result.saved.push({ url: script.sourceURL, ...(sourceMapUrl ? { sourceMapUrl } : {}), sourceMap: sourceMap.json() });
		}
	});
	return result;
}

/** The three categories whose events describe scripts (list, frame of a script, text). */
const SCRIPT_EVENT_CATEGORIES = new Set([...PARADIS_SCRIPT_LIST_CATEGORIES, PARADIS_SCRIPT_SOURCE_CATEGORY]);

/**
 * The scripts of the trace (`isolate:scriptId`) that the page's DevTools universe knows.
 *
 * In Electron the trace is not limited to the page: on a real Para Code window the list had 1,378 scripts of 3
 * isolates (the workbench, Node internals, extensions), and script ids repeat across isolates. So an isolate counts
 * as the page's only when one of its scripts has the id and the non-empty URL of a script the debugger knows, and
 * within such an isolate a script is kept only when its id is known and its URL agrees.
 * @param {any[]} events
 * @param {Map<string, string>} visibleScripts script id -> URL, from the debugger of the page
 * @returns {Set<string>}
 */
function visibleScriptKeys(events, visibleScripts) {
	/** @type {{ isolate: string, scriptId: string, url: string }[]} */
	const listed = [];
	for (const event of events) {
		const data = event?.args?.data;
		if (event?.cat === PARADIS_SCRIPT_LIST_CATEGORIES[1] && data && data.scriptId !== undefined && data.isolate !== undefined) {
			listed.push({ isolate: String(data.isolate), scriptId: String(data.scriptId), url: data.sourceUrl || data.url || '' });
		}
	}
	const pageIsolates = new Set();
	for (const script of listed) {
		if (script.url && visibleScripts.get(script.scriptId) === script.url) {
			pageIsolates.add(script.isolate);
		}
	}
	const keys = new Set();
	for (const script of listed) {
		const visibleUrl = visibleScripts.get(script.scriptId);
		if (visibleUrl === undefined || !pageIsolates.has(script.isolate)) {
			continue;
		}
		// A `//# sourceURL=` can be relative in the trace and resolved by the debugger.
		const sameUrl = script.url === visibleUrl || (!!script.url && !!visibleUrl && (visibleUrl.endsWith(script.url) || script.url.endsWith(visibleUrl)));
		if (sameUrl) {
			keys.add(`${script.isolate}:${script.scriptId}`);
		}
	}
	return keys;
}

/**
 * Rewrites the raw buffer of `Tracing.end` into the file DevTools would save with the given options. Of the events
 * that describe scripts, only those of scripts the page's DevTools universe knows are kept (see the top of this
 * file), and their text only with `includeScriptContent`.
 * @param {Uint8Array} buffer
 * @param {{ includeScriptContent: boolean, includeSourceMaps: boolean }} options
 * @param {ParadisSourceMaps | undefined} sourceMaps
 * @returns {{ data: Uint8Array, sourceMapCount: number, scriptSourceCount: number }}
 */
export function paradisRewriteTraceForSave(buffer, options, sourceMaps) {
	const parsed = JSON.parse(new TextDecoder().decode(buffer));
	const trace = Array.isArray(parsed) ? { traceEvents: parsed } : parsed;
	const metadata = { ...(trace.metadata ?? {}) };
	const events = Array.isArray(trace.traceEvents) ? trace.traceEvents : [];
	const kept = visibleScriptKeys(events, sourceMaps?.visibleScripts ?? new Map());
	const keptSources = new Set();
	const savedEvents = events.filter(event => {
		if (!SCRIPT_EVENT_CATEGORIES.has(event?.cat)) {
			return true;
		}
		const key = `${event.args?.data?.isolate}:${event.args?.data?.scriptId}`;
		if (!kept.has(key)) {
			return false;
		}
		if (event.cat !== PARADIS_SCRIPT_SOURCE_CATEGORY) {
			return true;
		}
		if (options.includeScriptContent) {
			keptSources.add(key);
		}
		return options.includeScriptContent;
	});
	if (options.includeScriptContent) {
		metadata.enhancedTraceVersion = PARADIS_ENHANCED_TRACE_VERSION;
	}
	let sourceMapCount = 0;
	if (options.includeSourceMaps) {
		metadata.sourceMaps = sourceMaps?.saved ?? [];
		sourceMapCount = metadata.sourceMaps.length;
	}
	return { data: new TextEncoder().encode(JSON.stringify({ ...trace, traceEvents: savedEvents, metadata })), sourceMapCount, scriptSourceCount: keptSources.size };
}

/**
 * What to write to the file, and what to tell the agent about it. Without the options the file is the raw buffer,
 * byte for byte. With them, a recording that cannot be rewritten is not saved at all: its raw buffer lists the
 * scripts of the whole application (and their text with `includeScriptContent`), unfiltered.
 * @param {Uint8Array} buffer
 * @param {{ includeScriptContent: boolean, includeSourceMaps: boolean }} options
 * @param {ParadisSourceMaps | undefined} sourceMaps
 * @returns {{ data: Uint8Array | undefined, lines: string[] }}
 */
export function paradisPrepareTraceSave(buffer, options, sourceMaps) {
	if (!options.includeScriptContent && !options.includeSourceMaps) {
		return { data: buffer, lines: [] };
	}
	try {
		const rewritten = paradisRewriteTraceForSave(buffer, options, sourceMaps);
		const parts = [];
		if (options.includeScriptContent) {
			parts.push(`the text of ${rewritten.scriptSourceCount} script(s) of the page as it is now (scripts of earlier documents and of other frames are not included)`);
		}
		if (options.includeSourceMaps) {
			parts.push(`${rewritten.sourceMapCount} source map(s)`);
		}
		return { data: rewritten.data, lines: [`The saved trace includes ${parts.join(' and ')}. It can hold anything those contain; do not share it more widely than the page source.`] };
	}
	catch (error) {
		return { data: undefined, lines: [`The trace was not saved: the script content and source maps could not be added (${error instanceof Error ? error.message : error}). Record again without includeScriptContent and includeSourceMaps to save the raw trace.`] };
	}
}

/**
 * @typedef {{ functionName?: string, url?: string, scriptId?: string | number, lineNumber?: number, columnNumber?: number }} ParadisCallFrame
 */

/**
 * The text the insight formatter prints for a call frame (`formatForcedReflowInsight` of the DevTools bundle).
 * @param {ParadisCallFrame} frame
 */
function printedCallFrame(frame) {
	return `${frame.functionName || '(anonymous)'} @ ${frame.url}:${frame.lineNumber}:${frame.columnNumber}`;
}

/**
 * @param {ParadisCallFrame} frame
 * @param {boolean} oneBased whether the line and column of the frame count from 1 (trace event payloads) and not from 0 (profile call frames)
 * @param {boolean} functionStart whether the position is where the function starts (its name is then the mapping right there or just before)
 * @param {ParadisSourceMaps} sourceMaps
 * @returns {string | undefined}
 */
function originalLocationLine(frame, oneBased, functionStart, sourceMaps) {
	if (!frame?.url || typeof frame.lineNumber !== 'number' || typeof frame.columnNumber !== 'number') {
		return undefined;
	}
	const sourceMap = (frame.scriptId !== undefined ? sourceMaps.byScriptId.get(String(frame.scriptId)) : undefined) ?? sourceMaps.byUrl.get(frame.url);
	if (!sourceMap) {
		return undefined;
	}
	const line = Math.max(0, frame.lineNumber - (oneBased ? 1 : 0));
	const column = Math.max(0, frame.columnNumber - (oneBased ? 1 : 0));
	const entry = sourceMap.findEntry(line, column);
	if (!entry?.sourceURL) {
		return undefined;
	}
	let name;
	if (functionStart) {
		const before = column > 0 ? sourceMap.findEntry(line, column - 1) : null;
		name = entry.name ?? (before?.sourceURL === entry.sourceURL && before.sourceLineNumber === entry.sourceLineNumber ? before.name : undefined);
	}
	return ` - ${printedCallFrame(frame)} -> ${name ? `${name} @ ` : ''}${entry.sourceURL}:${entry.sourceLineNumber + 1}:${entry.sourceColumnNumber + 1}`;
}

/**
 * Lines that give the original source position of the call frames an insight prints, or none when the insight
 * prints no call frames or no source map covers them. Only the forced reflow insight prints call frames today.
 * @param {unknown} insight the insight model (`insightSet.model[insightName]`)
 * @param {ParadisSourceMaps | undefined} sourceMaps
 * @returns {string[]}
 */
export function paradisOriginalLocationLines(insight, sourceMaps) {
	if (!insight || typeof insight !== 'object' || !sourceMaps || sourceMaps.byUrl.size + sourceMaps.byScriptId.size === 0) {
		return [];
	}
	const lines = new Set();
	const add = line => { if (line) { lines.add(line); } };
	const top = /** @type {{ topLevelFunctionCallData?: { topLevelFunctionCall?: ParadisCallFrame, topLevelFunctionCallEvents?: object[] } }} */ (insight).topLevelFunctionCallData;
	if (top?.topLevelFunctionCall) {
		// A profile call carries a 0-based `callFrame`; a FunctionCall event carries 1-based `args.data`.
		const fromProfile = !!top.topLevelFunctionCallEvents?.[0] && 'callFrame' in top.topLevelFunctionCallEvents[0];
		add(originalLocationLine(top.topLevelFunctionCall, !fromProfile, true, sourceMaps));
	}
	const bottomUp = /** @type {{ aggregatedBottomUpData?: { bottomUpData?: ParadisCallFrame | null }[] }} */ (insight).aggregatedBottomUpData;
	if (Array.isArray(bottomUp)) {
		for (const data of bottomUp) {
			if (data?.bottomUpData) {
				add(originalLocationLine(data.bottomUpData, false, false, sourceMaps));
			}
		}
	}
	if (lines.size === 0) {
		return [];
	}
	return ['Original source positions of the call frames below, from the source maps of the page (generated -> original, original as line:column counted from 1):', ...lines, ''];
}
