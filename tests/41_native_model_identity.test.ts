import { expect, test } from "bun:test";
import { nativeComposerModelMatches41, type NativeComposerModelIdentity41 } from "../src/adapters/chatgpt-web/41_native_model_identity";

const instant: NativeComposerModelIdentity41 = {
  slug: "gpt-6",
  thinkingEffort: null,
  versionId: "6",
  catalogTitle: "GPT-6",
  workMode: false,
  premiumFallbackModelSlug: null,
};

test("explicit GPT-6 Instant identity is exact for the low request", () => {
  expect(nativeComposerModelMatches41(instant, "6", "low")).toBeTrue();
  expect(nativeComposerModelMatches41({ ...instant, versionId: "latest" }, "6", "low")).toBeTrue();
});

test("native identity rejects another family, work mode, fallback, or effort", () => {
  expect(nativeComposerModelMatches41({ ...instant, catalogTitle: "GPT-5.6 Sol" }, "6", "low")).toBeFalse();
  expect(nativeComposerModelMatches41({ ...instant, workMode: true }, "6", "low")).toBeFalse();
  expect(nativeComposerModelMatches41({ ...instant, premiumFallbackModelSlug: "gpt-6" }, "6", "low")).toBeFalse();
  expect(nativeComposerModelMatches41({ ...instant, thinkingEffort: "standard" }, "6", "low")).toBeFalse();
  expect(nativeComposerModelMatches41({ ...instant, versionId: "5.6" }, "6", "low")).toBeFalse();
  expect(nativeComposerModelMatches41(instant, "5.6", "low")).toBeFalse();
});
