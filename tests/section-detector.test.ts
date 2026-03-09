import { describe, expect, it } from "vitest";
import {
  classifySectionCandidate,
  pickSectionsForScope,
} from "../src/browser/section-detector.js";

function baseCandidate() {
  return {
    selector: "main > section:nth-of-type(1)",
    tagName: "section",
    id: "",
    className: "",
    text: "",
    x: 0,
    y: 0,
    width: 1200,
    height: 600,
    headingCount: 0,
    buttonCount: 0,
    linkCount: 0,
    imageCount: 0,
    formCount: 0,
    inputCount: 0,
    mailtoCount: 0,
    telCount: 0,
    isSticky: false,
  };
}

function scoreBreakdown(base: Partial<Record<string, number>>) {
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
    ...base,
  };
}

function scoredSection(overrides: Record<string, unknown>) {
  const bbox = (overrides.bbox as { x: number; y: number; width: number; height: number }) ?? {
    x: 0,
    y: 0,
    width: 1920,
    height: 400,
  };
  return {
    sectionType: "unknown",
    selector: "section",
    bbox,
    confidence: 0.5,
    area: bbox.width * bbox.height,
    tagName: "section",
    textPreview: "",
    scores: scoreBreakdown({ unknown: 1 }),
    signals: [],
    ...overrides,
  };
}

