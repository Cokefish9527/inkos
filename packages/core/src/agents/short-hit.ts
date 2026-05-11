import { BaseAgent } from "./base.js";
import { countChapterLength } from "../utils/length-metrics.js";

export const SHORT_HIT_DEFAULT_CHAPTERS = 12;
export const SHORT_HIT_MIN_CHAPTERS = 12;
export const SHORT_HIT_MAX_CHAPTERS = 18;
export const SHORT_HIT_DEFAULT_CHARS_PER_CHAPTER = 1000;
export const SHORT_HIT_MIN_CHARS_PER_CHAPTER = 900;
export const SHORT_HIT_MAX_CHARS_PER_CHAPTER = 1200;

export interface ShortHitOutline {
  readonly storyTitle: string;
  readonly rawContent: string;
}

export interface ShortHitChapter {
  readonly number: number;
  readonly title: string;
  readonly content: string;
  readonly charCount: number;
}

export interface ShortHitBatchDraft {
  readonly storyTitle: string;
  readonly openingHook?: string;
  readonly chapters: ReadonlyArray<ShortHitChapter>;
  readonly rawContent: string;
}

export interface ShortHitSalesPackage {
  readonly title: string;
  readonly intro: string;
  readonly sellingPoints: ReadonlyArray<string>;
  readonly coverPrompt: string;
  readonly rawContent: string;
}

export interface ShortHitReference {
  readonly path?: string;
  readonly text: string;
}

export interface ShortHitOutlineInput {
  readonly direction: string;
  readonly chapterCount: number;
  readonly charsPerChapter: number;
  readonly reference?: ShortHitReference;
}

export interface ShortHitOutlineReviewInput {
  readonly direction: string;
  readonly outline: ShortHitOutline;
  readonly reference?: ShortHitReference;
}

export interface ShortHitOutlineRevisionInput extends ShortHitOutlineReviewInput {
  readonly review: string;
  readonly chapterCount: number;
  readonly charsPerChapter: number;
}

export interface ShortHitDraftInput {
  readonly direction: string;
  readonly outlineMarkdown: string;
  readonly chapterCount: number;
  readonly charsPerChapter: number;
}

export interface ShortHitDraftReviewInput extends ShortHitDraftInput {
  readonly draft: ShortHitBatchDraft;
}

export interface ShortHitDraftRevisionInput extends ShortHitDraftReviewInput {
  readonly review: string;
}

export interface ShortHitPackageInput {
  readonly direction: string;
  readonly outlineMarkdown: string;
  readonly draft: ShortHitBatchDraft;
}

export class ShortHitOutlineAgent extends BaseAgent {
  get name(): string {
    return "short-hit-outline";
  }

  async createOutline(input: ShortHitOutlineInput): Promise<ShortHitOutline> {
    const response = await retryShortHitCall(() =>
      this.chat([
        { role: "system", content: buildShortHitOutlineSystemPrompt() },
        { role: "user", content: buildShortHitOutlineUserPrompt(input) },
      ], { temperature: 0.55, maxTokens: 8192 }), this.name, this.log);

    return parseShortHitOutline(response.content);
  }
}

export class ShortHitOutlineReviewerAgent extends BaseAgent {
  get name(): string {
    return "short-hit-outline-reviewer";
  }

  async reviewOutline(input: ShortHitOutlineReviewInput): Promise<string> {
    const response = await retryShortHitCall(() =>
      this.chat([
        { role: "system", content: buildShortHitOutlineReviewSystemPrompt() },
        { role: "user", content: buildShortHitOutlineReviewUserPrompt(input) },
      ], { temperature: 0.3, maxTokens: 4096 }), this.name, this.log);

    return response.content.trim();
  }
}

export class ShortHitOutlineReviserAgent extends BaseAgent {
  get name(): string {
    return "short-hit-outline-reviser";
  }

  async reviseOutline(input: ShortHitOutlineRevisionInput): Promise<ShortHitOutline> {
    const response = await retryShortHitCall(() =>
      this.chat([
        { role: "system", content: buildShortHitOutlineSystemPrompt() },
        { role: "user", content: buildShortHitOutlineUserPrompt(input) },
        { role: "assistant", content: input.outline.rawContent.trim() },
        { role: "user", content: buildShortHitOutlineRevisionFollowup(input) },
      ], { temperature: 0.45, maxTokens: 8192 }), this.name, this.log);

    return parseShortHitOutline(response.content);
  }
}

