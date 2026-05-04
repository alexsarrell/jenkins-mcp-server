import { z } from "zod";

export const parameterSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("string"),
    name: z.string(),
    default: z.string().optional(),
    description: z.string().optional(),
    trim: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("text"),
    name: z.string(),
    default: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("boolean"),
    name: z.string(),
    default: z.boolean().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("choice"),
    name: z.string(),
    choices: z.array(z.string()).min(1),
    default: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("password"),
    name: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("file"),
    name: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("run"),
    name: z.string(),
    projectName: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("credentials"),
    name: z.string(),
    credentialType: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("unknown"),
    name: z.string(),
    rawType: z.string(),
    description: z.string().optional(),
  }),
]);

export type ParameterSpec = z.infer<typeof parameterSpec>;
