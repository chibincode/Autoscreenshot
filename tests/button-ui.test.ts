import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  Button,
} from "../web/src/ui/Button.js";

describe("production Button contract", () => {
  it("exports the semantic registry consumed by the design system", () => {
    expect(BUTTON_VARIANTS).toEqual(["primary", "secondary", "danger", "ghost"]);
    expect(BUTTON_SIZES).toEqual(["sm", "md", "lg"]);
  });

  it("uses safe native defaults and semantic classes", () => {
    const markup = renderToStaticMarkup(
      createElement(Button, { variant: "primary", size: "lg", children: "Run" }),
    );

    expect(markup).toContain('type="button"');
    expect(markup).toContain("ui-button--primary");
    expect(markup).toContain("ui-button--lg");
    expect(markup).not.toContain("disabled");
  });

  it("makes loading state unavailable and announces that it is busy", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Button,
        { loading: true, loadingLabel: "Queueing…", children: "Import selected" },
      ),
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-loading="true"');
    expect(markup).toContain("Import selected");
    expect(markup).toContain("Queueing…");
  });
});