export class ShortHitWriterAgent extends BaseAgent {
  get name(): string {
    return "short-hit-writer";
  }

  async writeDraft(input: ShortHitDraftInput): Promise<ShortHitBatchDraft> {
    const response = await retryShortHitCall(() =>
      this.chat([
        { role: "system", content: buildShortHitWriterSystemPrompt() },
        { role: "user", content: buildShortHitWriterUserPrompt(input) },
      ], {
        temperature: 0.58,
        maxTokens: estimateShortHitMaxTokens(input.chapterCount, input.charsPerChapter),
      }), this.name, this.log);

    return parseShortHitBatchDraft(response.content, { expectedChapters: input.chapterCount });
  }
}

export class ShortHitDraftReviewerAgent extends BaseAgent {
  get name(): string {
    return "short-hit-draft-reviewer";
  }

  async reviewDraft(input: ShortHitDraftReviewInput): Promise<string> {
    const response = await retryShortHitCall(() =>
      this.chat([
        { role: "system", content: buildShortHitDraftReviewSystemPrompt() },
        { role: "user", content: buildShortHitDraftReviewUserPrompt(input) },
      ], { temperature: 0.3, maxTokens: 8192 }), this.name, this.log);

    return response.content.trim();
  }
}

export class ShortHitDraftReviserAgent extends BaseAgent {
  get name(): string {
    return "short-hit-draft-reviser";
  }

  async reviseDraft(input: ShortHitDraftRevisionInput): Promise<ShortHitBatchDraft> {
    const response = await retryShortHitCall(() =>
      this.chat([
        { role: "system", content: buildShortHitWriterSystemPrompt() },
        { role: "user", content: buildShortHitWriterUserPrompt(input) },
        { role: "assistant", content: input.draft.rawContent.trim() || renderShortHitDraftMarkdown(input.draft) },
        { role: "user", content: buildShortHitDraftRevisionFollowup(input) },
      ], {
        temperature: 0.45,
        maxTokens: estimateShortHitMaxTokens(input.chapterCount, input.charsPerChapter),
      }), this.name, this.log);

    return parseShortHitBatchDraft(response.content, { expectedChapters: input.chapterCount });
  }
}

export class ShortHitPackagingAgent extends BaseAgent {
  get name(): string {
    return "short-hit-packaging";
  }

  async generatePackage(input: ShortHitPackageInput): Promise<ShortHitSalesPackage> {
    const response = await retryShortHitCall(() =>
      this.chat([
        { role: "system", content: buildShortHitPackageSystemPrompt() },
        { role: "user", content: buildShortHitPackageUserPrompt(input) },
      ], { temperature: 0.45, maxTokens: 4096 }), this.name, this.log);

    return parseShortHitSalesPackage(response.content, input.draft.storyTitle);
  }
}

export function parseShortHitOutline(rawContent: string): ShortHitOutline {
  const storyTitle = normalizeTitle(
    extractTaggedBlock(rawContent, "SHORT_HIT_PLAN_TITLE")
    || extractTaggedBlock(rawContent, "SHORT_HIT_TITLE")
    || extractFirstHeading(rawContent)
    || "未命名短篇",
  ) || "未命名短篇";
  return { storyTitle, rawContent: rawContent.trim() };
}

export function parseShortHitBatchDraft(
  rawContent: string,
  options?: { readonly expectedChapters?: number },
): ShortHitBatchDraft {
  const expectedChapters = options?.expectedChapters ?? SHORT_HIT_DEFAULT_CHAPTERS;
  const storyTitle = normalizeTitle(
    extractTaggedBlock(rawContent, "SHORT_HIT_TITLE")
    || extractFirstHeading(rawContent)
    || "未命名短篇",
  ) || "未命名短篇";
  const openingHook = extractTaggedBlock(rawContent, "SHORT_HIT_OPENING_HOOK")
    || extractTaggedBlock(rawContent, "OPENING_HOOK");

  const chapters: ShortHitChapter[] = [];
  for (let number = 1; number <= expectedChapters; number += 1) {
    const title = normalizeChapterTitle(
      extractTaggedBlock(rawContent, `CHAPTER ${number} TITLE`)
      || extractMarkdownChapterTitle(rawContent, number)
      || `第${number}章`,
      number,
    );
    const content = sanitizeChapterContent(
      extractTaggedBlock(rawContent, `CHAPTER ${number} CONTENT`)
      || extractMarkdownChapterContent(rawContent, number)
      || "",
    );
    chapters.push({
      number,
      title,
      content,
      charCount: countChapterLength(content, "zh_chars"),
    });
  }

  return {
    storyTitle,
    openingHook: openingHook.trim() || undefined,
    chapters,
    rawContent,
  };
}

