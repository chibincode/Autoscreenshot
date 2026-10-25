import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { INTERFACE_VERSION_STORAGE_KEY, readInterfaceVersion, rememberInterfaceVersion, shortTaskDate, siteLabel } from "../web/src/interface-version.js";
import { InterfaceVersionSwitch, NewPagesToolbar, NewTaskViews } from "../web/src/WorkspaceChrome.js";

describe("interface version preference", () => {
  it.each([null, "classic", "unknown", "NEW", ""]) ("defaults safely to Classic for %s", value => {
    expect(readInterfaceVersion({ getItem: () => value })).toBe("classic");
  });
  it("restores an explicit New preference", () => {
    expect(readInterfaceVersion({ getItem: () => "new" })).toBe("new");
  });
  it("uses Classic when storage access fails", () => {
    expect(readInterfaceVersion({ getItem: () => { throw new Error("blocked"); } })).toBe("classic");
  });
  it("writes only the UI preference key", () => {
    const setItem = vi.fn();
    rememberInterfaceVersion({ setItem }, "new");
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(INTERFACE_VERSION_STORAGE_KEY, "new");
  });
  it("keeps switching usable if storage is blocked", () => {
    expect(() => rememberInterfaceVersion({ setItem: () => { throw new Error("blocked"); } }, "classic")).not.toThrow();
  });
  it("formats a site label without changing the source URL", () => {
    expect(siteLabel("https://www.example.com/blog?q=1")).toBe("example.com");
    expect(siteLabel(null)).toBe("Screenshot task");
  });
  it("keeps the task date compact and handles invalid dates", () => {
    expect(shortTaskDate("2026-10-16T12:00:00.000Z")).toBe("Oct 16");
    expect(shortTaskDate("invalid")).toBe("-");
  });
});

describe("shared workspace presentation", () => {
  it("keeps Queue and History controlled at the task-list entry point", () => {
    const onHistoryChange = vi.fn();
    const element = NewTaskViews({ history: true, count: 25, onHistoryChange });
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain('aria-pressed="true">History');
    expect(markup).toContain('25 tasks');
    const nav = element.props.children[0] as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    nav.props.children[0].props.onClick();
    nav.props.children[1].props.onClick();
    expect(onHistoryChange.mock.calls).toEqual([[false], [true]]);
  });
  it("renders controlled version buttons without submitting any form", () => {
    const onChange = vi.fn();
    const markup = renderToStaticMarkup(createElement(InterfaceVersionSwitch, { value: "classic", onChange }));
    expect(markup).toContain('aria-label="Interface version"');
    expect(markup).toContain('type="button" aria-pressed="true">Classic');
    expect(markup).toContain('type="button" aria-pressed="false">New');
    expect(onChange).not.toHaveBeenCalled();
  });
  it("delegates both version changes to the shared controlled owner", () => {
    const onChange = vi.fn();
    const element = InterfaceVersionSwitch({ value: "classic", onChange });
    const buttons = element.props.children as ReactElement<{ onClick: () => void }>[];
    buttons[1].props.onClick();
    buttons[0].props.onClick();
    expect(onChange.mock.calls).toEqual([["new"], ["classic"]]);
  });
  it("shows real counts and controlled filter/layout/overview state", () => {
    const markup = renderToStaticMarkup(createElement(NewPagesToolbar, {
      total: 8,
      selected: 3,
      presentation: { filter: "selected", layout: "list", overview: true, onFilterChange: vi.fn(), onLayoutChange: vi.fn(), onOverviewChange: vi.fn() },
    }));
    expect(markup).toContain('Selected <span>3</span>');
    expect(markup).toContain('All pages <span>8</span>');
    expect(markup).toContain('aria-label="List view" title="List view" aria-pressed="true"');
    expect(markup).toContain('checked=""');
  });
});
