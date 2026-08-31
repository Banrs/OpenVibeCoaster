import rawProfile from "../../../../data/profiles/engineering-limits-v1.json";
import {
  validateEngineeringLimitsProfile,
  type EngineeringLimitsProfile,
} from "@openvibecoaster/core";

validateEngineeringLimitsProfile(rawProfile);

export const engineeringLimitsProfile: EngineeringLimitsProfile =
  rawProfile as EngineeringLimitsProfile;

export default engineeringLimitsProfile;