export function validateShortHitDraftForFinal(
  draft: ShortHitBatchDraft,
  options?: { readonly expectedChapters?: number },
): void {
  if (options?.expectedChapters !== undefined && draft.chapters.length !== options.expectedChapters) {
    throw new Error(`Short-hit draft is incomplete; expected ${options.expectedChapters} chapters, got ${draft.chapters.length}.`);
  }

  const emptyChapters = draft.chapters
    .filter((chapter) => !chapter.content.trim())
    .map((chapter) => chapter.number);
  if (emptyChapters.length > 0) {
    throw new Error(`Short-hit draft is incomplete; empty chapters: ${emptyChapters.join(", ")}.`);
  }
}

export function renderShortHitDraftMarkdown(draft: ShortHitBatchDraft): string {
  return [
    `# ${draft.storyTitle}`,
    draft.openingHook ? `## 开篇钩子\n\n${draft.openingHook}` : "",
    ...draft.chapters.map((chapter) => [
      `## ${formatShortHitChapterHeading(chapter.number, chapter.title)}`,
      "",
      chapter.content,
    ].join("\n")),
  ].filter(Boolean).join("\n\n");
}

export function parseShortHitSalesPackage(rawContent: string, fallbackTitle = "未命名短篇"): ShortHitSalesPackage {
  const title = normalizeTitle(
    extractTaggedBlock(rawContent, "SHORT_HIT_PACKAGE_TITLE")
    || extractTaggedBlock(rawContent, "SHORT_HIT_TITLE")
    || fallbackTitle,
  ) || fallbackTitle;
  const intro = extractTaggedBlock(rawContent, "SHORT_HIT_INTRO")
    || extractTaggedBlock(rawContent, "INTRO")
    || "";
  const sellingRaw = extractTaggedBlock(rawContent, "SHORT_HIT_SELLING_POINTS")
    || extractTaggedBlock(rawContent, "SELLING_POINTS")
    || "";
  const coverPrompt = extractTaggedBlock(rawContent, "SHORT_HIT_COVER_PROMPT")
    || extractTaggedBlock(rawContent, "COVER_PROMPT")
    || "";
  return {
    title,
    intro: intro.trim(),
    sellingPoints: sellingRaw
      .split(/\n+/)
      .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean),
    coverPrompt: coverPrompt.trim(),
    rawContent: rawContent.trim(),
  };
}

function buildShortHitOutlineSystemPrompt(): string {
  return [
    "你是商业短篇小说总编，负责把一个商业方向做成完整短篇故事方案。",
    "当前链路是公开安全版：不能依赖本地爆文 benchmark、不能假装已经读过某个私有素材库；如果用户给了参考文本，只把它当公开输入。",
    "目标是内容优先：标题、开篇、人物压力、证据/关系/身份杠杆、升级链、反转链和回报落点必须能支撑一次写完整篇。",
    "不要过度结构化，不要输出 JSON/YAML。用人能读的 Markdown，但章节方案必须足够密，写手拿到后能直接一次写完。",
    "短篇默认 12-18 章，每章约 900-1200 字。故事要完整，不是长篇前 5 章启动包。",
  ].join("\n");
}

