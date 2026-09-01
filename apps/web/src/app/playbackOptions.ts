import type { RidePlaybackSnapshot } from "../ride/controller.js";

export const SEAT_OPTIONS = [
  { value: "front", seatId: "front" as const, seatIndex: 0 },
  { value: "middle", seatId: "middle" as const, seatIndex: 0 },
  { value: "rear", seatId: "rear" as const, seatIndex: 0 },
] as const;

export function getSeatOptionByValue(value: string) {
  return SEAT_OPTIONS.find((o) => o.value === value);
}

export function getSeatValueFromSnapshot(snap: RidePlaybackSnapshot): string {
  return snap.selectedSeat;
}

export const ALLOWED_RATES = [0.25, 0.5, 1, 2] as const;
export type AllowedRate = (typeof ALLOWED_RATES)[number];

export function isAllowedRate(value: number): value is AllowedRate {
  return (ALLOWED_RATES as readonly number[]).includes(value);
}
