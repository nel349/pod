import { createContext } from "react";
import { STEPS, type StepOrder } from "../state/index.ts";

/** Which order the sheets on this page come in, so each is stamped with its own number in it. */
export const StepOrderContext = createContext<StepOrder>(STEPS);
