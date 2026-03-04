import type {
  CaptureRequest,
  DprOption,
  ParsedTask,
  SectionScope,
  SectionType,
} from "../types.js";
import { DEFAULT_DESKTOP_VIEWPORT } from "../core/defaults.js";

interface ParserOverrides {
  quality: number;
  dpr: DprOption;
  sectionScope: SectionScope;
}

const SECTION_KEYWORDS: Array<{ type: SectionType; patterns: RegExp[] }> = [
  { type: "hero", patterns: [/\bhero\b/i, /首屏/, /头图/] },
  { type: "feature", patterns: [/\bfeature(s)?\b/i, /功能/, /特点/] },
  { type: "testimonial", patterns: [/\btestimonial(s)?\b/i, /\breview(s)?\b/i, /评价/] },
  { type: "pricing", patterns: [/\bpricing\b/i, /\bplan(s)?\b/i, /价格/, /套餐/] },
  { type: "team", patterns: [/\bteam\b/i, /\bmember(s)?\b/i, /\bleadership\b/i, /团队/, /成员/, /创始人/] },
  { type: "faq", patterns: [/\bfaq\b/i, /常见问题/, /问答/] },
  { type: "blog", patterns: [/\bblog\b/i, /\bpost(s)?\b/i, /博客/, /文章/] },
  {
    type: "cta",
    patterns: [/\bcta\b/i, /call to action/i, /get started/i, /try free/i, /book demo/i, /sign up/i, /立即开始/, /免费试用/, /预约演示/],
  },
  { type: "contact", patterns: [/\bcontact\b/i, /get in touch/i, /reach out/i, /联系方式/, /联系我们/, /电话/, /邮箱/] },
  { type: "footer", patterns: [/\bfooter\b/i, /页脚/] },
];

function clampQuality(value: number): number {
  return Math.max(1, Math.min(100, Math.round(value)));
}

