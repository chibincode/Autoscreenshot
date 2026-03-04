import { describe, expect, it } from "vitest";
import { classifySectionCandidate } from "../src/browser/section-detector.js";

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
});
