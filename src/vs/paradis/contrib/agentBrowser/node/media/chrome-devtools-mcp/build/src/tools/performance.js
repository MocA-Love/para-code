/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import zlib from 'node:zlib';
import { logger } from '../logger.js';
import { zod, DevTools } from '../third_party/index.js';
import { parseRawTraceBuffer, traceResultIsSuccess, } from '../trace-processing/parse.js';
import { ToolCategory } from './categories.js';
import { definePageTool } from './ToolDefinition.js';
// PARA-PATCH: saving the script content and the source maps with the trace, and the original source positions of
// the call frames an insight prints. The logic is in a fork-owned file outside build/ (see NOTES.md).
import { paradisCollectSourceMaps, paradisExtraTraceCategories, paradisOriginalLocationLines, paradisRewriteTraceForSave, paradisTraceSaveOptions, } from '../../../paradis/paradisTraceExtras.js';
// PARA-PATCH: the save options of the running trace. The trace categories are fixed at the start, so
// performance_stop_trace saves with what performance_start_trace asked for.
let paradisRunningSaveOptions = paradisTraceSaveOptions(undefined);
const filePathSchema = zod
    .string()
    .optional()
    .describe('The absolute file path, or a file path relative to the current working directory, to save the raw trace data. For example, trace.json.gz (compressed) or trace.json (uncompressed).');
