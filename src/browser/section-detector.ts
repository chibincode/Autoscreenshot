import type { Page } from "playwright";
import type {
  CaptureRequest,
  SectionDebugCandidate,
  SectionDetectionDebug,
  SectionResult,
  SectionScope,
  SectionScoreBreakdown,
  SectionSignalHit,
  SectionType,
} from "../types.js";
import { DEFAULT_DESKTOP_VIEWPORT } from "../core/defaults.js";

interface SectionCandidate {
  selector: string;
  tagName: string;
  id: string;
  className: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  headingCount: number;
  buttonCount: number;
  linkCount: number;
  imageCount: number;
  formCount: number;
  inputCount: number;
  mailtoCount: number;
  telCount: number;
  isSticky: boolean;
}

interface SectionClassification {
  sectionType: SectionType;
  confidence: number;
  scores: SectionScoreBreakdown;
  signals: SectionSignalHit[];
}

interface ScoredSection extends SectionResult {
  area: number;
  tagName: string;
  textPreview: string;
  scores: SectionScoreBreakdown;
  signals: SectionSignalHit[];
}

type ScoreLabel = Exclude<SectionType, "unknown">;

const SCORE_LABELS: ScoreLabel[] = [
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
];

const MAX_TEXT_PREVIEW_LENGTH = 160;
const MAX_SIGNAL_COUNT = 20;

export const CLASSIC_ORDER: SectionType[] = [
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
];

function createEmptyScores(): SectionScoreBreakdown {
  return {
    hero: 0,
    feature: 0,
    testimonial: 0,
    pricing: 0,
    team: 0,
    faq: 0,
    blog: 0,
    cta: 0,
    contact: 0,
    footer: 0,
    unknown: 0,
  };
}

function mergeScores(
  base: SectionScoreBreakdown,
  incoming: SectionScoreBreakdown,
): SectionScoreBreakdown {
  const merged = createEmptyScores();
  for (const key of [...SCORE_LABELS, "unknown"] as SectionType[]) {
    merged[key] = Math.max(base[key], incoming[key]);
  }
  return merged;
}

