import { describe, it, expect } from "vitest";
import { RideTimeline } from "@openvibecoaster/simulator";
import { createRidePlayback } from "../ride/controller.js";
import {
  ALLOWED_RATES,
  SEAT_OPTIONS,
  getSeatOptionByValue,
  getSeatValueFromSnapshot,
  isAllowedRate,
} from "./playbackOptions.js";

function makeTimeline(): RideTimeline {
  return new RideTimeline({
    sampleRateHz: 10,
    timeSeconds: new Float64Array([0, 1]),
    headDistanceM: new Float64Array([0, 10]),
    speedMps: new Float64Array([5, 5]),
    longitudinalG: new Float64Array([0, 0]),
    lateralG: new Float64Array([0, 0]),
    verticalG: new Float64Array([1, 1]),
    jerkMps3: new Float64Array([0, 0, 0, 0, 0, 0]),
    frames: [],
    carCount: 3,
    carPositionsXYZ: new Float64Array(18).fill(0),
    carTangentsXYZ: new Float64Array([
      1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
    ]),
    carNormalsXYZ: new Float64Array([
      0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]),
    carBinormalsXYZ: new Float64Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]),
  });
}

describe("playbackOptions helpers", () => {
  it("isAllowedRate rejects 0.75 and accepts discrete rates", () => {
    expect(isAllowedRate(0.75)).toBe(false);
    expect(isAllowedRate(0.3)).toBe(false);
    for (const rate of ALLOWED_RATES) {
      expect(isAllowedRate(rate)).toBe(true);
    }
  });

  it("SEAT_OPTIONS has four entries front/0, middle/0, middle/1, rear/0", () => {
    expect(SEAT_OPTIONS).toHaveLength(4);
    expect(SEAT_OPTIONS[0]).toEqual({
      value: "0",
      seatId: "front",
      seatIndex: 0,
    });
    expect(SEAT_OPTIONS[1]).toEqual({
      value: "1",
      seatId: "middle",
      seatIndex: 0,
    });
    expect(SEAT_OPTIONS[2]).toEqual({
      value: "2",
      seatId: "middle",
      seatIndex: 1,
    });
    expect(SEAT_OPTIONS[3]).toEqual({
      value: "3",
      seatId: "rear",
      seatIndex: 0,
    });
  });

  it("getSeatOptionByValue returns correct mapping and undefined for invalid", () => {
    expect(getSeatOptionByValue("0")?.seatId).toBe("front");
    expect(getSeatOptionByValue("1")?.seatIndex).toBe(0);
    expect(getSeatOptionByValue("2")?.seatIndex).toBe(1);
    expect(getSeatOptionByValue("3")?.seatId).toBe("rear");
    expect(getSeatOptionByValue("99")).toBeUndefined();
    expect(getSeatOptionByValue("invalid")).toBeUndefined();
  });

  it("getSeatValueFromSnapshot round-trips through controller", () => {
    const timeline = makeTimeline();
    const ctrl = createRidePlayback(timeline, {
      rate: 1,
      selectedSeat: "front",
    });
    // front/0
    expect(getSeatValueFromSnapshot(ctrl.getSnapshot())).toBe("0");
    ctrl.selectSeat("middle", 0);
    expect(getSeatValueFromSnapshot(ctrl.getSnapshot())).toBe("1");
    ctrl.selectSeat("middle", 1);
    expect(getSeatValueFromSnapshot(ctrl.getSnapshot())).toBe("2");
    ctrl.selectSeat("rear", 0);
    expect(getSeatValueFromSnapshot(ctrl.getSnapshot())).toBe("3");
    // round-trip via option
    for (const opt of SEAT_OPTIONS) {
      ctrl.selectSeat(opt.seatId, opt.seatIndex);
      expect(getSeatValueFromSnapshot(ctrl.getSnapshot())).toBe(opt.value);
      expect(getSeatOptionByValue(opt.value)).toEqual(opt);
    }
  });
});
