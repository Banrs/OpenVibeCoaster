// Accessibility helpers – pure, no module-global mutable state, injected side effects.
// Runtime compatible with native DOM via structural interfaces, testable with minimal fakes.

export type CanvasKeyboardAction =
  "previous" | "next" | "first" | "last" | "none";

export function getCanvasKeyboardAction(key: string): CanvasKeyboardAction {
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return "previous";
    case "ArrowRight":
    case "ArrowUp":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return "none";
  }
}

export function getRovingIndex(
  currentIndex: number,
  key: string,
  count: number,
): number {
  if (!Number.isFinite(currentIndex) || !Number.isFinite(count) || count <= 0)
    return 0;
  const clamped = Math.max(0, Math.min(count - 1, Math.trunc(currentIndex)));
  const action = getCanvasKeyboardAction(key);
  switch (action) {
    case "previous":
      return Math.max(0, clamped - 1);
    case "next":
      return Math.min(count - 1, clamped + 1);
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "none":
    default:
      return clamped;
  }
}

// Minimal structural interfaces for DOM compatibility
export interface RovingElement {
  tabIndex: number;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  focus?: () => void;
}

export interface EventTargetLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface LiveElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
}

export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener?: (type: string, listener: (e: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (e: unknown) => void) => void;
  addListener?: (listener: (e: unknown) => void) => void;
  removeListener?: (listener: (e: unknown) => void) => void;
}

export interface RovingController {
  readonly getSelectedIndex: () => number;
  readonly select: (index: number) => void;
  readonly handleKey: (key: string) => number;
  readonly dispose: () => void;
}

export function createRovingController(
  elements: readonly RovingElement[],
  options: {
    readonly initialIndex?: number;
    readonly onSelect?: (index: number, element: RovingElement) => void;
    readonly wrap?: boolean;
  } = {},
): RovingController {
  const items = [...elements];
  const count = items.length;
  let selected = Math.max(
    0,
    Math.min(count - 1, Math.trunc(options.initialIndex ?? 0)),
  );
  if (count === 0) selected = 0;
  let disposed = false;

  const applyRoving = (nextIndex: number): void => {
    const clamped = Math.max(0, Math.min(count - 1, Math.trunc(nextIndex)));
    selected = clamped;
    for (let i = 0; i < items.length; i += 1) {
      const el = items[i]!;
      el.tabIndex = i === clamped ? 0 : -1;
      el.setAttribute("aria-selected", String(i === clamped));
    }
    if (options.onSelect && !disposed) {
      const el = items[clamped];
      if (el) options.onSelect(clamped, el);
    }
  };

  applyRoving(selected);

  const select = (index: number): void => {
    if (disposed || count === 0) return;
    applyRoving(index);
  };

  const handleKey = (key: string): number => {
    if (disposed || count === 0) return selected;
    const next = getRovingIndex(selected, key, count);
    let wrapped = next;
    if (options.wrap) {
      if (getCanvasKeyboardAction(key) === "previous" && selected === 0)
        wrapped = count - 1;
      if (getCanvasKeyboardAction(key) === "next" && selected === count - 1)
        wrapped = 0;
    }
    if (wrapped !== selected) applyRoving(wrapped);
    return selected;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const el of items) el.removeAttribute("aria-selected");
  };

  return Object.freeze({
    getSelectedIndex: () => selected,
    select,
    handleKey,
    dispose,
  });
}

export function attachRovingListeners(
  container: EventTargetLike,
  getElements: () => readonly RovingElement[],
  onSelect: (index: number) => void,
): { dispose: () => void } {
  // Tracks roving index internally without relying on document.activeElement
  let currentIndex = 0;
  // Initialise currentIndex from elements' tabIndex if possible
  const syncFromElements = (): void => {
    const elements = getElements();
    const active = elements.findIndex((el) => el.tabIndex === 0);
    if (active >= 0) currentIndex = active;
    else if (elements.length > 0) currentIndex = 0;
  };
  syncFromElements();

  const onKeyDown = (event: unknown): void => {
    const e = event as { key: string; preventDefault?: () => void };
    if (typeof e.key !== "string") return;
    const elements = getElements();
    if (elements.length === 0) return;
    const action = getCanvasKeyboardAction(e.key);
    // Handle roving keys and selectable activation
    if (action !== "none") {
      const next = getRovingIndex(currentIndex, e.key, elements.length);
      if (next !== currentIndex) {
        e.preventDefault?.();
        // update tabindex
        for (let i = 0; i < elements.length; i += 1)
          elements[i]!.tabIndex = i === next ? 0 : -1;
        currentIndex = next;
        const nextEl = elements[next];
        nextEl?.focus?.();
        onSelect(next);
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault?.();
      onSelect(currentIndex);
    }
  };

  container.addEventListener("keydown", onKeyDown);
  let disposed = false;
  return Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      container.removeEventListener("keydown", onKeyDown);
    },
  });
}

export interface ReducedMotionController {
  readonly getPrefersReducedMotion: () => boolean;
  readonly dispose: () => void;
}

export function createReducedMotionController(
  query: MediaQueryLike,
  onChange?: (prefersReducedMotion: boolean) => void,
): ReducedMotionController {
  let prefers = Boolean(query.matches);
  let disposed = false;
  const handler = (event: unknown): void => {
    const ev = event as { matches?: boolean };
    const effective =
      typeof ev.matches === "boolean" ? ev.matches : Boolean(query.matches);
    prefers = effective;
    if (!disposed) onChange?.(effective);
  };
  if (query.addEventListener) query.addEventListener("change", handler);
  else if (query.addListener) query.addListener(handler);

  return Object.freeze({
    getPrefersReducedMotion: () => prefers,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (query.removeEventListener)
        query.removeEventListener("change", handler);
      else if (query.removeListener) query.removeListener(handler);
    },
  });
}

export interface LiveStatusController {
  readonly announce: (message: string) => void;
  readonly dispose: () => void;
}

export function createLiveStatus(
  element: LiveElement,
  options: { readonly coalesceMs?: number } = {},
): LiveStatusController {
  const coalesceMs = options.coalesceMs ?? 150;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  let disposed = false;
  const previousRole = element.getAttribute("role");
  const previousLive = element.getAttribute("aria-live");
  const previousAtomic = element.getAttribute("aria-atomic");
  if (!element.hasAttribute("role")) element.setAttribute("role", "status");
  if (!element.hasAttribute("aria-live"))
    element.setAttribute("aria-live", "polite");
  if (!element.hasAttribute("aria-atomic"))
    element.setAttribute("aria-atomic", "true");

  const flush = (): void => {
    if (disposed) return;
    if (pending !== null) {
      element.textContent = "";
      element.textContent = pending;
      pending = null;
    }
    timer = null;
  };

  const announce = (message: string): void => {
    if (disposed) return;
    pending = String(message);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, coalesceMs);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
    if (previousRole === null) element.removeAttribute("role");
    else element.setAttribute("role", previousRole);
    if (previousLive === null) element.removeAttribute("aria-live");
    else element.setAttribute("aria-live", previousLive);
    if (previousAtomic === null) element.removeAttribute("aria-atomic");
    else element.setAttribute("aria-atomic", previousAtomic);
  };

  return Object.freeze({ announce, dispose });
}