function dedupeSignals(signals: SectionSignalHit[]): SectionSignalHit[] {
  const seen = new Set<string>();
  const unique: SectionSignalHit[] = [];
  for (const signal of signals) {
    const key = `${signal.label}:${signal.weight}:${signal.rule}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(signal);
  }
  return unique;
}

function truncatePreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_TEXT_PREVIEW_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, MAX_TEXT_PREVIEW_LENGTH - 1)}…`;
}

export function classifySectionCandidate(
  candidate: SectionCandidate,
  viewportHeight: number,
): SectionClassification {
  const haystack = normalizeText(
    `${candidate.tagName} ${candidate.id} ${candidate.className} ${candidate.text}`,
  );
  const scores = createEmptyScores();
  const signals: SectionSignalHit[] = [];
  const addScore = (label: ScoreLabel, weight: number, rule: string): void => {
    scores[label] += weight;
    signals.push({ label, weight, rule });
  };

  const keywordSets: Record<ScoreLabel, string[]> = {
    hero: ["hero", "welcome", "introducing", "headline", "banner", "首屏", "欢迎"],
    feature: [
      "feature",
      "features",
      "benefit",
      "benefits",
      "service",
      "capability",
      "why us",
      "功能",
      "特点",
    ],
    testimonial: [
      "testimonial",
      "testimonials",
      "review",
      "reviews",
      "customer",
      "customers",
      "quote",
      "case study",
      "评价",
      "用户反馈",
    ],
    pricing: [
      "pricing",
      "price",
      "plans",
      "plan",
      "subscription",
      "monthly",
      "yearly",
      "套餐",
      "价格",
    ],
    team: [
      "team",
      "our team",
      "members",
      "leadership",
      "founders",
      "团队",
      "成员",
      "创始人",
    ],
    faq: ["faq", "questions", "question", "frequently asked questions", "常见问题", "问答"],
    blog: ["blog", "news", "posts", "post", "articles", "insights", "博客", "文章"],
    cta: [
      "cta",
      "call to action",
      "get started",
      "try free",
      "book demo",
      "sign up",
      "立即开始",
      "免费试用",
      "预约演示",
    ],
    contact: [
      "contact",
      "get in touch",
      "reach out",
      "email",
      "phone",
      "address",
      "联系我们",
      "联系方式",
      "电话",
      "邮箱",
    ],
    footer: ["footer", "copyright", "privacy", "terms", "联系方式", "copyright"],
  };

  for (const [type, keywords] of Object.entries(keywordSets) as Array<[ScoreLabel, string[]]>) {
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) {
        addScore(type, 2, `keyword:${keyword}`);
      }
    }
  }

  for (const weakFaqKeyword of ["help", "support"]) {
    if (haystack.includes(weakFaqKeyword)) {
      addScore("faq", 1, `weak_keyword:${weakFaqKeyword}`);
    }
  }

  const testimonialPhrases = [
    "wall of love",
    "customer love",
    "users love",
    "what users are saying",
    "loved by",
    "hear from our customers",
    "what our customers say",
    "customer stories",
    "our customers say",
    "real customer feedback",
  ];
  let testimonialStrong = false;
  for (const phrase of testimonialPhrases) {
    if (haystack.includes(phrase)) {
      addScore("testimonial", 5, `phrase:${phrase.replace(/\s+/g, "_")}`);
      testimonialStrong = true;
    }
  }

  const ctaPhrases = [
    "get started",
    "start now",
    "try free",
    "book demo",
    "sign up",
    "request demo",
    "contact sales",
    "join now",
    "立即开始",
    "免费试用",
    "预约演示",
    "立即注册",
  ];
  for (const phrase of ctaPhrases) {
    if (haystack.includes(phrase)) {
      addScore("cta", 3, `phrase:${phrase.replace(/\s+/g, "_")}`);
    }
  }

  const aspectRatio = candidate.width / Math.max(1, candidate.height);
  if (candidate.y <= viewportHeight * 0.35) {
    addScore("hero", 3, "hard:hero_top_fold");
  } else {
    addScore("hero", -6, "hard:hero_not_top_fold");
  }
  if (
    aspectRatio >= 1.45 &&
    aspectRatio <= 2.2 &&
    candidate.height >= viewportHeight * 0.62
  ) {
    addScore("hero", 2, "hard:hero_geometry_match");
  } else {
    addScore("hero", -2, "hard:hero_geometry_mismatch");
  }
  if (candidate.y >= viewportHeight * 1.0) {
    addScore("hero", -3, "hard:hero_below_first_fold");
  }

  if (candidate.y < viewportHeight * 0.85) {
    addScore("hero", 2, "position:top_85pct");
  }
  if (candidate.headingCount > 0) {
    addScore("hero", 1, "heading_count>0");
    addScore("feature", 1, "heading_count>0");
  }
  if (candidate.buttonCount > 0) {
    addScore("hero", 1, "button_count>0");
    addScore("pricing", 1, "button_count>0");
  }
  if (candidate.height >= Math.max(380, viewportHeight * 0.45)) {
    addScore("hero", 1, "height:large_block");
  }
  if (candidate.imageCount >= 2 && candidate.headingCount >= 2) {
    addScore("feature", 1, "layout:image_and_headings");
  }
  if (
    /["“”]|customer|review|testimonial|case study|评价|用户反馈/i.test(
      candidate.text,
    )
  ) {
    addScore("testimonial", 3, "regex:testimonial_semantic");
    testimonialStrong = true;
  }
  if (
    /\$|\b\d+\s?(mo|month|year|yr)\b|monthly|yearly|每月|每年/i.test(candidate.text)
  ) {
    addScore("pricing", 2, "regex:pricing_semantic");
  }
  if (candidate.imageCount >= 3 && candidate.headingCount >= 1) {
    addScore("team", 2, "layout:team_grid");
  }
  if (
    /\b(founder|co-founder|ceo|cto|lead|manager|director)\b|创始人|联合创始人|负责人|团队成员/i.test(
      candidate.text,
    )
  ) {
    addScore("team", 2, "regex:team_roles");
  }
  if ((candidate.text.match(/[?？]/g) ?? []).length >= 3) {
    addScore("faq", 2, "question_mark>=3");
  }
  if (candidate.linkCount >= 3) {
    addScore("blog", 1, "link_count>=3");
  }
  if (candidate.buttonCount >= 1) {
    addScore("cta", 1, "button_count>=1");
  }
  if (candidate.buttonCount >= 2) {
    addScore("cta", 1, "button_count>=2");
  }
  if (candidate.y > viewportHeight * 0.45) {
    addScore("cta", 1, "position:lower_page");
  }
  if (candidate.formCount >= 1 || candidate.inputCount >= 2) {
    addScore("contact", 3, "form_or_inputs");
  }
  if (candidate.mailtoCount + candidate.telCount >= 1) {
    addScore("contact", 2, "mailto_or_tel");
  }
  if (candidate.tagName === "footer") {
    addScore("footer", 5, "tag:footer");
    addScore("cta", -2, "conflict:footer");
    addScore("contact", -2, "conflict:footer");
  }
  if (candidate.isSticky && candidate.y < 140) {
    for (const label of SCORE_LABELS) {
      if (label === "footer") {
        continue;
      }
      addScore(label, -2, "penalty:sticky_header");
    }
  }

  if (scores.testimonial >= 4) {
    testimonialStrong = true;
  }
  if (testimonialStrong && scores.faq > 0) {
    addScore("faq", -1, "conflict:testimonial_strong");
  }
  if (testimonialStrong) {
    addScore("hero", -3, "conflict:testimonial_strong_vs_hero");
  }
  if ((candidate.formCount >= 1 || candidate.inputCount >= 2) && scores.cta > 0) {
    addScore("cta", -1, "conflict:contact_form_strong");
  }

  if (candidate.tagName === "footer" && scores.footer >= 4) {
    return {
      sectionType: "footer",
      confidence: 0.95,
      scores,
      signals: dedupeSignals(signals).slice(0, MAX_SIGNAL_COUNT),
    };
  }

  const sortedScores = SCORE_LABELS.map((label) => ({
    label,
    score: scores[label],
  })).sort((a, b) => b.score - a.score);
  const best = sortedScores[0];
  const second = sortedScores[1];

  let bestType: SectionType = "unknown";
  let bestScore = 0;
  if (best && best.score > 0) {
    bestType = best.label;
    bestScore = best.score;
  }

  if (bestScore < 2) {
    return {
      sectionType: "unknown",
      confidence: 0.35,
      scores,
      signals: dedupeSignals(signals).slice(0, MAX_SIGNAL_COUNT),
    };
  }

  const margin = bestScore - (second?.score ?? 0);
  const confidence = Math.min(1, Math.max(0.35, 0.26 + bestScore / 9 + margin / 12));
  return {
    sectionType: bestType,
    confidence,
    scores,
    signals: dedupeSignals(signals).slice(0, MAX_SIGNAL_COUNT),
  };
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function horizontalOverlapRatio(a: ScoredSection, b: ScoredSection): number {
  const left = Math.max(a.bbox.x, b.bbox.x);
  const right = Math.min(a.bbox.x + a.bbox.width, b.bbox.x + b.bbox.width);
  if (right <= left) {
    return 0;
  }
  const overlap = right - left;
  const minWidth = Math.min(a.bbox.width, b.bbox.width);
  return overlap / Math.max(1, minWidth);
}

