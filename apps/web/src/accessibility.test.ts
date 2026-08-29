import { describe, expect, it, vi } from "vitest";
import {
  attachRovingListeners,
  createLiveStatus,
  createReducedMotionController,
  createRovingController,
  getCanvasKeyboardAction,
  getRovingIndex,
  type LiveElement,
  type RovingElement,
  type EventTargetLike,
} from "./accessibility.js";

// Minimal fake element for roving tests
function fakeElement(): RovingElement {
  const attrs = new Map<string, string>();
  return {
    tabIndex: -1,
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    hasAttribute(name: string) {
      return attrs.has(name);
    },
    focus: vi.fn(),
  };
}

function fakeLiveElement(): LiveElement {
  const attrs = new Map<string, string>();
  let text: string | null = "";
  return {
    get textContent() {
      return text;
    },
    set textContent(v: string | null) {
      text = v;
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    hasAttribute(name: string) {
      return attrs.has(name);
    },
  };
}

function fakeContainer(): EventTargetLike & { dispatch(event: unknown): void } {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(event: unknown) {
      const e = event as { type?: string };
      const type = (e as { type?: string }).type ?? "keydown";
      const set = listeners.get(type);
      if (set) for (const fn of set) fn(event);
    },
  };
}

describe("accessibility – keyboard semantics", () => {
  it("maps timeline keys to explicit actions", () => {
    expect(getCanvasKeyboardAction("ArrowLeft")).toBe("previous");
    expect(getCanvasKeyboardAction("ArrowDown")).toBe("previous");
    expect(getCanvasKeyboardAction("ArrowRight")).toBe("next");
    expect(getCanvasKeyboardAction("ArrowUp")).toBe("next");
    expect(getCanvasKeyboardAction("Home")).toBe("first");
    expect(getCanvasKeyboardAction("End")).toBe("last");
    expect(getCanvasKeyboardAction("x")).toBe("none");
  });

  it("computes roving index with clamping and no NaN", () => {
    expect(getRovingIndex(1, "ArrowRight", 3)).toBe(2);
    expect(getRovingIndex(0, "ArrowLeft", 3)).toBe(0);
    expect(getRovingIndex(1, "Home", 3)).toBe(0);
    expect(getRovingIndex(1, "End", 3)).toBe(2);
    expect(getRovingIndex(1, "Enter", 3)).toBe(1);
    expect(getRovingIndex(Number.NaN, "ArrowRight", 3)).toBe(0);
    expect(getRovingIndex(0, "ArrowRight", 0)).toBe(0);
    expect(Number.isNaN(getRovingIndex(1, "ArrowRight", 3))).toBe(false);
  });

  it("creates roving controller with selectable semantics and cleanup", () => {
    const a = fakeElement();
    const b = fakeElement();
    const c = fakeElement();
    const onSelect = vi.fn();
    const ctrl = createRovingController([a, b, c], {
      initialIndex: 1,
      onSelect,
    });
    expect(a.tabIndex).toBe(-1);
    expect(b.tabIndex).toBe(0);
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(ctrl.getSelectedIndex()).toBe(1);
    ctrl.handleKey("ArrowRight");
    expect(ctrl.getSelectedIndex()).toBe(2);
    expect(c.tabIndex).toBe(0);
    expect(onSelect).toHaveBeenCalledWith(2, c);
    ctrl.select(0);
    expect(ctrl.getSelectedIndex()).toBe(0);
    ctrl.dispose();
    expect(
      c.hasAttribute("aria-selected") || a.hasAttribute("aria-selected"),
    ).toBe(false);
    ctrl.handleKey("ArrowRight");
    expect(ctrl.getSelectedIndex()).toBe(0);
  });

  it("does not mutate caller array and isolates instances (no global)", () => {
    const el1 = fakeElement();
    const el2 = fakeElement();
    const arr = [el1, el2];
    const ctrl1 = createRovingController(arr);
    const ctrl2 = createRovingController(arr, { initialIndex: 1 });
    ctrl1.select(1);
    expect(ctrl1.getSelectedIndex()).toBe(1);
    expect(ctrl2.getSelectedIndex()).toBe(1);
    expect(arr.length).toBe(2);
    ctrl1.dispose();
    ctrl2.dispose();
  });

  it("supports wrap option deterministically", () => {
    const a = fakeElement();
    const b = fakeElement();
    const ctrl = createRovingController([a, b], { wrap: true });
    expect(ctrl.getSelectedIndex()).toBe(0);
    ctrl.handleKey("ArrowLeft");
    expect(ctrl.getSelectedIndex()).toBe(1);
    ctrl.handleKey("ArrowRight");
    expect(ctrl.getSelectedIndex()).toBe(0);
    ctrl.dispose();
  });
});

