export function createExactSampleCache<T>(sample: (distanceM: number) => T): {
  sample: (distanceM: number) => T;
  clear: () => void;
} {
  const cache = new Map<number, T>();
  return {
    sample(distanceM: number): T {
      if (cache.has(distanceM)) return cache.get(distanceM)!;
      const result = sample(distanceM);
      cache.set(distanceM, result);
      return result;
    },
    clear(): void {
      cache.clear();
    },
  };
}