function buildShortHitOutlineUserPrompt(input: ShortHitOutlineInput): string {
  return [
    "## 商业方向",
    input.direction,
    "",
    "## 目标规格",
    `完整短篇 ${input.chapterCount} 章，每章约 ${input.charsPerChapter} 字。`,
    "",
    input.reference?.text ? "## 可选参考文本\n" + trimForPrompt(input.reference.text, 12000) + "\n" : "",
    "## 产出要求",
    "先给一个平台感标题，再给完整故事方案。大纲要讲清楚主角为什么被压住、读者想看什么回报、主角靠什么翻盘、证据/关系/身份/规则如何递进、反派为什么会反扑、结尾如何落地。",
    "章节方案必须逐章写清：章节标题方向、当章发生的关键场面、角色动作、压力升级或回报、章尾继续读的理由。",
    "可以给标签，但不要穷举标签表；标签服务选题和写作，不替代故事。",
    "",
    "## 输出格式",
    "=== SHORT_HIT_PLAN_TITLE ===",
    "只写一行平台感标题",
    "=== SHORT_HIT_PLAN ===",
    "用 Markdown 写完整故事方案，包含：题材/受众、标题打法、开篇小钩子、人物与关系、核心压力、主角赢法、升级链、反转链、结尾回报、逐章方案。",
  ].filter(Boolean).join("\n");
}

function buildShortHitOutlineReviewSystemPrompt(): string {
  return [
    "你是商业短篇审纲编辑。你不负责打分，也不负责判抄。",
    "你的任务是判断这个故事方案能不能支撑一次写完整篇：题材发动机是否清楚、人物动机是否成立、压力链是否递进、反派反扑是否可信、结尾回报是否够。",
    "审稿要像真实读者和编辑，不要只列工程检查项。",
    "输出 Markdown，直接指出会导致成稿不好看的硬伤和可保留优点。",
  ].join("\n");
}

function buildShortHitOutlineReviewUserPrompt(input: ShortHitOutlineReviewInput): string {
  return [
    "## 商业方向",
    input.direction,
    "",
    input.reference?.text ? "## 可选参考文本\n" + trimForPrompt(input.reference.text, 8000) + "\n" : "",
    "## 待审故事方案",
    input.outline.rawContent,
    "",
    "## 审查重点",
    "- 这是不是完整短篇故事，而不是局部试写方案。",
    "- 标题、开篇、前三章是否有点击和追读理由。",
    "- 大纲是否足够密，写手是否会在后半段泄气。",
    "- 关键场面有没有人物行动、反扑和回报，不是纯结果摘要。",
    "- 读者会不会因为时间线、人物关系、证据权限、身体状态、常识问题出戏。",
  ].join("\n");
}

function buildShortHitOutlineRevisionFollowup(input: ShortHitOutlineRevisionInput): string {
  return [
    "根据上面的审纲意见，继续给出第二版完整故事方案。",
    "这是同一次创作的第二轮，不要另起炉灶，不要只写修改说明。",
    `仍然按 ${input.chapterCount} 章、每章约 ${input.charsPerChapter} 字来组织。`,
    "保留能打的题材发动机和人物关系，修掉会导致成稿不好看的硬伤。",
    "",
    "## 审纲意见",
    input.review.trim(),
    "",
    "## 输出格式",
    "=== SHORT_HIT_PLAN_TITLE ===",
    "只写一行平台感标题",
    "=== SHORT_HIT_PLAN ===",
    "用 Markdown 写完整第二版故事方案。",
  ].join("\n");
}

function buildShortHitWriterSystemPrompt(): string {
  return [
    "你是中文商业短篇 BatchWriter。你要根据故事方案一次 API 写完整短篇正文。",
    "这不是长篇连载续写，也不是章节梗概。每章都要有当场发生的戏：人物行动、对话或反应、局面变化、章尾继续读的理由。",
    "网文戏剧性要足：现实压力可以放大到读者愿意信的程度，但不能荒诞到失去代入。",
    "标题和章节标题要像平台内容，不要文艺化总结。正文保持移动端节奏，段落短但不要写成电报体。",
    "字数是校准，不是平均数学题。大场面可略长，过渡章可略短；明显偏短通常说明写成了梗概，必须补有效场面。",
    "输出必须严格使用指定 block，不要写作者说明、字数说明、审稿意见或格式解释。",
  ].join("\n");
}

