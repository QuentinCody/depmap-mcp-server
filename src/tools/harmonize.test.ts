import { expect, it } from "vitest";
import { McpServer } from "@bio-mcp/shared/mcp";
import { registerHarmonize, runHarmonize } from "./harmonize";
import { registerCodeMode } from "./code-mode";
import { registerGetSchema } from "./get-schema";
import { registerQueryData } from "./query-data";

const args = () => ({
  model: { release: "test", filename: "Model.csv", md5_hash: "1".repeat(32), rows: [{ ModelID: "ACH-1" }] },
  datasets: [{ release: "test", filename: "CRISPR.csv", md5_hash: "2".repeat(32), kind: "crispr", index_type: "ModelID", index_column: "ModelID", rows: [{ ModelID: "ACH-1", value: -1 }] }],
});
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
type Handler = (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<{ content: unknown[]; structuredContent: Record<string, any>; isError?: boolean }>;

function registered(namespace?: DurableObjectNamespace) {
  const server = new McpServer({ name: "fixture", version: "1" });
  const env = { DEPMAP_DATA_DO: namespace };
  registerHarmonize(server, env); registerGetSchema(server, env); registerQueryData(server, env);
  registerCodeMode(server, { ...env, CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1]);
  return (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
}

it("registers both names and returns cited, structured results through each harmonization alias", async () => {
  const tools = registered();
  for (const name of ["depmap_search", "depmap_execute", "depmap_query_data", "depmap_get_schema", "depmap_harmonize"]) {
    expect(tools[name]).toBeDefined(); expect(tools[`mcp_${name}`]).toBeDefined();
  }
  for (const name of ["depmap_harmonize", "mcp_depmap_harmonize"]) {
    const result = await tools[name].handler(args(), {});
    expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true, data: { matched_rows: 1 } } });
    expect(result.structuredContent._meta.citation.result_hash).toBeTruthy();
    expect(await tools[name].handler({}, {})).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: { success: false } });
  }
});

it("stages full inputs and join links canonically above 30KB of UTF-8", async () => {
  const input = args(); Object.assign(input.model.rows[0], { note: "α".repeat(17_000) });
  const stored: unknown[] = [];
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      stored.push((await request.json() as { data: unknown }).data);
      return json({ success: true, tables_created: ["links"], total_rows: 1, input_rows: 1, table_row_counts: { links: 1 } });
    }
    return json({ success: true, schema: { tables: { links: { columns: [{ name: "model_id" }] } } } });
  } }) } as unknown as DurableObjectNamespace;
  const result = await registered(namespace).depmap_harmonize.handler(input, {});
  expect(result.structuredContent._staging).toBeDefined();
  expect(result.structuredContent.data).toMatchObject({ staged: true, matched_rows: 1, complete: true });
  const canonical = JSON.parse(stored[0] as string);
  expect(canonical.inputs).toEqual(input);
  expect(canonical.links).toHaveLength(1);
  expect(stored[1]).toEqual(canonical);
  expect(new TextEncoder().encode(JSON.stringify(result.structuredContent)).byteLength).toBeLessThan(100_000);
});

it("returns compact structured errors when a large result cannot stage", async () => {
  const input = args(); Object.assign(input.model.rows[0], { note: "x".repeat(40_000) });
  const result = await runHarmonize(input, {});
  expect(result).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: { success: false } });
  expect(JSON.stringify(result).length).toBeLessThan(3000);
});

it("routes both cohort aliases to the actual singleton while retaining ordinary staging handles", async () => {
  const names: string[] = [];
  const namespace = { idFromName: (name: string) => { names.push(name); return name; }, get: () => ({ fetch: async () => json({ success: true, schema: { tables: { rows: { columns: [{ name: "value" }], row_count: 1 } } }, rows: [{ value: 1 }] }) }) } as unknown as DurableObjectNamespace;
  const tools = registered(namespace);
  for (const id of ["adult:current", "pediatric:current", "depmap_supplied_subset"]) {
    for (const tool of ["depmap_get_schema", "mcp_depmap_query_data"]) await tools[tool].handler({ data_access_id: id, sql: "SELECT value FROM rows" }, {});
  }
  expect(names).toContain("release:adult:current");
  expect(names).toContain("release:pediatric:current");
  expect(names).toContain("depmap_supplied_subset");
  expect(names).not.toContain("adult:current");
});
