import { Command } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  SHORT_HIT_DEFAULT_CHAPTERS,
  SHORT_HIT_DEFAULT_CHARS_PER_CHAPTER,
  SHORT_HIT_MAX_CHAPTERS,
  SHORT_HIT_MAX_CHARS_PER_CHAPTER,
  SHORT_HIT_MIN_CHAPTERS,
  SHORT_HIT_MIN_CHARS_PER_CHAPTER,
  ShortHitDraftReviewerAgent,
  ShortHitDraftReviserAgent,
  ShortHitOutlineAgent,
  ShortHitOutlineReviewerAgent,
  ShortHitOutlineReviserAgent,
  ShortHitPackagingAgent,
  ShortHitWriterAgent,
  createLLMClient,
  renderShortHitDraftMarkdown,
  validateShortHitDraftForFinal,
  type LLMConfig,
  type Logger,
  type OnStreamProgress,
  type ShortHitBatchDraft,
  type ShortHitOutline,
  type ShortHitReference,
  type ShortHitSalesPackage,
} from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError } from "../utils.js";

export const shortCommand = new Command("short")
  .description("Public-safe commercial short fiction workflow");

shortCommand
  .command("run")
  .description("Run a benchmark-free short fiction chain from a commercial direction")
  .requiredOption("--direction <text>", "Commercial direction, e.g. 女频短篇 婚姻背叛 证据反杀")
  .option("--reference <path>", "Optional public-safe reference notes/text")
  .option("--story-id <id>", "Output story id under shorts/")
  .option("--out-dir <path>", "Output directory", "shorts")
  .option("--chapters <n>", "Complete short chapter count (12-18)", String(SHORT_HIT_DEFAULT_CHAPTERS))
  .option("--chars <n>", "Target characters per chapter (900-1200)", String(SHORT_HIT_DEFAULT_CHARS_PER_CHAPTER))
  .option("--llm-base-url <url>", "Override LLM base URL")
  .option("--model <model>", "Fallback model for all short stages")
  .option("--planner-model <model>", "Model for outline creation/revision")
  .option("--outline-review-model <model>", "Model for outline review")
  .option("--writer-model <model>", "Model for first full draft")
  .option("--draft-review-model <model>", "Model for draft review")
  .option("--revise-model <model>", "Model for second full draft")
  .option("--package-model <model>", "Model for synopsis and cover prompt packaging")
  .option("--json", "Output JSON")
  .action(async (opts: ShortRunOptions) => {
    try {
      const root = findProjectRoot();
      const chapterCount = parseBoundedInteger(
        opts.chapters,
        SHORT_HIT_DEFAULT_CHAPTERS,
        "chapters",
        SHORT_HIT_MIN_CHAPTERS,
        SHORT_HIT_MAX_CHAPTERS,
      );
      const charsPerChapter = parseBoundedInteger(
        opts.chars,
        SHORT_HIT_DEFAULT_CHARS_PER_CHAPTER,
        "chars",
        SHORT_HIT_MIN_CHARS_PER_CHAPTER,
        SHORT_HIT_MAX_CHARS_PER_CHAPTER,
      );
      const reference = opts.reference ? await readReference(root, opts.reference) : undefined;
      const models = resolveShortRunModels(opts);

      const plannerRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.planner,
        quiet: Boolean(opts.json),
      });
      const outlineReviewRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.outlineReview,
        quiet: Boolean(opts.json),
      });
      const writerRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.writer,
        quiet: Boolean(opts.json),
      });
      const draftReviewRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.draftReview,
        quiet: Boolean(opts.json),
      });
      const reviseRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.revise,
        quiet: Boolean(opts.json),
      });
      const packageRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.package,
        quiet: Boolean(opts.json),
      });

      const outlineAgent = new ShortHitOutlineAgent({
        client: plannerRuntime.client,
        model: plannerRuntime.model,
        projectRoot: root,
        logger: plannerRuntime.logger,
        onStreamProgress: plannerRuntime.onStreamProgress,
      });
      const outlineV1 = await outlineAgent.createOutline({
        direction: opts.direction,
        chapterCount,
        charsPerChapter,
        reference,
      });

      const storyId = opts.storyId || slugify(outlineV1.storyTitle || opts.direction);
      const baseDir = join(opts.outDir, storyId);
      await writeText(root, join(baseDir, "outline", "v001.md"), outlineV1.rawContent);

      const outlineReviewer = new ShortHitOutlineReviewerAgent({
        client: outlineReviewRuntime.client,
        model: outlineReviewRuntime.model,
        projectRoot: root,
        logger: outlineReviewRuntime.logger,
        onStreamProgress: outlineReviewRuntime.onStreamProgress,
      });
      const outlineReview = await outlineReviewer.reviewOutline({
        direction: opts.direction,
        outline: outlineV1,
        reference,
      });
      await writeText(root, join(baseDir, "reviews", "outline-v001.md"), outlineReview);

      const outlineReviser = new ShortHitOutlineReviserAgent({
        client: plannerRuntime.client,
        model: plannerRuntime.model,
        projectRoot: root,
        logger: plannerRuntime.logger,
        onStreamProgress: plannerRuntime.onStreamProgress,
      });
      const outlineV2 = await outlineReviser.reviseOutline({
        direction: opts.direction,
        outline: outlineV1,
        review: outlineReview,
        reference,
        chapterCount,
        charsPerChapter,
      });
      await writeText(root, join(baseDir, "outline", "v002.md"), outlineV2.rawContent);

      const writer = new ShortHitWriterAgent({
        client: writerRuntime.client,
        model: writerRuntime.model,
        projectRoot: root,
        logger: writerRuntime.logger,
        onStreamProgress: writerRuntime.onStreamProgress,
      });
      const draftV1 = await writer.writeDraft({
        direction: opts.direction,
        outlineMarkdown: outlineV2.rawContent,
        chapterCount,
        charsPerChapter,
      });
      await writeDraftArtifacts(root, baseDir, "v001", draftV1);

      const draftReviewer = new ShortHitDraftReviewerAgent({
        client: draftReviewRuntime.client,
        model: draftReviewRuntime.model,
        projectRoot: root,
        logger: draftReviewRuntime.logger,
        onStreamProgress: draftReviewRuntime.onStreamProgress,
      });
      const draftReview = await draftReviewer.reviewDraft({
        direction: opts.direction,
        outlineMarkdown: outlineV2.rawContent,
        draft: draftV1,
        chapterCount,
        charsPerChapter,
      });
      await writeText(root, join(baseDir, "reviews", "draft-v001.md"), draftReview);

      const reviser = new ShortHitDraftReviserAgent({
        client: reviseRuntime.client,
        model: reviseRuntime.model,
        projectRoot: root,
        logger: reviseRuntime.logger,
        onStreamProgress: reviseRuntime.onStreamProgress,
      });
      const draftV2 = await reviser.reviseDraft({
        direction: opts.direction,
        outlineMarkdown: outlineV2.rawContent,
        draft: draftV1,
        review: draftReview,
        chapterCount,
        charsPerChapter,
      });
      validateShortHitDraftForFinal(draftV2, { expectedChapters: chapterCount });
      await writeDraftArtifacts(root, baseDir, "v002", draftV2);
      await writeFinalArtifacts(root, baseDir, draftV2);

      const packager = new ShortHitPackagingAgent({
        client: packageRuntime.client,
        model: packageRuntime.model,
        projectRoot: root,
        logger: packageRuntime.logger,
        onStreamProgress: packageRuntime.onStreamProgress,
      });
      const salesPackage = await packager.generatePackage({
        direction: opts.direction,
        outlineMarkdown: outlineV2.rawContent,
        draft: draftV2,
      });
      await writePackageArtifacts(root, baseDir, salesPackage);

      const payload = {
        storyId,
        outlinePath: join(baseDir, "outline", "v002.md"),
        outlineReviewPath: join(baseDir, "reviews", "outline-v001.md"),
        draftReviewPath: join(baseDir, "reviews", "draft-v001.md"),
        finalMarkdownPath: join(baseDir, "final", "full.md"),
        finalJsonPath: join(baseDir, "final", "short-story.json"),
        salesPackagePath: join(baseDir, "final", "sales-package.md"),
        coverPromptPath: join(baseDir, "final", "cover-prompt.md"),
        models,
      };

      if (opts.json) {
        log(JSON.stringify(payload, null, 2));
      } else {
        log(`Short run complete: ${storyId}`);
        log(`Final: ${payload.finalMarkdownPath}`);
        log(`Sales package: ${payload.salesPackagePath}`);
        log("Benchmark: not used");
      }
    } catch (e) {
      logCommandError("Short run failed", e, opts.json);
    }
  });