function buildShortHitWriterUserPrompt(input: ShortHitDraftInput): string {
  return [
    "## 任务",
    `一次写完整 ${input.chapterCount} 章，每章约 ${input.charsPerChapter} 字。`,
    "先读完整故事方案，再写正文。正文要承接大纲的压力链、证据链、反转链和情绪回报，不要临时改成另一种故事。",
    "",
    buildShortHitCraftPrompt(),
    "",
    "## 商业方向",
    input.direction,
    "",
    "## 故事方案",
    input.outlineMarkdown,
    "",
    "## 输出格式",
    "=== SHORT_HIT_TITLE ===",
    "短篇标题，只写纯文本平台标题",
    "=== SHORT_HIT_OPENING_HOOK ===",
    "可选正文前小钩子，约 200 字；如果不需要独立引子，也要写第 1 章第一屏的入局小场面",
    ...Array.from({ length: input.chapterCount }, (_, index) => {
      const chapter = index + 1;
      return [
        `=== CHAPTER ${chapter} TITLE ===`,
        "章节标题，只写纯文本，不要 #，不要第几章前缀",
        `=== CHAPTER ${chapter} CONTENT ===`,
        `第${chapter}章正文，写完整场面，不要梗概，不要作者备注`,
      ].join("\n");
    }),
  ].join("\n");
}

function buildShortHitDraftReviewSystemPrompt(): string {
  return [
    "你是商业短篇成稿审稿编辑。",
    "你只看内容是否能卖、是否顺、是否有继续读的欲望；不要把审稿变成确定性打分。",
    "重点看标题、章节标题、开篇、人物动机、时间线、人物关系、证据/权限、压力递进、反派反扑、后半段是否泄气、结尾回报是否落地。",
    "输出 Markdown，写清哪些问题会明显影响读者读下去，哪些只是可接受的小瑕疵。",
  ].join("\n");
}

function buildShortHitDraftReviewUserPrompt(input: ShortHitDraftReviewInput): string {
  return [
    "## 商业方向",
    input.direction,
    "",
    "## 原故事方案",
    input.outlineMarkdown,
    "",
    "## 待审正文",
    renderShortHitDraftMarkdown(input.draft),
    "",
    "## 审稿要求",
    "直接说人话：这本读起来哪里有欲望、哪里出戏、哪里像梗概、哪里后半段泄气、哪里标题或章节标题不想点。",
    "不要因为某章略短或略长就判死；先判断内容是否完整、有戏、有回报。",
  ].join("\n");
}

function buildShortHitDraftRevisionFollowup(input: ShortHitDraftRevisionInput): string {
  return [
    "根据审稿意见，继续写第二版完整正文。",
    "这是同一篇的第二轮写作：保留上一版能打的地方，修掉会让读者出戏或不想读的问题。",
    "不要只列修改建议，不要只改几章片段，输出完整正文。",
    "",
    "## 审稿意见",
    input.review.trim(),
    "",
    "## 第二轮重点",
    "- 修时间线、逻辑、人物关系、证据权限、身体状态等会让读者出戏的问题。",
    "- 补后半段有效场面，不要用结果摘要收尾。",
    "- 保持标题、开篇、章节标题和正文主标题一致，但标题可以基于正文重新压得更有平台点击感。",
    "- 字数只做校准：偏短补有效场面，偏长删解释和重复反应。",
    "",
    "## 输出格式",
    "=== SHORT_HIT_TITLE ===",
    "短篇标题，只写纯文本平台标题",
    "=== SHORT_HIT_OPENING_HOOK ===",
    "可选正文前小钩子，约 200 字；如果不需要独立引子，也要写第 1 章第一屏的入局小场面",
    ...Array.from({ length: input.chapterCount }, (_, index) => {
      const chapter = index + 1;
      return [
        `=== CHAPTER ${chapter} TITLE ===`,
        "章节标题，只写纯文本，不要 #，不要第几章前缀",
        `=== CHAPTER ${chapter} CONTENT ===`,
        `第${chapter}章正文，写完整场面，不要梗概，不要作者备注`,
      ].join("\n");
    }),
  ].join("\n");
}

function buildShortHitPackageSystemPrompt(): string {
  return [
    "你是短篇小说包装编辑，负责根据最终正文生成简介、卖点和封面提示词。",
    "不要另起一个和正文不同的主标题。包装必须围绕正文实际标题和剧情。",
    "封面提示词按手机端平台书封思考：3:4 竖图、大标题区、强人物情绪、少量一眼可识别道具、高对比商业色彩，不要影视海报感。",
  ].join("\n");
}