describe("classifySectionCandidate", () => {
  it("recognizes hero blocks", () => {
    const candidate = {
      ...baseCandidate(),
      className: "hero-banner",
      text: "Welcome to product. Start now",
      headingCount: 1,
      buttonCount: 2,
      y: 10,
      height: 760,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.sectionType).toBe("hero");
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it("recognizes testimonial blocks", () => {
    const candidate = {
      ...baseCandidate(),
      className: "customer-reviews",
      text: "\"Amazing product\" - customer review",
      headingCount: 1,
      linkCount: 2,
      y: 1300,
      height: 480,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.sectionType).toBe("testimonial");
  });

  it("prefers testimonial for quotes with company role attribution", () => {
    const candidate = {
      ...baseCandidate(),
      className: "customer-quote",
      text:
        "“Every hour spent chasing bugs is time away from building features that users actually want.” Dylan Babbs CTO of Profound",
      imageCount: 1,
      y: 2100,
      height: 420,
    };
    const result = classifySectionCandidate(candidate, 1080);
    expect(result.sectionType).toBe("testimonial");
    expect(result.scores.testimonial).toBeGreaterThan(result.scores.team);
    expect(
      result.signals.some((signal) => signal.rule === "pattern:quote_with_role_company"),
    ).toBe(true);
  });

  it("keeps testimonial over faq on mixed signals", () => {
    const candidate = {
      ...baseCandidate(),
      className: "testimonial-slider support",
      text: "Hear from our customers. What our customers say? Why choose us? Does this work?",
      headingCount: 1,
      y: 2100,
      height: 500,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.sectionType).toBe("testimonial");
    expect(result.scores.testimonial).toBeGreaterThan(result.scores.faq);
    expect(
      result.signals.some((signal) => signal.rule.includes("phrase:hear_from_our_customers")),
    ).toBe(true);
    expect(
      result.signals.some((signal) => signal.rule === "conflict:testimonial_strong"),
    ).toBe(true);
  });

  it("still recognizes faq with strong question patterns", () => {
    const candidate = {
      ...baseCandidate(),
      className: "faq support",
      text: "Frequently asked questions. What is this? How does it work? Can I cancel?",
      headingCount: 1,
      y: 1800,
      height: 480,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.sectionType).toBe("faq");
    expect(result.scores.faq).toBeGreaterThanOrEqual(4);
    expect(result.signals.some((signal) => signal.rule === "question_mark>=3")).toBe(true);
  });

  it("recognizes footer blocks by tag", () => {
    const candidate = {
      ...baseCandidate(),
      tagName: "footer",
      className: "site-footer",
      text: "Copyright privacy terms",
      y: 5200,
      height: 340,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.sectionType).toBe("footer");
  });

  it("recognizes team blocks", () => {
    const candidate = {
      ...baseCandidate(),
      className: "our-team leadership",
      text: "Meet our team. Founder and CEO.",
      headingCount: 1,
      imageCount: 4,
      y: 1600,
      height: 520,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.sectionType).toBe("team");
    expect(result.scores.team).toBeGreaterThan(0);
  });

  it("prefers feature for numbered walkthrough sections even when customers are mentioned", () => {
    const candidate = {
      ...baseCandidate(),
      className: "product-walkthrough",
      text:
        "Interfere finds 01issues in your app, understands 02what's happening, and owns resolution 03from first signal to production. 01 Learn about issues before your customers do 02 Understand what's going wrong 03 Fix problems with confidence",
      headingCount: 5,
      buttonCount: 2,
      y: 1400,
      height: 820,
    };
    const result = classifySectionCandidate(candidate, 1080);
    expect(result.sectionType).toBe("feature");
    expect(result.scores.feature).toBeGreaterThan(result.scores.testimonial);
    expect(result.scores.feature).toBeGreaterThan(result.scores.cta);
    expect(
      result.signals.some((signal) => signal.rule === "content:numbered_steps"),
    ).toBe(true);
  });

  it("recognizes changelog grids as blog sections", () => {
    const candidate = {
      ...baseCandidate(),
      className: "changelog-grid",
      text:
        "CHANGELOG The Latest FEB 11, 2026 Timeline Improvements FEB 1, 2026 OAuth applications & scoped API keys DEC 22, 2025 We're in review to be certified as SOC 2 Type II compliant See all releases",
      headingCount: 1,
      linkCount: 4,
      y: 5400,
      height: 560,
    };
    const result = classifySectionCandidate(candidate, 1080);
    expect(result.sectionType).toBe("blog");
    expect(result.scores.blog).toBeGreaterThan(result.scores.feature);
    expect(result.scores.blog).toBeGreaterThan(result.scores.testimonial);
    expect(
      result.signals.some((signal) => signal.rule === "content:dated_updates"),
    ).toBe(true);
    expect(
      result.signals.some((signal) => signal.rule === "phrase:blog_strong:changelog"),
    ).toBe(true);
  });

  it("recognizes cta blocks", () => {
    const candidate = {
      ...baseCandidate(),
      className: "cta-banner",
      text: "Ready to launch? Get started and book demo.",
      headingCount: 1,
      buttonCount: 2,
      y: 2200,
      height: 420,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.sectionType).toBe("cta");
    expect(result.scores.cta).toBeGreaterThan(0);
  });

  it("does not misclassify sales cta with custom pricing copy as pricing", () => {
    const candidate = {
      ...baseCandidate(),
      className: "cta-banner",
      text:
        "Ready to build? Start building a voice AI agent with a free account. Reach out to us if you're interested in custom pricing. Contact sales. No credit card required. 1,000 free agent session minutes monthly.",
      headingCount: 1,
      buttonCount: 2,
      y: 2600,
      height: 520,
    };
    const result = classifySectionCandidate(candidate, 1080);
    expect(result.sectionType).toBe("cta");
    expect(result.scores.cta).toBeGreaterThan(result.scores.pricing);
    expect(
      result.signals.some((signal) => signal.rule === "conflict:cta_sales_motion_vs_pricing"),
    ).toBe(true);
  });

  it("still recognizes actual pricing blocks with price and billing semantics", () => {
    const candidate = {
      ...baseCandidate(),
      className: "pricing-plans",
      text: "Pricing plans. Start at $29 / month. Billed yearly for teams.",
      headingCount: 1,
      buttonCount: 3,
      y: 1800,
      height: 620,
    };
    const result = classifySectionCandidate(candidate, 1080);
    expect(result.sectionType).toBe("pricing");
    expect(result.scores.pricing).toBeGreaterThan(result.scores.cta);
    expect(
      result.signals.some((signal) => signal.rule === "regex:pricing_semantic"),
    ).toBe(true);
  });

  it("recognizes contact blocks", () => {
    const candidate = {
      ...baseCandidate(),
      className: "contact-us",
      text: "Contact us via email and phone",
      headingCount: 1,
      formCount: 1,
      inputCount: 3,
      mailtoCount: 1,
      y: 2500,
      height: 560,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.sectionType).toBe("contact");
    expect(result.scores.contact).toBeGreaterThan(result.scores.cta);
  });

  it("penalizes cta/contact when candidate is footer", () => {
    const candidate = {
      ...baseCandidate(),
      tagName: "footer",
      className: "site-footer cta",
      text: "Get started now. Contact us.",
      buttonCount: 2,
      y: 4200,
      height: 360,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.sectionType).toBe("footer");
    expect(result.signals.some((signal) => signal.rule === "tag:footer")).toBe(true);
    expect(result.signals.some((signal) => signal.rule === "conflict:footer")).toBe(true);
  });

  it("reduces cta score when contact form signal is strong", () => {
    const candidate = {
      ...baseCandidate(),
      className: "contact cta",
      text: "Get started by reaching out. Contact us today.",
      buttonCount: 2,
      formCount: 1,
      inputCount: 2,
      y: 1900,
      height: 480,
    };
    const result = classifySectionCandidate(candidate, 900);
    expect(result.scores.contact).toBeGreaterThan(0);
    expect(result.scores.cta).toBeGreaterThan(0);
    expect(
      result.signals.some((signal) => signal.rule === "conflict:contact_form_strong"),
    ).toBe(true);
  });

  it("does not classify below-fold wall-of-love block as hero", () => {
    const candidate = {
      ...baseCandidate(),
      selector: "section:nth-of-type(2)",
      text: "WALL OF LOVE Powering the world's most popular Electron apps",
      headingCount: 2,
      buttonCount: 2,
      y: 1402,
      width: 1920,
      height: 1093,
    };
    const result = classifySectionCandidate(candidate, 1080);
    expect(result.sectionType).not.toBe("hero");
    expect(result.scores.testimonial).toBeGreaterThan(result.scores.hero);
  });

  it("prefers hero for top-of-page 16:9-like first screen blocks", () => {
    const candidate = {
      ...baseCandidate(),
      className: "hero",
      text: "Build apps faster. Get started now.",
      headingCount: 1,
      buttonCount: 2,
      y: 100,
      width: 1920,
      height: 1080,
    };
    const result = classifySectionCandidate(candidate, 1080);
    expect(result.sectionType).toBe("hero");
    expect(
      result.signals.some((signal) => signal.rule === "hard:hero_top_fold"),
    ).toBe(true);
    expect(
      result.signals.some((signal) => signal.rule === "hard:hero_geometry_match"),
    ).toBe(true);
  });

  it("applies testimonial strong conflict against hero", () => {
    const candidate = {
      ...baseCandidate(),
      className: "wall-of-love",
      text: "Wall of love. Hear from our customers and what users are saying.",
      headingCount: 1,
      y: 1100,
      width: 1920,
      height: 900,
    };
    const result = classifySectionCandidate(candidate, 1080);
    expect(
      result.signals.some(
        (signal) => signal.rule === "conflict:testimonial_strong_vs_hero",
      ),
    ).toBe(true);
  });

  it("prioritizes faq on strong faq phrases even with testimonial noise", () => {
    const candidate = {
      ...baseCandidate(),
      className: "faq customer-reviews",
      text: "F.A.Q Questions & answers. Frequently asked questions. Customer review and quote.",
      headingCount: 1,
      y: 2500,
      height: 820,
    };
    const result = classifySectionCandidate(candidate, 1080);
    expect(result.sectionType).toBe("faq");
    expect(result.scores.faq).toBeGreaterThan(result.scores.testimonial);
    expect(
      result.signals.some((signal) => signal.rule.startsWith("phrase:faq_strong:")),
    ).toBe(true);
    expect(
      result.signals.some((signal) => signal.rule === "conflict:testimonial_strong"),
    ).toBe(false);
  });
});

describe("pickSectionsForScope classic selection", () => {
  it("selects up to 3 feature sections in classic mode", () => {
    const sections = [
      scoredSection({
        sectionType: "hero",
        selector: "#hero",
        confidence: 0.9,
        scores: scoreBreakdown({ hero: 8 }),
      }),
      scoredSection({
        sectionType: "feature",
        selector: "#feature-1",
        confidence: 0.95,
        bbox: { x: 0, y: 1800, width: 1920, height: 500 },
        scores: scoreBreakdown({ feature: 7 }),
      }),
      scoredSection({
        sectionType: "feature",
        selector: "#feature-2",
        confidence: 0.92,
        bbox: { x: 0, y: 2600, width: 1920, height: 500 },
        scores: scoreBreakdown({ feature: 6 }),
      }),
      scoredSection({
        sectionType: "feature",
        selector: "#feature-3",
        confidence: 0.9,
        bbox: { x: 0, y: 3400, width: 1920, height: 500 },
        scores: scoreBreakdown({ feature: 6 }),
      }),
      scoredSection({
        sectionType: "feature",
        selector: "#feature-4",
        confidence: 0.88,
        bbox: { x: 0, y: 4200, width: 1920, height: 500 },
        scores: scoreBreakdown({ feature: 5 }),
      }),
      scoredSection({
        sectionType: "testimonial",
        selector: "#testimonial",
        confidence: 0.85,
        bbox: { x: 0, y: 5200, width: 1920, height: 600 },
        scores: scoreBreakdown({ testimonial: 7 }),
      }),
    ] as any;

    const selected = pickSectionsForScope(
      sections,
      "classic",
      [],
      10,
      { width: 1920, height: 9000 },
    );

    const featureCount = selected.filter((item) => item.sectionType === "feature").length;
    expect(featureCount).toBe(3);
  });

  it("respects classicMaxSections total limit while allowing multiple features", () => {
    const sections = [
      scoredSection({ sectionType: "hero", selector: "#hero", confidence: 0.9 }),
      scoredSection({
        sectionType: "feature",
        selector: "#feature-1",
        confidence: 0.95,
        bbox: { x: 0, y: 1800, width: 1920, height: 500 },
      }),
      scoredSection({
        sectionType: "feature",
        selector: "#feature-2",
        confidence: 0.92,
        bbox: { x: 0, y: 2600, width: 1920, height: 500 },
      }),
      scoredSection({
        sectionType: "feature",
        selector: "#feature-3",
        confidence: 0.9,
        bbox: { x: 0, y: 3400, width: 1920, height: 500 },
      }),
      scoredSection({
        sectionType: "testimonial",
        selector: "#testimonial",
        confidence: 0.85,
        bbox: { x: 0, y: 5200, width: 1920, height: 600 },
      }),
    ] as any;

    const selected = pickSectionsForScope(
      sections,
      "classic",
      [],
      4,
      { width: 1920, height: 9000 },
    );

    expect(selected.length).toBe(4);
    expect(selected[0].sectionType).toBe("hero");
    expect(selected.filter((item) => item.sectionType === "feature").length).toBe(3);
  });

  it("dedupes high-overlap clips and replaces loser with alternate candidate", () => {
    const sections = [
      scoredSection({
        sectionType: "feature",
        selector: "#feature-main",
        confidence: 0.98,
        bbox: { x: 0, y: 4000, width: 1920, height: 320 },
        scores: scoreBreakdown({ feature: 8 }),
      }),
      scoredSection({
        sectionType: "testimonial",
        selector: "#testimonial-main",
        confidence: 0.86,
        bbox: { x: 0, y: 4024, width: 1920, height: 360 },
        scores: scoreBreakdown({ testimonial: 7 }),
      }),
      scoredSection({
        sectionType: "testimonial",
        selector: "#testimonial-alt",
        confidence: 0.7,
        bbox: { x: 0, y: 6200, width: 1920, height: 420 },
        scores: scoreBreakdown({ testimonial: 5 }),
      }),
    ] as any;

    const selected = pickSectionsForScope(
      sections,
      "classic",
      [],
      10,
      { width: 1920, height: 10000 },
    );

    expect(selected.some((item) => item.selector === "#feature-main")).toBe(true);
    expect(selected.some((item) => item.selector === "#testimonial-main")).toBe(false);
    expect(selected.some((item) => item.selector === "#testimonial-alt")).toBe(true);
  });

  it("drops conflicting category when no non-overlapping alternate exists", () => {
    const sections = [
      scoredSection({
        sectionType: "feature",
        selector: "#feature-main",
        confidence: 0.98,
        bbox: { x: 0, y: 4000, width: 1920, height: 320 },
      }),
      scoredSection({
        sectionType: "testimonial",
        selector: "#testimonial-main",
        confidence: 0.86,
        bbox: { x: 0, y: 4024, width: 1920, height: 360 },
      }),
    ] as any;

    const selected = pickSectionsForScope(
      sections,
      "classic",
      [],
      10,
      { width: 1920, height: 10000 },
    );

    expect(selected.some((item) => item.sectionType === "feature")).toBe(true);
    expect(selected.some((item) => item.sectionType === "testimonial")).toBe(false);
  });
});
