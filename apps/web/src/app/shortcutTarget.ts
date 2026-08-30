export interface ShortcutOwnerTarget {
  tagName: string;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  isContentEditable: boolean;
}

export function isShortcutOwnerElement(
  target: ShortcutOwnerTarget | null,
): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toLowerCase();
  if (
    tag === "input" ||
    tag === "select" ||
    tag === "textarea" ||
    tag === "button"
  ) {
    return true;
  }
  if (tag === "a") {
    if (target.hasAttribute("href")) return true;
    const href = target.getAttribute("href");
    if (href !== null && href !== "") return true;
    return false;
  }
  if (target.isContentEditable) return true;
  const ce = target.getAttribute("contenteditable");
  if (ce !== null && ce !== "false") return true;

  const role = target.getAttribute("role");
  if (role) {
    const r = role.toLowerCase().trim();
    if (r === "button" || r === "slider") return true;
  }
  return false;
}