function buildShortHitPackageUserPrompt(input: ShortHitPackageInput): string {
  return [
    "## 商业方向",
    input.direction,
    "",
    "## 故事方案",
    trimForPrompt(input.outlineMarkdown, 6000),
    "",
    "## 最终正文",
    trimForPrompt(renderShortHitDraftMarkdown(input.draft), 16000),
    "",
    "## 输出格式",
    "=== SHORT_HIT_PACKAGE_TITLE ===",
    input.draft.storyTitle,
    "=== SHORT_HIT_INTRO ===",
    "100-180字平台简介，直接抓冲突、压迫和回报，不要剧透成流水账。",
    "=== SHORT_HIT_SELLING_POINTS ===",
    "- 3到6条卖点，每条一行",
    "=== SHORT_HIT_COVER_PROMPT ===",
    "中文封面生成提示词：3:4竖图，主标题区，人物情绪，道具，配色，字体风格，避免事项。",
  ].join("\n");
}

function buildShortHitCraftPrompt(): string {
  return [
    "## 写法提醒",
    "- 盐溶于汤：人物价值观和野心靠行动表现，不靠口号。",
    "- Show don't tell：用行为、证据、细节和场景让读者自己感到人物状态。",
    "- 反注水：每个场景都推动冲突、因果、情绪、证据、压迫、回报或关系。",
    "- 回报要有铺垫：反转、打脸、和解、复仇、身份揭露都要有证据链和因果链。",
    "- 配角要有动机：压迫者也有利益、误判或恐惧，不要写成无脑工具人。",
    "- 日常细节要变成饵：细节承担证据、情绪、人物差异或后续反转功能。",
    "- 移动端优先：段落短，信息密，少写空泛抒情和装饰性废话。",
  ].join("\n");
}

function extractTaggedBlock(raw: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^\\s*===\\s*${escaped}\\s*===\\s*\\n([\\s\\S]*?)(?=^\\s*===\\s*[A-Z0-9_ ]+\\s*===\\s*$|(?![\\s\\S]))`,
    "im",
  );
  return pattern.exec(raw)?.[1]?.trim() ?? "";
}

function extractFirstHeading(raw: string): string {
  return raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}

function extractMarkdownChapterTitle(raw: string, number: number): string {
  const pattern = new RegExp(`^##\\s*(?:第\\s*${number}\\s*章\\s*)?(.+)$`, "m");
  return pattern.exec(raw)?.[1]?.trim() ?? "";
}

function extractMarkdownChapterContent(raw: string, number: number): string {
  const pattern = new RegExp(`^##\\s*(?:第\\s*${number}\\s*章\\s*)?.*$\\n([\\s\\S]*?)(?=^##\\s*(?:第\\s*${number + 1}\\s*章\\s*)?.*$|(?![\\s\\S]))`, "m");
  return pattern.exec(raw)?.[1]?.trim() ?? "";
}

function sanitizeChapterContent(raw: string): string {
  return raw
    .replace(/^```(?:md|markdown)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/^===\s*[A-Z0-9_ ]+\s*===\s*$/gim, "")
    .trim();
}

function normalizeTitle(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean)
    ?.replace(/^《(.+)》$/, "$1")
    .trim() ?? "";
}

function normalizeChapterTitle(raw: string, number: number): string {
  const title = normalizeTitle(raw).replace(new RegExp(`^第\\s*${number}\\s*章\\s*`), "").trim();
  return title || `第${number}章`;
}

function formatShortHitChapterHeading(number: number, title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return `第${number}章`;
  if (new RegExp(`^第\\s*${number}\\s*章`).test(trimmed)) return trimmed;
  return `第${number}章 ${trimmed}`;
}

function trimForPrompt(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n……（已截断）`;
}

function estimateShortHitMaxTokens(chapterCount: number, charsPerChapter: number): number {
  return Math.max(12_288, Math.ceil(chapterCount * charsPerChapter * 2.2) + 4096);
}

async function retryShortHitCall<T>(
  operation: () => Promise<T>,
  label: string,
  logger?: { warn(message: string): void },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await operation();
    } catch (e) {
      lastError = e;
      if (attempt >= 2 || !isTransientShortHitError(e)) throw e;
      logger?.warn(`[${label}] transient LLM interruption, retrying once: ${String(e)}`);
    }
  }
  throw lastError;
}

function isTransientShortHitError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("unexpected eof")
    || message.includes("econnreset")
    || message.includes("socket hang up")
    || message.includes("terminated")
    || message.includes("fetch failed");
}
