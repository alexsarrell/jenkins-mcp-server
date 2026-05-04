export interface JsonParameter {
  name: string;
  value: string | string[];
}

export interface TriggerPayload {
  formData: URLSearchParams;
  jsonParameters: JsonParameter[];
}

export type ParameterValue = string | string[];

export function buildTriggerPayload(
  parameters: Record<string, ParameterValue>,
  splitOnComma: boolean,
): TriggerPayload {
  const formData = new URLSearchParams();
  const jsonParameters: JsonParameter[] = [];

  for (const [name, raw] of Object.entries(parameters)) {
    const values: string[] = Array.isArray(raw)
      ? raw
      : splitOnComma && raw.includes(",")
      ? raw.split(",").map((v) => v.trim())
      : [raw];

    for (const v of values) {
      formData.append(name, v);
    }
    jsonParameters.push({
      name,
      value: values.length === 1 ? values[0] : values,
    });
  }

  return { formData, jsonParameters };
}
