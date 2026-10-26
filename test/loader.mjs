// Resolve the two Harness packages the Host half imports to the local stubs.
// Only the smoke test registers this loader; production code imports the real
// packages from the Harness installation.
export async function resolve(specifier, context, next) {
  if (specifier === "@deepseek-ai/dsh-tools") {
    return { url: new URL("./stubs/dsh-tools.mjs", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "@deepseek-ai/schemastery") {
    return { url: new URL("./stubs/schemastery.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