function parseTags(instruction: string): string[] {
  const patterns = [/(?:tags?|标签)\s*[:：]\s*([^\n]+)/i, /(?:tag|标签)\s+([^\n]+)/i];
  for (const pattern of patterns) {
    const match = instruction.match(pattern);
    if (match?.[1]) {
      return match[1]
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function parseFolderName(instruction: string): string | undefined {
  const match = instruction.match(/(?:folder|文件夹|目录)\s*[:：]\s*([^\n,，]+)/i);
  return match?.[1]?.trim();
}

function parseStar(instruction: string): number | undefined {
  const match = instruction.match(/(?:star|评级|星级)\s*[:：]?\s*([0-5])/i);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

function parseAnnotation(instruction: string): string | undefined {
  const match = instruction.match(/(?:note|annotation|备注)\s*[:：]\s*([^\n]+)/i);
  return match?.[1]?.trim();
}

function parseWaitUntil(instruction: string): ParsedTask["waitUntil"] {
  if (/domcontentloaded|dom ready/i.test(instruction)) {
    return "domcontentloaded";
  }
  if (/\bload\b|页面加载完成/i.test(instruction)) {
    return "load";
  }
  return "networkidle";
}

function parseViewport(instruction: string): ParsedTask["viewport"] {
  if (/\bmobile\b|手机|移动端/i.test(instruction)) {
    return { width: 390, height: 844 };
  }
  if (/\btablet\b|平板/i.test(instruction)) {
    return { width: 1024, height: 1366 };
  }
  return { ...DEFAULT_DESKTOP_VIEWPORT };
}

function parseUrl(instruction: string): string | null {
  const match = instruction.match(/https?:\/\/[^\s"'，,]+/i);
  return match?.[0] ?? null;
}

function detectRequestedSectionTypes(instruction: string): SectionType[] {
  const requested = new Set<SectionType>();
  for (const item of SECTION_KEYWORDS) {
    if (item.patterns.some((pattern) => pattern.test(instruction))) {
      requested.add(item.type);
    }
  }
  return [...requested];
}

function parseCaptureRequests(
  instruction: string,
  sectionScope: SectionScope,
): CaptureRequest[] {
  const lower = instruction.toLowerCase();
  const wantsFull = !/(只要|仅|only)\s*(section|模块|分块)/i.test(lower);
  const wantsSection = !/(只要|仅|only)\s*(full\s?page|fullpage|整页)/i.test(lower);
  const captures: CaptureRequest[] = [];

  if (wantsFull) {
    captures.push({ mode: "fullPage" });
  }

  if (wantsSection) {
    const types = detectRequestedSectionTypes(instruction);
    if (sectionScope === "manual" && types.length > 0) {
      for (const type of types) {
        captures.push({ mode: "section", targetType: type });
      }
    } else {
      captures.push({ mode: "section" });
    }
  }

  if (captures.length === 0) {
    captures.push({ mode: "fullPage" }, { mode: "section" });
  }

  return captures;
}

function parseDprFromInstruction(instruction: string): DprOption | undefined {
  if (/\b1x\b|non[-\s]?retina|普通清晰度/i.test(instruction)) {
    return 1;
  }
  if (/\b2x\b|retina|高保真/i.test(instruction)) {
    return 2;
  }
  if (/\bauto\s*dpr\b|自动dpr|自动倍率/i.test(instruction)) {
    return "auto";
  }
  return undefined;
}

function parseQualityFromInstruction(instruction: string): number | undefined {
  const match = instruction.match(/(?:quality|jpg质量|压缩质量)\s*[:：]?\s*(\d{1,3})/i);
  if (!match) {
    return undefined;
  }
  return clampQuality(Number(match[1]));
}

function normalizeTask(task: ParsedTask): ParsedTask {
  const dedupedTags = [...new Set(task.tags.map((tag) => tag.trim()).filter(Boolean))];
  return {
    ...task,
    tags: dedupedTags,
    image: {
      ...task.image,
      quality: clampQuality(task.image.quality),
    },
  };
}

function buildRuleBasedTask(
  instruction: string,
  overrides: ParserOverrides,
): ParsedTask {
  const url = parseUrl(instruction);
  if (!url) {
    throw new Error("No URL found in the instruction. Please include a full http(s) URL.");
  }

  const instructionDpr = parseDprFromInstruction(instruction);
  const instructionQuality = parseQualityFromInstruction(instruction);

  const task: ParsedTask = {
    url,
    waitUntil: parseWaitUntil(instruction),
    captures: parseCaptureRequests(instruction, overrides.sectionScope),
    image: {
      format: "jpg",
      quality: instructionQuality ?? overrides.quality,
      dpr: instructionDpr ?? overrides.dpr,
    },
    viewport: parseViewport(instruction),
    tags: parseTags(instruction),
    eagle: {
      folderName: parseFolderName(instruction),
      annotation: parseAnnotation(instruction),
      star: parseStar(instruction),
    },
  };

  return normalizeTask(task);
}

function isSectionType(value: unknown): value is SectionType {
  return (
    typeof value === "string" &&
    [
      "hero",
      "feature",
      "testimonial",
      "pricing",
      "team",
      "faq",
      "blog",
      "cta",
      "contact",
      "footer",
      "unknown",
    ].includes(value)
  );
}

function parseTaskFromJson(raw: unknown, overrides: ParserOverrides): ParsedTask | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  if (typeof data.url !== "string" || !/^https?:\/\//.test(data.url)) {
    return null;
  }

  const waitUntil =
    data.waitUntil === "load" ||
    data.waitUntil === "domcontentloaded" ||
    data.waitUntil === "networkidle"
      ? data.waitUntil
      : "networkidle";

  const captures: CaptureRequest[] = Array.isArray(data.captures)
    ? data.captures
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const parsed = item as Record<string, unknown>;
          if (parsed.mode !== "fullPage" && parsed.mode !== "section") {
            return null;
          }
          const targetType = isSectionType(parsed.targetType) ? parsed.targetType : undefined;
          const selector = typeof parsed.selector === "string" ? parsed.selector : undefined;
          const request: CaptureRequest = {
            mode: parsed.mode,
          };
          if (targetType !== undefined) {
            request.targetType = targetType;
          }
          if (selector !== undefined) {
            request.selector = selector;
          }
          return request;
        })
        .filter((item): item is CaptureRequest => item !== null)
    : [];

  if (captures.length === 0) {
    captures.push({ mode: "fullPage" }, { mode: "section" });
  }

  const imageRaw = (data.image as Record<string, unknown> | undefined) ?? {};
  const dprRaw = imageRaw.dpr;
  const dpr: DprOption =
    dprRaw === 1 || dprRaw === 2 || dprRaw === "auto" ? (dprRaw as DprOption) : overrides.dpr;

  const qualityRaw = Number(imageRaw.quality);
  const quality = Number.isFinite(qualityRaw) ? clampQuality(qualityRaw) : overrides.quality;

  const viewportRaw = (data.viewport as Record<string, unknown> | undefined) ?? {};
  const viewport = {
    width:
      Number.isFinite(Number(viewportRaw.width)) && Number(viewportRaw.width) >= 320
        ? Math.round(Number(viewportRaw.width))
        : DEFAULT_DESKTOP_VIEWPORT.width,
    height:
      Number.isFinite(Number(viewportRaw.height)) && Number(viewportRaw.height) >= 320
        ? Math.round(Number(viewportRaw.height))
        : DEFAULT_DESKTOP_VIEWPORT.height,
  };

  const tags = Array.isArray(data.tags)
    ? data.tags.filter((item): item is string => typeof item === "string")
    : [];
  const eagleRaw = (data.eagle as Record<string, unknown> | undefined) ?? {};

  const task: ParsedTask = {
    url: data.url,
    waitUntil,
    captures,
    image: {
      format: "jpg",
      quality,
      dpr,
    },
    viewport,
    tags,
    eagle: {
      folderName:
        typeof eagleRaw.folderName === "string" && eagleRaw.folderName.trim()
          ? eagleRaw.folderName.trim()
          : undefined,
      annotation:
        typeof eagleRaw.annotation === "string" && eagleRaw.annotation.trim()
          ? eagleRaw.annotation.trim()
          : undefined,
      star:
        Number.isFinite(Number(eagleRaw.star)) &&
        Number(eagleRaw.star) >= 0 &&
        Number(eagleRaw.star) <= 5
          ? Number(eagleRaw.star)
          : undefined,
    },
  };

  return normalizeTask(task);
}

async function tryParseWithLlm(
  instruction: string,
  overrides: ParserOverrides,
): Promise<ParsedTask | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const prompt = [
    "Parse the screenshot instruction into strict JSON.",
    "Return only JSON object with fields: url, waitUntil, captures, image, viewport, tags, eagle.",
    "captures items must be {mode:'fullPage'|'section', targetType?, selector?}.",
    "image.format must be 'jpg'.",
  ].join(" ");

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: instruction },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(content);
    return parseTaskFromJson(parsed, overrides);
  } catch {
    return null;
  }
}

export async function parseInstruction(
  instruction: string,
  overrides: ParserOverrides,
): Promise<ParsedTask> {
  const llmTask = await tryParseWithLlm(instruction, overrides).catch(() => null);
  if (llmTask) {
    return llmTask;
  }
  return buildRuleBasedTask(instruction, overrides);
}
