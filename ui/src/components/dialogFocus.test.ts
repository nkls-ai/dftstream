import { test, expect } from "bun:test";
import { focusableIn } from "./DialogShell";

/**
 * The dialog is aria-modal but the page behind it keeps its tab order, so Tab
 * walked out of a "Delete run?" confirm and onto the runs table underneath.
 * The trap needs the card's real tab-order members; anything disabled or
 * tabindex="-1" must be skipped, or focus lands somewhere the browser would
 * never have put it and the wrap-around silently breaks.
 *
 * There is no DOM in this runner, so the element tree is stubbed at the one
 * API focusableIn uses.
 */
type Stub = { disabled?: boolean; tabindex?: string };

function root(children: Stub[]) {
  const els = children.map((c) => ({
    hasAttribute: (name: string) => name === "disabled" && c.disabled === true,
    getAttribute: (name: string) => (name === "tabindex" ? c.tabindex ?? null : null),
    stub: c,
  }));
  return { querySelectorAll: () => els } as unknown as HTMLElement;
}

test("keeps enabled, tabbable elements in document order", () => {
  const a: Stub = {};
  const b: Stub = {};
  const found = focusableIn(root([a, b]));
  expect(found).toHaveLength(2);
  expect((found[0] as unknown as { stub: Stub }).stub).toBe(a);
  expect((found[1] as unknown as { stub: Stub }).stub).toBe(b);
});

test("skips disabled controls", () => {
  // A disabled confirm button as the last child would otherwise become the
  // trap's wrap-around target and swallow Shift+Tab.
  expect(focusableIn(root([{}, { disabled: true }]))).toHaveLength(1);
});

test('skips tabindex="-1"', () => {
  expect(focusableIn(root([{}, { tabindex: "-1" }]))).toHaveLength(1);
  expect(focusableIn(root([{ tabindex: "0" }]))).toHaveLength(1);
});

test("a null root yields nothing rather than throwing", () => {
  // The keydown listener runs before the card ref is attached on the very
  // first frame; returning [] makes that a no-op instead of a crash.
  expect(focusableIn(null)).toEqual([]);
});