interface ShortRunOptions {
  readonly direction: string;
  readonly reference?: string;
  readonly storyId?: string;
  readonly outDir: string;
  readonly chapters?: string;
  readonly chars?: string;
  readonly llmBaseUrl?: string;
  readonly model?: string;
  readonly plannerModel?: string;
  readonly outlineReviewModel?: string;
  readonly writerModel?: string;
  readonly draftReviewModel?: string;
  readonly reviseModel?: string;
  readonly packageModel?: string;
  readonly json?: boolean;
}

interface ShortRuntime {
  readonly client: ReturnType<typeof createLLMClient>;
  readonly model: string;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
}

interface ShortRunModels {
  readonly planner?: string;
  readonly outlineReview?: string;
  readonly writer?: string;
  readonly draftReview?: string;
  readonly revise?: string;
  readonly package?: string;
}

function resolveShortRunModels(options: ShortRunOptions): ShortRunModels {
  return {
    planner: options.plannerModel || options.model,
    outlineReview: options.outlineReviewModel || options.model,
    writer: options.writerModel || options.model,
    draftReview: options.draftReviewModel || options.model,
    revise: options.reviseModel || options.model,
    package: options.packageModel || options.model,
  };
}

async function createShortRuntime(
  root: string,
  options: {
    readonly llmBaseUrl?: string;
    readonly model?: string;
    readonly quiet?: boolean;
  },
): Promise<ShortRuntime> {
  try {
    const config = await loadConfig({ projectRoot: root });
    if (options.llmBaseUrl) config.llm.baseUrl = options.llmBaseUrl;
    if (options.model) config.llm.model = options.model;
    const pipelineConfig = buildPipelineConfig(config, root, { quiet: options.quiet });
    return {
      client: pipelineConfig.client,
      model: pipelineConfig.model,
      logger: pipelineConfig.logger,
      onStreamProgress: pipelineConfig.onStreamProgress,
    };
  } catch (e) {
    if (!String(e).includes("inkos.json not found")) throw e;
    const llmConfig = buildEnvLLMConfig(options);
    return {
      client: createLLMClient(llmConfig),
      model: llmConfig.model,
    };
  }
}

