import type { Recipe } from "../recipe.js";
import { CliError } from "../errors.js";
import { actorsAnswer, smokeAnswers, type OnboardingState } from "./state.js";

export const SMOKE_RECIPE_NAME = "login-ready";

/**
 * The first recipe of every project: log in as the main actor (triggered by ensureContext, i.e.
 * by config.login), apply storageReset, land on a stable page and wait for a known element.
 * Passing it proves login selectors, auth, storageReset and the landing page are all right.
 */
export function buildSmokeRecipe(state: OnboardingState): Recipe {
  const smoke = smokeAnswers(state);
  const actors = actorsAnswer(state);
  if (!smoke) throw new CliError("E_ONBOARDING_INCOMPLETE", "smoke.landingPath and smoke.verify are required to build the login-ready recipe");
  if (!actors.length) throw new CliError("E_ONBOARDING_INCOMPLETE", "at least one actor is required to build the login-ready recipe");
  const main = actors[0];
  const verify = smoke.verify;
  return {
    name: SMOKE_RECIPE_NAME,
    description: `煙霧 recipe：以 ${main.role} 登入、清除 storageReset 指定的本機狀態、停在 ${smoke.landingPath}。用來驗證 config 的登入 selector、auth、storageReset 與落地頁都正確；所有其他 recipe 都建立在同一組設定上。`,
    createdAt: new Date().toISOString(),
    targetUrl: smoke.landingPath,
    steps: [
      { id: "open-landing", actor: main.role, kind: "ui", action: { type: "navigate", url: smoke.landingPath }, note: "登入由 ensureContext 依 config.login 觸發，不寫成步驟。" },
      {
        id: "wait-landing",
        actor: main.role,
        kind: "ui",
        action: { type: "waitFor", selector: verify.selector, text: verify.text, timeoutMs: 20000 },
        note: "落地頁的關鍵元素出現代表登入與導航都成功。",
      },
    ],
    finalNavigation: smoke.landingPath,
    finalContext: main.contextName ?? main.role,
    targetHint: { url: smoke.landingPath, note: "煙霧 recipe 沒有下一跳；它只驗證登入、storageReset 與落地頁。" },
    verify: { selectors: verify.selector ? [verify.selector] : [], textIncludes: verify.text ? [verify.text] : [] },
    draft: false,
  };
}
