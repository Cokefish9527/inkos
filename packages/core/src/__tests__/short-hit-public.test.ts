import { describe, expect, it, vi } from "vitest";
import type { LLMClient } from "../llm/provider.js";
import {
  ShortHitDraftReviserAgent,
  parseShortHitBatchDraft,
  validateShortHitDraftForFinal,
} from "../agents/short-hit.js";

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function fakeClient(): LLMClient {
  return {
    provider: "openai",
    apiFormat: "chat",
    stream: false,
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
      thinkingBudget: 0,
      extra: {},
    },
  };
}

describe("public short-hit chain", () => {
  it("parses a complete tagged short-hit draft", () => {
    const draft = parseShortHitBatchDraft(`
=== SHORT_HIT_TITLE ===
我离婚后，全家悔疯了
=== SHORT_HIT_OPENING_HOOK ===
离婚协议递到我面前时，婆婆正在直播间教人做贤妻。
=== CHAPTER 1 TITLE ===
她把离婚协议递到直播镜头前
=== CHAPTER 1 CONTENT ===
我看着镜头里的红灯亮起，先把桌上的房本推了过去。婆婆脸上的笑僵住，丈夫伸手来抢，我按住合同，问他还记不记得这套房是谁付的首付。
=== CHAPTER 2 TITLE ===
三年前那张转账单
=== CHAPTER 2 CONTENT ===
第二天早上，家庭群里全是骂我的语音。我没有回，只把三年前的转账单发给律师。十分钟后，丈夫第一次打电话求我回家谈谈。
`, { expectedChapters: 2 });

    expect(draft.storyTitle).toBe("我离婚后，全家悔疯了");
    expect(draft.openingHook).toContain("离婚协议");
    expect(draft.chapters).toHaveLength(2);
    expect(draft.chapters[0]?.title).toContain("离婚协议");
    expect(draft.chapters[1]?.charCount).toBeGreaterThan(20);
    expect(() => validateShortHitDraftForFinal(draft, { expectedChapters: 2 })).not.toThrow();
  });

  it("uses the previous draft as assistant context for the second writer pass", async () => {
    const firstDraft = parseShortHitBatchDraft(`
=== SHORT_HIT_TITLE ===
初稿标题
=== CHAPTER 1 TITLE ===
旧章
=== CHAPTER 1 CONTENT ===
旧正文有一处时间线问题。
`, { expectedChapters: 1 });

    const chatSpy = vi
      .spyOn(ShortHitDraftReviserAgent.prototype as never, "chat" as never)
      .mockResolvedValue({
        content: `
=== SHORT_HIT_TITLE ===
新稿标题
=== CHAPTER 1 TITLE ===
新章
=== CHAPTER 1 CONTENT ===
新正文修正了时间线。
`,
        usage: ZERO_USAGE,
      });

    const agent = new ShortHitDraftReviserAgent({
      client: fakeClient(),
      model: "fake",
      projectRoot: "/tmp",
    });

    const revised = await agent.reviseDraft({
      direction: "女频短篇 婚姻反杀",
      outlineMarkdown: "12章完整故事方案",
      draft: firstDraft,
      review: "时间线不成立，第二天不能先收到律师函再补证据。",
      chapterCount: 1,
      charsPerChapter: 1000,
    });

    const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[2]?.content).toContain("旧正文有一处时间线问题");
    expect(messages[3]?.content).toContain("时间线不成立");
    expect(revised.storyTitle).toBe("新稿标题");

    chatSpy.mockRestore();
  });
});
