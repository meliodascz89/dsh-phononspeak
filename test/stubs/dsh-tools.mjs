// Minimal stand-in for @deepseek-ai/dsh-tools so the Host half can be loaded in
// plain Node. The real package only adds presentation metadata; the plugin's
// behaviour lives in the definition it returns, which is what the smoke test
// exercises.
export function defineTool(definition) {
  return definition;
}
