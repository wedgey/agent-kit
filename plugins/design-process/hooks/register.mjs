import { register as registerCompact } from "./compact-mod.mjs";
import { register as registerAnswerWatch } from "./answer-watch-mod.mjs";

/** @type {import('claude-code').Register} */
export const register = (on) => {
  registerCompact(on);
  registerAnswerWatch(on);
};
