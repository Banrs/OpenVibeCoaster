import type { RidePlaybackSnapshot } from "../ride/controller.js";

export const SEAT_OPTIONS = [
  { value: "0", seatId: "front" as const, seatIndex: 0 },
  { value: "1", seatId: "middle" as const, seatIndex: 0 },
  { value: "2", seatId: "middle" as const, seatIndex: 1 },
  { value: "3", seatId: "rear" as const, seatIndex: 0 },
] as const;

export function getSeatOptionByValue(value: string) {
  return SEAT_OPTIONS.find((o) => o.value === value);
}

export function getSeatValueFromSnapshot(snap: RidePlaybackSnapshot): string {
  const sel = snap.selectedSeat;
  const idx = snap.selections[sel]?.seatIndex ?? 0;
  const found = SEAT_OPTIONS.find(
    (o) => o.seatId === sel && o.seatIndex === idx,
  );
  return found?.value ?? "0";
}

export const ALLOWED_RATES = [0.25, 0.5, 1, 2] as const;
export type AllowedRate = (typeof ALLOWED_RATES)[number];

export function isAllowedRate(value: number): value is AllowedRate {
  return (ALLOWED_RATES as readonly number[]).includes(value);
}
