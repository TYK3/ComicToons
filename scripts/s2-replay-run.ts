import { writeReplayReport } from './s2-replay-core.ts';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: s2-replay-run.ts <output-path.json>');

const report = await writeReplayReport(outputPath);
console.log(JSON.stringify({
  panelCount: report.panelCount,
  uniqueImageUrlCount: report.uniqueImageUrlCount,
  uniqueCaptionCount: report.uniqueCaptionCount,
  panelsBySfx: report.panelsBySfx,
  spikePanelCount: report.spikePanelCount,
  burstPanelCount: report.burstPanelCount,
  everyPanelHasSources: report.everyPanelHasSources,
  noSharedImageUrl: report.noSharedImageUrl,
  noSharedCaption: report.noSharedCaption,
  distinctImageSha256Count: report.distinctImageSha256Count,
  missingImageFileCount: report.missingImageFileCount,
  noSharedImageBytes: report.noSharedImageBytes,
  artProviderCounts: report.artProviderCounts,
  artSource: report.artSource,
  promptCount: report.promptCount,
  distinctPromptCount: report.distinctPromptCount,
  noSharedPrompt: report.noSharedPrompt,
  promptsQuoteChatOrNames: report.promptsQuoteChatOrNames,
}, null, 2));
if (!report.everyPanelHasSources || !report.noSharedImageUrl || !report.noSharedCaption || report.spikePanelCount < 1 || report.burstPanelCount < 1
  || !report.noSharedImageBytes || report.distinctImageSha256Count !== report.panelCount || !report.noSharedPrompt || report.promptsQuoteChatOrNames) {
  console.error('Replay invariants failed.');
  process.exitCode = 1;
}