export const startTrace = definePageTool({
    name: 'performance_start_trace',
    description: `Start a performance trace on the selected webpage. Use to find frontend performance issues, Core Web Vitals (LCP, INP, CLS), and improve page load speed.`,
    annotations: {
        category: ToolCategory.PERFORMANCE,
        readOnlyHint: false,
    },
    schema: {
        reload: zod
            .boolean()
            .default(true)
            .describe('Determines if, once tracing has started, the current selected page should be automatically reloaded. Navigate the page to the right URL using the navigate_page tool BEFORE starting the trace if reload or autoStop is set to true.'),
        autoStop: zod
            .boolean()
            .default(true)
            .describe('Determines if the trace recording should be automatically stopped.'),
        filePath: filePathSchema,
        // PARA-PATCH: the two options of "Save performance trace" in Chrome DevTools (off by default).
        includeScriptContent: zod
            .boolean()
            .optional()
            .describe('Keep the text of the scripts of the page (inline scripts too; the page as it is when the trace stops) in the saved file, like "Include script content" in Chrome DevTools, so that the file still shows the code after the page changes. Needs filePath. The file grows by the size of the scripts and holds whatever they contain, so treat it like the page source. Applies to the file performance_stop_trace saves as well.'),
        includeSourceMaps: zod
            .boolean()
            .optional()
            .describe('Keep the source maps of the page in the saved file (metadata.sourceMaps), like "Include script source maps" in Chrome DevTools, so that the file can be read in original source positions offline. Needs filePath. Source maps often embed the original source code (sourcesContent), which then is in the file too. Applies to the file performance_stop_trace saves as well.'),
    },
    blockedByDialog: true,
    verifyFilesSchema: ['filePath'],
    handler: async (request, response, context) => {
        if (context.isRunningPerformanceTrace()) {
            response.appendResponseLine('Error: a performance trace is already running. Use performance_stop_trace to stop it. Only one trace can be running at any given time.');
            return;
        }
        context.setIsRunningPerformanceTrace(true);
        const page = request.page;
        const pageUrlForTracing = page.pptrPage.url();
        if (request.params.reload) {
            // Before starting the recording, navigate to about:blank to clear out any state.
            await page.pptrPage.goto('about:blank', {
                waitUntil: ['networkidle0'],
            });
        }
        // Keep in sync with the categories arrays in:
        // https://source.chromium.org/chromium/chromium/src/+/main:third_party/devtools-frontend/src/front_end/panels/timeline/TimelineController.ts
        // https://github.com/GoogleChrome/lighthouse/blob/master/lighthouse-core/gather/gatherers/trace.js
        const categories = [
            '-*',
            'blink.console',
            'blink.user_timing',
            'devtools.timeline',
            'disabled-by-default-devtools.screenshot',
            'disabled-by-default-devtools.timeline',
            'disabled-by-default-devtools.timeline.invalidationTracking',
            'disabled-by-default-devtools.timeline.frame',
            'disabled-by-default-devtools.timeline.stack',
            'disabled-by-default-v8.cpu_profiler',
            'disabled-by-default-v8.cpu_profiler.hires',
            'latencyInfo',
            'loading',
            'disabled-by-default-lighthouse',
            'v8.execute',
            'v8',
        ];
        // PARA-PATCH: record the list of scripts (and their text) only when the saved file should carry them.
        paradisRunningSaveOptions = paradisTraceSaveOptions(request.params);
        categories.push(...paradisExtraTraceCategories(paradisRunningSaveOptions));
        await page.pptrPage.tracing.start({
            categories,
        });
        if (request.params.reload) {
            await page.pptrPage.goto(pageUrlForTracing, {
                waitUntil: ['load'],
            });
        }
        if (request.params.autoStop) {
            await new Promise(resolve => setTimeout(resolve, 5_000));
            await stopTracingAndAppendOutput(page, response, context, request.params.filePath);
        }
        else {
            response.appendResponseLine(`The performance trace is being recorded. Use performance_stop_trace to stop it.`);
        }
    },
});
export const stopTrace = definePageTool({
    name: 'performance_stop_trace',
    description: 'Stop the active performance trace recording on the selected webpage.',
    annotations: {
        category: ToolCategory.PERFORMANCE,
        readOnlyHint: false,
    },
    schema: {
        filePath: filePathSchema,
    },
    blockedByDialog: true,
    verifyFilesSchema: ['filePath'],
    handler: async (request, response, context) => {
        if (!context.isRunningPerformanceTrace()) {
            return;
        }
        const page = request.page;
        await stopTracingAndAppendOutput(page, response, context, request.params.filePath);
    },
});
export const analyzeInsight = definePageTool({
    name: 'performance_analyze_insight',
    description: 'Provides more detailed information on a specific Performance Insight of an insight set that was highlighted in the results of a trace recording.',
    annotations: {
        category: ToolCategory.PERFORMANCE,
        readOnlyHint: true,
    },
    schema: {
        insightSetId: zod
            .string()
            .describe('The id for the specific insight set. Only use the ids given in the "Available insight sets" list.'),
        insightName: zod
            .string()
            .describe('The name of the Insight you want more information on. For example: "DocumentLatency" or "LCPBreakdown"'),
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response, context) => {
        const lastRecording = context.recordedTraces().at(-1);
        if (!lastRecording) {
            response.appendResponseLine('No recorded traces found. Record a performance trace so you have Insights to analyze.');
            return;
        }
        // PARA-PATCH: the formatter prints positions in the generated (minified) code; add the original ones.
        try {
            const paradisInsight = lastRecording.insights?.get(request.params.insightSetId)?.model?.[request.params.insightName];
            for (const line of paradisOriginalLocationLines(paradisInsight, lastRecording.paradisSourceMaps)) {
                response.appendResponseLine(line);
            }
        }
        catch (error) {
            logger?.(`Para Code: resolving original source positions failed: ${error}`);
        }
        response.attachTraceInsight(lastRecording, request.params.insightSetId, request.params.insightName);
    },
});
async function stopTracingAndAppendOutput(page, response, context, filePath) {
    try {
        const traceEventsBuffer = await page.pptrPage.tracing.stop();
        // PARA-PATCH: take the source maps the DevTools universe of the page has loaded, before the page moves on.
        const paradisSaveOptions = paradisRunningSaveOptions;
        paradisRunningSaveOptions = paradisTraceSaveOptions(undefined);
        let paradisSourceMaps;
        try {
            paradisSourceMaps = await paradisCollectSourceMaps(context.getDevToolsUniverse(page)?.target.model(DevTools.DebuggerModel));
        }
        catch (error) {
            logger?.(`Para Code: collecting source maps failed: ${error}`);
        }
        const paradisWantsExtras = paradisSaveOptions.includeScriptContent || paradisSaveOptions.includeSourceMaps;
        if (paradisWantsExtras && !filePath) {
            response.appendResponseLine('includeScriptContent and includeSourceMaps only change the saved file; no filePath was given, so nothing was saved.');
        }
        if (filePath && traceEventsBuffer) {
            let dataToWrite = traceEventsBuffer;
            // PARA-PATCH: without the options the file stays the raw buffer, byte for byte.
            if (paradisWantsExtras) {
                try {
                    const rewritten = paradisRewriteTraceForSave(traceEventsBuffer, paradisSaveOptions, paradisSourceMaps);
                    dataToWrite = rewritten.data;
                    const parts = [];
                    if (paradisSaveOptions.includeScriptContent) {
                        parts.push(`the text of ${rewritten.scriptSourceCount} script(s) of the page as it is now (scripts of earlier documents and of other frames are not included)`);
                    }
                    if (paradisSaveOptions.includeSourceMaps) {
                        parts.push(`${rewritten.sourceMapCount} source map(s)`);
                    }
                    response.appendResponseLine(`The saved trace includes ${parts.join(' and ')}. It can hold anything those contain; do not share it more widely than the page source.`);
                }
                catch (error) {
                    response.appendResponseLine(`The script content and source maps could not be added (${error instanceof Error ? error.message : error}); the raw trace was saved without them.`);
                }
            }
            const paradisBufferToCompress = dataToWrite;
            if (filePath.endsWith('.gz')) {
                dataToWrite = await new Promise((resolve, reject) => {
                    zlib.gzip(paradisBufferToCompress, (error, result) => {
                        if (error) {
                            reject(error);
                        }
                        else {
                            resolve(result);
                        }
                    });
                });
            }
            const file = await context.saveFile(dataToWrite, filePath, filePath.endsWith('.gz') ? '.json.gz' : '.json');
            response.appendResponseLine(`The raw trace data was saved to ${file.filename}.`);
        }
        const result = await parseRawTraceBuffer(traceEventsBuffer, {
            cpuThrottling: page.cpuThrottlingRate,
            networkThrottling: page.networkConditions ?? undefined,
        });
        response.appendResponseLine('The performance trace has been stopped.');
        if (traceResultIsSuccess(result)) {
            if (context.isCruxEnabled()) {
                await populateCruxData(result);
            }
            // PARA-PATCH: kept with the recording for performance_analyze_insight.
            result.paradisSourceMaps = paradisSourceMaps;
            context.storeTraceRecording(result);
            response.attachTraceSummary(result);
        }
        else {
            throw new Error(`There was an unexpected error parsing the trace: ${result.error}`);
        }
    }
    finally {
        context.setIsRunningPerformanceTrace(false);
    }
}
/** We tell CrUXManager to fetch data so it's available when DevTools.PerformanceTraceFormatter is invoked */
async function populateCruxData(result) {
    logger?.('populateCruxData called');
    const cruxManager = DevTools.CrUXManager.CrUXManager.instance();
    // go/jtfbx. Yes, we're aware this API key is public. ;)
    cruxManager.setEndpointForTesting('https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=AIzaSyBn5gimNjhiEyA_euicSKko6IlD3HdgUfk');
    const cruxSetting = DevTools.Common.Settings.Settings.instance().createSetting('field-data', {
        enabled: true,
    });
    cruxSetting.set({ enabled: true });
    // Gather URLs to fetch CrUX data for
    const urls = [...(result.parsedTrace.insights?.values() ?? [])].map(c => c.url.toString());
    urls.push(result.parsedTrace.data.Meta.mainFrameURL);
    const urlSet = new Set(urls);
    if (urlSet.size === 0) {
        logger?.('No URLs found for CrUX data');
        return;
    }
    logger?.(`Fetching CrUX data for ${urlSet.size} URLs: ${Array.from(urlSet).join(', ')}`);
    const cruxData = await Promise.all(Array.from(urlSet).map(async (url) => {
        const data = await cruxManager.getFieldDataForPage(url);
        logger?.(`CrUX data for ${url}: ${data ? 'found' : 'not found'}`);
        return data;
    }));
    result.parsedTrace.metadata.cruxFieldData = cruxData;
}
//# sourceMappingURL=performance.js.map