import { describe, expect, it } from "vitest";
import {
  isShortcutOwnerElement,
  type ShortcutOwnerTarget,
} from "./shortcutTarget.js";

function el(
  tag: string,
  attrs: Record<string, string> = {},
): ShortcutOwnerTarget {
  const isEditable =
    attrs.contenteditable === "true" || attrs.contenteditable === "";
  return {
    tagName: tag.toUpperCase(),
    getAttribute(name: string) {
      return attrs[name] ?? null;
    },
    hasAttribute(name: string) {
      return name in attrs;
    },
    isContentEditable: isEditable,
  };
}

describe("shortcutTarget – isShortcutOwnerElement", () => {
  it("returns true for input/select/textarea/button", () => {
    expect(isShortcutOwnerElement(el("input"))).toBe(true);
    expect(isShortcutOwnerElement(el("select"))).toBe(true);
    expect(isShortcutOwnerElement(el("textarea"))).toBe(true);
    expect(isShortcutOwnerElement(el("button"))).toBe(true);
  });

  it("returns true for anchor with href, false without", () => {
    expect(isShortcutOwnerElement(el("a", { href: "/path" }))).toBe(true);
    expect(isShortcutOwnerElement(el("a", { href: "#x" }))).toBe(true);
    expect(isShortcutOwnerElement(el("a"))).toBe(false);
  });

  it("returns true for contenteditable", () => {
    expect(isShortcutOwnerElement(el("div", { contenteditable: "true" }))).toBe(
      true,
    );
    const ce: ShortcutOwnerTarget = {
      tagName: "DIV",
      getAttribute: (n: string) => (n === "contenteditable" ? "" : null),
      hasAttribute: () => false,
      isContentEditable: true,
    };
    expect(isShortcutOwnerElement(ce)).toBe(true);
  });

  it("returns true for role=button and role=slider", () => {
    expect(isShortcutOwnerElement(el("div", { role: "button" }))).toBe(true);
    expect(isShortcutOwnerElement(el("div", { role: "slider" }))).toBe(true);
    expect(isShortcutOwnerElement(el("span", { role: "button" }))).toBe(true);
  });

  it("returns false for non-interactive surfaces", () => {
    expect(isShortcutOwnerElement(el("div"))).toBe(false);
    expect(isShortcutOwnerElement(el("span"))).toBe(false);
    expect(isShortcutOwnerElement(el("canvas", { role: "img" }))).toBe(false);
    expect(isShortcutOwnerElement(null)).toBe(false);
  });

  it("returns true for .element-select-btn (button) even with role", () => {
    // element-select-btn is a button element – must be owned
    expect(
      isShortcutOwnerElement(el("button", { class: "element-select-btn" })),
    ).toBe(true);
  });

  it("handles role case insensitivity", () => {
    expect(isShortcutOwnerElement(el("div", { role: "Button" }))).toBe(true);
    expect(isShortcutOwnerElement(el("div", { role: "SLIDER" }))).toBe(true);
  });
});
