import { describe, it, expect } from "vitest";
import { buildTriggerPayload } from "../../src/utils/build-payload.js";

describe("buildTriggerPayload", () => {
  it("submits a string value as a single field", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ FOO: "bar" }, false);
    expect(formData.getAll("FOO")).toEqual(["bar"]);
    expect(jsonParameters).toEqual([{ name: "FOO", value: "bar" }]);
  });

  it("does NOT split commas in a string value by default", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ DESC: "hello, world" }, false);
    expect(formData.getAll("DESC")).toEqual(["hello, world"]);
    expect(jsonParameters).toEqual([{ name: "DESC", value: "hello, world" }]);
  });

  it("submits a string array as multiple fields", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ TAGS: ["a", "b", "c"] }, false);
    expect(formData.getAll("TAGS")).toEqual(["a", "b", "c"]);
    expect(jsonParameters).toEqual([{ name: "TAGS", value: ["a", "b", "c"] }]);
  });

  it("legacy splitOnComma=true splits a comma-bearing string", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ TAGS: "a,b,c" }, true);
    expect(formData.getAll("TAGS")).toEqual(["a", "b", "c"]);
    expect(jsonParameters).toEqual([{ name: "TAGS", value: ["a", "b", "c"] }]);
  });

  it("legacy splitOnComma=true does not split a string without comma", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ FOO: "bar" }, true);
    expect(formData.getAll("FOO")).toEqual(["bar"]);
    expect(jsonParameters).toEqual([{ name: "FOO", value: "bar" }]);
  });

  it("returns empty payload for no parameters", () => {
    const { formData, jsonParameters } = buildTriggerPayload({}, false);
    expect([...formData.entries()]).toEqual([]);
    expect(jsonParameters).toEqual([]);
  });
});
