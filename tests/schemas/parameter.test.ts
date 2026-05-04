import { describe, it, expect } from "vitest";
import { parameterSpec } from "../../src/schemas/parameter.js";

describe("parameterSpec", () => {
  it("accepts a string parameter", () => {
    const out = parameterSpec.parse({ type: "string", name: "FOO", default: "bar" });
    expect(out).toMatchObject({ type: "string", name: "FOO", default: "bar" });
  });

  it("accepts a choice parameter with choices", () => {
    const out = parameterSpec.parse({
      type: "choice",
      name: "ENV",
      choices: ["dev", "stage", "prod"],
    });
    expect(out.type === "choice" && out.choices).toEqual(["dev", "stage", "prod"]);
  });

  it("accepts a boolean parameter", () => {
    expect(() => parameterSpec.parse({ type: "boolean", name: "DRY_RUN", default: true })).not.toThrow();
  });

  it("accepts password without default exposure", () => {
    expect(() => parameterSpec.parse({ type: "password", name: "TOKEN" })).not.toThrow();
  });

  it("accepts unknown branch with rawType", () => {
    const out = parameterSpec.parse({ type: "unknown", name: "X", rawType: "ExtendedChoiceParameterDefinition" });
    expect(out).toMatchObject({ type: "unknown", rawType: "ExtendedChoiceParameterDefinition" });
  });

  it("rejects choice without choices", () => {
    expect(() => parameterSpec.parse({ type: "choice", name: "ENV" })).toThrow();
  });
});
