/**
 * Capability-compiled model policy deep module.
 *
 * Public seam: compileModelPolicy(input) → CompiledModelPolicyV1
 * Adapters: deriveModelFacts + ordinary/workflow task/session builders.
 * Plus versioned input/output types, deterministic receipt fingerprints,
 * on-demand provider opaque-state capture, and pure completion evaluation.
 */

export * from "./adapters";
export * from "./compiler";
export * from "./completion";
export * from "./provider-state";
export * from "./receipt";
export * from "./types";
