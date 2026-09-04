import { expect, test } from "vitest";
import { compileSemanticChain } from "./solver.js";
import { createElement } from "./elements.js";

const compiledLocalHeight = (height?: number): number => {
  const element = createElement("topHat", "topHat-height", {
    width: 60,
    bank: 0,
    ...(height === undefined ? {} : { height }),
  });
  const compiled = compileSemanticChain([element]);
  expect(compiled.feasible).toBe(true);
  const positions = compiled.track!.positions;
  let low = Infinity;
  let high = -Infinity;
  for (let index = 1; index < positions.length; index += 3) {
    low = Math.min(low, positions[index]!);
    high = Math.max(high, positions[index]!);
  }
  return high - low;
};

test("the default topHat compiles an 80 m local height delta", () => {
  expect(compiledLocalHeight()).toBeCloseTo(80, 0);
});

test("a 91 m topHat compiles a 91 m local height delta", () => {
  expect(compiledLocalHeight(91)).toBeCloseTo(91, 0);
});