function buildEnvLLMConfig(options: {
  readonly llmBaseUrl?: string;
  readonly model?: string;
}): LLMConfig {
  const baseUrl = options.llmBaseUrl ?? process.env.INKOS_LLM_BASE_URL;
  const model = options.model ?? process.env.INKOS_LLM_MODEL;
  if (!baseUrl) throw new Error("LLM base URL is required. Set INKOS_LLM_BASE_URL or pass --llm-base-url.");
  if (!model) throw new Error("LLM model is required. Set INKOS_LLM_MODEL or pass --model.");
  return {
    provider: "openai",
    service: process.env.INKOS_LLM_SERVICE ?? "custom",
    configSource: "env",
    baseUrl,
    apiKey: process.env.INKOS_LLM_API_KEY ?? "",
    model,
    temperature: parseEnvNumber(process.env.INKOS_LLM_TEMPERATURE, 0.1),
    thinkingBudget: parseEnvInteger(process.env.INKOS_LLM_THINKING_BUDGET, 0),
    apiFormat: process.env.INKOS_LLM_API_FORMAT === "responses" ? "responses" : "chat",
    stream: process.env.INKOS_LLM_STREAM === "false" ? false : true,
  };
}

async function readReference(root: string, path: string): Promise<ShortHitReference> {
  const resolved = resolvePath(root, path);
  return {
    path,
    text: await readFile(resolved, "utf-8"),
  };
}

async function writeDraftArtifacts(
  root: string,
  baseDir: string,
  version: string,
  draft: ShortHitBatchDraft,
): Promise<void> {
  const draftDir = join(baseDir, "drafts", version);
  await writeText(root, join(draftDir, "full.md"), renderShortHitDraftMarkdown(draft));
  await writeJson(root, join(draftDir, "draft.json"), draft);
  await Promise.all(draft.chapters.map((chapter) =>
    writeText(root, join(draftDir, "chapters", `${String(chapter.number).padStart(4, "0")}.md`), [
      `# 第${chapter.number}章 ${chapter.title}`,
      "",
      chapter.content,
    ].join("\n")),
  ));
}

async function writeFinalArtifacts(root: string, baseDir: string, draft: ShortHitBatchDraft): Promise<void> {
  const finalDir = join(baseDir, "final");
  const markdown = renderShortHitDraftMarkdown(draft);
  await writeText(root, join(finalDir, "full.md"), markdown);
  await writeText(root, join(finalDir, `${safeFileName(draft.storyTitle)}.md`), markdown);
  await writeJson(root, join(finalDir, "short-story.json"), draft);
  await Promise.all(draft.chapters.map((chapter) =>
    writeText(root, join(finalDir, "chapters", `${String(chapter.number).padStart(4, "0")}.md`), [
      `# 第${chapter.number}章 ${chapter.title}`,
      "",
      chapter.content,
    ].join("\n")),
  ));
}

async function writePackageArtifacts(root: string, baseDir: string, salesPackage: ShortHitSalesPackage): Promise<void> {
  const finalDir = join(baseDir, "final");
  await writeJson(root, join(finalDir, "sales-package.json"), salesPackage);
  await writeText(root, join(finalDir, "sales-package.md"), [
    `# ${salesPackage.title}`,
    "",
    "## 简介",
    "",
    salesPackage.intro,
    "",
    "## 卖点",
    "",
    ...salesPackage.sellingPoints.map((point) => `- ${point}`),
    "",
    "## 封面提示词",
    "",
    salesPackage.coverPrompt,
  ].join("\n"));
  await writeText(root, join(finalDir, "cover-prompt.md"), salesPackage.coverPrompt || "(empty)");
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await writeText(root, path, JSON.stringify(value, null, 2));
}

async function writeText(root: string, path: string, value: string): Promise<void> {
  const resolved = resolvePath(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${value.trimEnd()}\n`, "utf-8");
}

function resolvePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseEnvNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEnvInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `short-${Date.now()}`;
}

function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:\0*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "short-hit";
}

function logCommandError(prefix: string, error: unknown, json?: boolean): void {
  if (json) {
    log(JSON.stringify({ error: `${prefix}: ${String(error)}` }, null, 2));
    return;
  }
  logError(`${prefix}: ${String(error)}`);
}
