// Stub the `ai` module that the MCP SDK imports transitively. We don't
// need any of its functionality, but Wrangler's esbuild needs SOMETHING
// to alias to. See the matching "alias" entry in wrangler.jsonc.
export function jsonSchema() {
    return {};
}