export function mergeAdjacentSections(
  sections: ScoredSection[],
  maxGap = 48,
): ScoredSection[] {
  if (sections.length <= 1) {
    return sections;
  }

  const sorted = [...sections].sort((a, b) => a.bbox.y - b.bbox.y);
  const merged: ScoredSection[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const prev = merged[merged.length - 1];
    const prevBottom = prev.bbox.y + prev.bbox.height;
    const gap = current.bbox.y - prevBottom;

    if (
      prev.sectionType === current.sectionType &&
      prev.sectionType !== "unknown" &&
      gap >= 0 &&
      gap <= maxGap &&
      horizontalOverlapRatio(prev, current) >= 0.7
    ) {
      const top = Math.min(prev.bbox.y, current.bbox.y);
      const bottom = Math.max(
        prev.bbox.y + prev.bbox.height,
        current.bbox.y + current.bbox.height,
      );
      const left = Math.min(prev.bbox.x, current.bbox.x);
      const right = Math.max(
        prev.bbox.x + prev.bbox.width,
        current.bbox.x + current.bbox.width,
      );
      prev.bbox = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
      prev.confidence = Math.max(prev.confidence, current.confidence);
      prev.area = prev.bbox.width * prev.bbox.height;
      prev.scores = mergeScores(prev.scores, current.scores);
      prev.signals = dedupeSignals([...prev.signals, ...current.signals]).slice(
        0,
        MAX_SIGNAL_COUNT,
      );
      prev.textPreview = truncatePreview(`${prev.textPreview} ${current.textPreview}`);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

function pickClassicSections(
  sections: ScoredSection[],
  maxSections = 10,
): ScoredSection[] {
  const selected: ScoredSection[] = [];
  const used = new Set<string>();

  for (const type of CLASSIC_ORDER) {
    const candidates = sections
      .filter((section) => section.sectionType === type)
      .sort((a, b) => b.confidence * b.area - a.confidence * a.area);

    const picked = candidates.find((section) => !used.has(section.selector));
    if (picked) {
      selected.push(picked);
      used.add(picked.selector);
    }
    if (selected.length >= maxSections) {
      return selected;
    }
  }

  return selected.slice(0, maxSections);
}

export function pickSectionsForScope(
  sections: ScoredSection[],
  scope: SectionScope,
  manualRequests: CaptureRequest[],
  classicMaxSections: number,
): ScoredSection[] {
  if (scope === "all-top-level") {
    return [...sections].sort((a, b) => a.bbox.y - b.bbox.y).slice(0, 12);
  }

  if (scope === "manual") {
    const selected: ScoredSection[] = [];
    const used = new Set<string>();
    for (const request of manualRequests.filter((item) => item.mode === "section")) {
      let match: ScoredSection | undefined;
      if (request.selector) {
        match = sections.find((item) => item.selector === request.selector);
      } else if (request.targetType) {
        match = sections
          .filter((item) => item.sectionType === request.targetType)
          .sort((a, b) => b.confidence * b.area - a.confidence * a.area)[0];
      }
      if (match && !used.has(match.selector)) {
        selected.push(match);
        used.add(match.selector);
      }
    }
    return selected;
  }

  return pickClassicSections(sections, classicMaxSections);
}

function toDebugCandidate(section: ScoredSection): SectionDebugCandidate {
  return {
    selector: section.selector,
    tagName: section.tagName,
    sectionType: section.sectionType,
    confidence: section.confidence,
    bbox: section.bbox,
    textPreview: section.textPreview,
    scores: section.scores,
    signals: section.signals,
  };
}

const COLLECT_SECTION_CANDIDATES_SCRIPT = String.raw`
(() => {
  const candidateSet = new Set();
  const selectors = ["main > section", "section", "article", "footer", "main > div"];

  for (let i = 0; i < selectors.length; i += 1) {
    const nodes = document.querySelectorAll(selectors[i]);
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node = nodes[nodeIndex];
      if (node instanceof HTMLElement) {
        candidateSet.add(node);
      }
    }
  }

  const namedNodes = document.querySelectorAll("[id], [class]");
  for (let i = 0; i < namedNodes.length; i += 1) {
    const node = namedNodes[i];
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    const token = (String(node.id || "") + " " + String(node.className || "")).toLowerCase();
    if (/(hero|feature|testimonial|review|pricing|team|faq|blog|cta|contact|footer|首屏|功能|评价|价格|团队|问答|博客|联系方式)/.test(token)) {
      candidateSet.add(node);
    }
  }

  function cssPath(element) {
    if (element.id) {
      return "#" + element.id;
    }
    const parts = [];
    let current = element;
    while (current && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const siblings = [];
      if (current.parentElement) {
        const parentChildren = current.parentElement.children;
        for (let i = 0; i < parentChildren.length; i += 1) {
          const child = parentChildren[i];
          if (child.tagName === current.tagName) {
            siblings.push(child);
          }
        }
      }
      const index = Math.max(1, siblings.indexOf(current) + 1);
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const opacity = Number.parseFloat(style.opacity || "1");
    if (!Number.isNaN(opacity) && opacity <= 0.01) {
      return false;
    }
    return true;
  }

  const candidates = [];
  for (const element of candidateSet) {
    if (!isVisible(element)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const stickyLike = style.position === "fixed" || style.position === "sticky";
    if (rect.width < 320 || rect.height < 220) {
      continue;
    }
    if (rect.width * rect.height < 90000) {
      continue;
    }
    if (stickyLike && rect.top < 140) {
      continue;
    }

    const text = String(element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000);
    candidates.push({
      selector: cssPath(element),
      tagName: element.tagName.toLowerCase(),
      id: element.id || "",
      className:
        typeof element.className === "string"
          ? element.className
          : (element.getAttribute("class") || ""),
      text,
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
      headingCount: element.querySelectorAll("h1, h2, h3").length,
      buttonCount: element.querySelectorAll(
        "button, [role='button'], a[class*='btn'], a[class*='button']"
      ).length,
      linkCount: element.querySelectorAll("a").length,
      imageCount: element.querySelectorAll("img, picture, svg").length,
      formCount: element.querySelectorAll("form").length,
      inputCount: element.querySelectorAll("input, textarea, select").length,
      mailtoCount: element.querySelectorAll("a[href^='mailto:']").length,
      telCount: element.querySelectorAll("a[href^='tel:']").length,
      isSticky: stickyLike
    });
  }

  candidates.sort(function (a, b) {
    return a.y - b.y;
  });

  return candidates;
})()
`;

async function collectSectionCandidates(page: Page): Promise<SectionCandidate[]> {
  return page.evaluate(COLLECT_SECTION_CANDIDATES_SCRIPT) as Promise<SectionCandidate[]>;
}

export async function detectSections(
  page: Page,
  scope: SectionScope,
  manualRequests: CaptureRequest[],
  classicMaxSections = 10,
): Promise<{ sections: SectionResult[]; debug: SectionDetectionDebug }> {
  const viewportSize = page.viewportSize() ?? DEFAULT_DESKTOP_VIEWPORT;
  const candidates = await collectSectionCandidates(page);

  const scored: ScoredSection[] = candidates
    .map((candidate) => {
      const { sectionType, confidence, scores, signals } = classifySectionCandidate(
        candidate,
        viewportSize.height,
      );

      return {
        sectionType,
        selector: candidate.selector,
        bbox: {
          x: Math.max(0, Math.round(candidate.x)),
          y: Math.max(0, Math.round(candidate.y)),
          width: Math.round(candidate.width),
          height: Math.round(candidate.height),
        },
        confidence,
        tagName: candidate.tagName,
        textPreview: truncatePreview(candidate.text),
        scores,
        signals,
        area: candidate.width * candidate.height,
      };
    })
    .filter((item) => item.bbox.height >= 220 && item.bbox.width >= 320);

  const merged = mergeAdjacentSections(scored);
  const selected = pickSectionsForScope(merged, scope, manualRequests, classicMaxSections);
  const debug: SectionDetectionDebug = {
    scope,
    viewportHeight: viewportSize.height,
    rawCandidates: scored.map(toDebugCandidate),
    mergedCandidates: merged.map(toDebugCandidate),
    selectedCandidates: selected.map(toDebugCandidate),
  };

  return {
    sections: selected.map(
      ({ area: _area, scores: _scores, signals: _signals, textPreview: _textPreview, tagName: _tagName, ...rest }) => rest,
    ),
    debug,
  };
}