describe("accessibility – reduced motion", () => {
  it("implements reduced-motion preference with cleanup", () => {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const query = {
      matches: false,
      addEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      }),
    } as unknown as MediaQueryLike & {
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };
    const onChange = vi.fn();
    const ctrl = createReducedMotionController(query, onChange);
    expect(ctrl.getPrefersReducedMotion()).toBe(false);
    const handler = (
      query.addEventListener as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[1] as (e: unknown) => void;
    handler({ matches: true });
    expect(ctrl.getPrefersReducedMotion()).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
    ctrl.dispose();
    expect(query.removeEventListener).toHaveBeenCalled();
    handler({ matches: false });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("isolates reduced-motion instances", () => {
    const makeQuery = (matches: boolean) =>
      ({
        matches,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryLike;
    const q1 = makeQuery(true);
    const q2 = makeQuery(false);
    const c1 = createReducedMotionController(q1);
    const c2 = createReducedMotionController(q2);
    expect(c1.getPrefersReducedMotion()).toBe(true);
    expect(c2.getPrefersReducedMotion()).toBe(false);
    c1.dispose();
    c2.dispose();
  });

  it("supports legacy addListener/removeListener", () => {
    const query = {
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as MediaQueryLike;
    const ctrl = createReducedMotionController(query);
    expect(query.addListener).toHaveBeenCalled();
    ctrl.dispose();
    expect(query.removeListener).toHaveBeenCalled();
  });
});

describe("accessibility – live status coalescing and leak-free cleanup", () => {
  it("coalesces multiple announce calls and clears timer on dispose", async () => {
    vi.useFakeTimers();
    const el = fakeLiveElement();
    const ctrl = createLiveStatus(el, { coalesceMs: 50 });
    ctrl.announce("first");
    ctrl.announce("second");
    ctrl.announce("final");
    expect(el.textContent).not.toBe("final");
    vi.advanceTimersByTime(60);
    expect(el.textContent).toBe("final");
    ctrl.announce("again");
    ctrl.dispose();
    vi.advanceTimersByTime(60);
    ctrl.announce("after dispose");
    vi.advanceTimersByTime(60);
    expect(el.textContent).toBe("final");
    vi.useRealTimers();
  });

  it("disposes without leaking timers", () => {
    vi.useFakeTimers();
    const el = fakeLiveElement();
    const ctrl = createLiveStatus(el, { coalesceMs: 100 });
    ctrl.announce("msg");
    ctrl.dispose();
    const before = el.textContent;
    vi.advanceTimersByTime(200);
    expect(el.textContent).toBe(before);
    vi.useRealTimers();
  });

  it("restores previous aria attributes on dispose", () => {
    const el = fakeLiveElement();
    el.setAttribute("aria-live", "assertive");
    const ctrl = createLiveStatus(el);
    expect(el.getAttribute("aria-live")).toBe("assertive");
    // new element gets default polite if not present, but existing assertive preserved
    const el2 = fakeLiveElement();
    const ctrl2 = createLiveStatus(el2);
    expect(el2.getAttribute("aria-live")).toBe("polite");
    ctrl.dispose();
    ctrl2.dispose();
    expect(el2.hasAttribute("role")).toBe(false);
  });
});

describe("accessibility – attachRovingListeners cleanup", () => {
  it("attaches and removes keydown listener without leak", () => {
    const container = fakeContainer();
    const a = fakeElement();
    const b = fakeElement();
    a.tabIndex = 0;
    b.tabIndex = -1;
    const onSelect = vi.fn();
    const handle = attachRovingListeners(
      container as unknown as EventTargetLike,
      () => [a, b],
      onSelect,
    );
    // dispatch ArrowRight -> should move from a (index 0) to b (index 1)
    container.dispatch({
      type: "keydown",
      key: "ArrowRight",
      preventDefault: vi.fn(),
    });
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(b.tabIndex).toBe(0);
    handle.dispose();
    onSelect.mockClear();
    container.dispatch({
      type: "keydown",
      key: "ArrowRight",
      preventDefault: vi.fn(),
    });
    expect(onSelect).not.toHaveBeenCalled();
    // dispose idempotent
    handle.dispose();
  });

  it("activates selection on Enter/Space without changing index", () => {
    const container = fakeContainer();
    const a = fakeElement();
    a.tabIndex = 0;
    const onSelect = vi.fn();
    const handle = attachRovingListeners(
      container as unknown as EventTargetLike,
      () => [a],
      onSelect,
    );
    container.dispatch({
      type: "keydown",
      key: "Enter",
      preventDefault: vi.fn(),
    });
    expect(onSelect).toHaveBeenCalledWith(0);
    handle.dispose();
  });
});

// Import type for MediaQueryLike used in test
import type { MediaQueryLike } from "./accessibility.js";
