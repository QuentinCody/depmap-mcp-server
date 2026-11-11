/// <reference types="node" />
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LICENSE_PROFILE_META_KEY } from "@bio-mcp/shared";
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { MyMCP } from "../index";
import { depmapCatalog } from "../spec/catalog";
import { fixture } from "../tools/bulk.test-support";
import { createDepMapApiFetch } from "./api-adapter";
import { COMMERCIAL_ROUTES, commercialHandleRefusal, commercialRouteRefusal, isCommercialRoute } from "./commercial-profile";

// License audit 2026-11-10: "Allow only the files that permit commercial use."
// Read on 2026-11-10: the DepMap portal terms do not permit commercial use now
// (DepMap staff, forum.depmap.org/t/4652 and /t/4686). CC BY 4.0 is confirmed
// only for the figshare deposits to 24Q4, and no route reads those. Thus a
// reselling caller gets no portal route and no imported release file.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const REFUSED = { error: "NOT_LICENSED_FOR_COMMERCIAL_USE" };

describe("DepMap adapter under the commercial license profile", () => {
	// Each route of the catalog, with a value for each path parameter.
	const ROUTES: Record<string, string> = {
		"/no-captcha/download/files": "/no-captcha/download/files",
		"/genes": "/genes",
		"/cell_lines": "/cell_lines",
		"/proteins": "/proteins",
		"/gene_expression/by_gene/{ensembl_gene}": "/gene_expression/by_gene/ENSG00000141510",
		"/gene_expression/by_cell_line/{depmap_id}": "/gene_expression/by_cell_line/ACH-000001",
		"/gene_dependency/by_gene/{entrez_gene_id}": "/gene_dependency/by_gene/7157",
		"/gene_dependency/by_cell_line/{depmap_id}": "/gene_dependency/by_cell_line/ACH-000001",
		"/copy_number/by_gene/{entrez_gene_id}": "/copy_number/by_gene/7157",
		"/copy_number/by_cell_line/{depmap_id}": "/copy_number/by_cell_line/ACH-000001",
		"/rnai/by_gene/{entrez_gene_id}": "/rnai/by_gene/7157",
		"/rnai/by_cell_line/{depmap_id}": "/rnai/by_cell_line/ACH-000001",
		"/mutations/by_gene/{entrez_gene_id}": "/mutations/by_gene/7157",
		"/mutations/by_cell_line/{depmap_id}": "/mutations/by_cell_line/ACH-000001",
		"/protein_array/by_protein/{antibody_name}": "/protein_array/by_protein/Akt_pS473",
		"/protein_array/by_cell_line/{depmap_id}": "/protein_array/by_cell_line/ACH-000001",
	};

	function upstream() {
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			calls.push(String(input));
			return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
		};
		return { calls, api: createDepMapApiFetch({ fetch: fetchImpl }) };
	}

	it("covers each route of the catalog", () => {
		expect(Object.keys(ROUTES).sort()).toEqual(depmapCatalog.endpoints.map((endpoint) => endpoint.path).sort());
	});

	it("refuses each route of the catalog with HTTP 451 and makes no upstream request", async () => {
		const { calls, api } = upstream();
		for (const path of Object.values(ROUTES)) {
			const result = await api({ method: "GET", path, licenseProfile: "commercial" });
			expect(result.status, path).toBe(451);
			expect(result.data).toMatchObject(REFUSED);
			expect(JSON.stringify(result.data)).toContain(path);
		}
		expect(calls).toEqual([]);
	});

	it("fails closed for an unknown route and for another spelling of a route", async () => {
		const { calls, api } = upstream();
		const requests = [
			{ method: "GET", path: "/download/files" },
			{ method: "GET", path: "/context_explorer/context_info" },
			{ method: "GET", path: "/genes/" },
			{ method: "GET", path: "/GENES" },
			{ method: "GET", path: "/genes?limit=1" },
			{ method: "GET", path: "/no-captcha/download/files", params: { release: "DepMap Public fixture" } },
			{ method: "GET", path: "/" },
			{ method: "GET", path: "" },
			{ method: "POST", path: "/genes", body: {} },
		];
		for (const request of requests) {
			const result = await api({ ...request, licenseProfile: "commercial" });
			expect(result.status, JSON.stringify(request)).toBe(451);
			expect(result.data).toMatchObject(REFUSED);
		}
		expect(calls).toEqual([]);
	});

	it("has an empty allowlist: no route is confirmed for commercial use", () => {
		expect(COMMERCIAL_ROUTES).toEqual([]);
		for (const path of Object.values(ROUTES)) {
			expect(isCommercialRoute(path), path).toBe(false);
			expect(commercialRouteRefusal(path)).toMatchObject({ status: 451, data: REFUSED });
		}
	});

	it("does not change a caller without the commercial profile", async () => {
		const { calls, api } = upstream();
		for (const path of Object.values(ROUTES).filter((route) => route !== "/no-captcha/download/files")) {
			expect((await api({ method: "GET", path })).status, path).toBe(200);
		}
		expect(calls).toHaveLength(15);
		expect(calls[0]).toBe("https://depmap.org/portal/api/genes");
		expect(calls).toContain("https://depmap.org/portal/api/gene_dependency/by_gene/7157");
		await expect(api({ method: "POST", path: "/genes" })).rejects.toThrow(/read-only/);

		const csv = "release,release_date,filename,md5_hash\nDepMap Public fixture,fixture-date,Model.csv,00000000000000000000000000000001\n";
		const inventory = createDepMapApiFetch({ fetch: async () => new Response(csv, { headers: { "content-type": "text/csv" } }) });
		const result = await inventory({ method: "GET", path: "/no-captcha/download/files" });
		expect(result).toMatchObject({ status: 200, data: { inventory_file_count: 1, releases: ["DepMap Public fixture"] } });
	});
});

describe("DepMap stored release files under the commercial license profile", () => {
	const COMMERCIAL = { [LICENSE_PROFILE_META_KEY]: "commercial" };
	const hash = (algorithm: string, bytes: string | Uint8Array) => createHash(algorithm).update(bytes).digest("hex");
	const SQL = "SELECT cells_json FROM depmap_rows ORDER BY record_index";
	const CELLS = [{ cells_json: '["ACH-000001","-0.5"]' }, { cells_json: '["ACH-000002","0.1"]' }];

	/** A server with one published snapshot. `upstream` and `opened` count the accesses after the import. */
	async function published() {
		const f = fixture();
		const raw = Buffer.from("ModelID,TP53 (7157)\nACH-000001,-0.5\nACH-000002,0.1\n");
		const csv = `release,release_date,filename,md5_hash\nDepMap Public fixture,fixture-date,CRISPRGeneEffect.csv,${hash("md5", raw)}\n`;
		const upstream = vi.fn(async (_input: unknown) => new Response(csv, { headers: { "content-type": "text/csv" } }));
		vi.stubGlobal("fetch", upstream);
		const rpc = async (name: string, args: unknown, meta: Record<string, unknown> = {}) => {
			const headers = { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-method": "tools/call", "mcp-name": name, "mcp-protocol-version": "2026-07-28", authorization: "Bearer fixture-admin" };
			const _meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "depmap-fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {}, ...meta };
			const request = new Request("http://fixture/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta } }) });
			const response = await MyMCP.serve("/mcp").fetch(request, f.env as never, { waitUntil() {} } as never);
			const wire = await response.text();
			expect(response.status, wire).toBe(200);
			return JSON.parse(wire).result;
		};
		const admin = async (args: Record<string, unknown>) => {
			const result = await rpc("depmap_load_release", args);
			expect(result.isError, JSON.stringify(result)).not.toBe(true);
			return result.structuredContent.data;
		};
		const selection = { cohort: "adult", version: "DepMap Public fixture", expected_metadata_sha256: hash("sha256", csv), files: [{ release: "DepMap Public fixture", filename: "CRISPRGeneEffect.csv", md5: hash("md5", raw), bytes: raw.length, role: "crispr", index_column: 1, index_type: "ModelID" }] };
		const { data_access_id: id } = await admin({ action: "begin", request_id: "11111111-1111-4111-8111-000000000001", selection });
		await admin({ action: "append", data_access_id: id, file_index: 0, chunk_index: 0, data_base64: raw.toString("base64") });
		await admin({ action: "verify", data_access_id: id, file_index: 0 });
		await admin({ action: "publish", data_access_id: id });
		upstream.mockClear();
		const opened = vi.spyOn(f.env.DEPMAP_DATA_DO, "get");
		return { ...f, rpc, upstream, opened, id: String(id) };
	}

	/** A program that reports the result or the error of each access. */
	const program = (id: string) => `
		const out = {};
		const attempts = {
			query: () => api.query(${JSON.stringify(id)}, ${JSON.stringify(SQL)}),
			queryStaged: () => db.queryStaged(${JSON.stringify(id)}, ${JSON.stringify(SQL)}),
			route: () => api.get("/gene_dependency/by_gene/7157"),
		};
		for (const name of Object.keys(attempts)) {
			try { out[name] = await attempts[name](); } catch (error) { out[name] = "ERROR " + error.message; }
		}
		return out;`;

	it("classifies the stores of release files, and no other handle", () => {
		const stores = ["adult:current", "pediatric:current", "depmap_bulk_adult_11111111-1111-4111-8111-000000000001", "depmap_bulk_pediatric_x", "release:adult:current", "release:pediatric:current", " Adult:Current ", "RELEASE:adult:current", ["adult:current"]];
		for (const id of stores) expect(commercialHandleRefusal(id), String(id)).toMatchObject({ status: 451, data: REFUSED });
		const ordinary = ["depmap_1731240000000_0123456789abcdef0123456789abcdef", "depmap_harmonize_1731240000000_0123456789abcdef0123456789abcdef", "chat-1:__registry__", "adult:currently", "", undefined, null];
		for (const id of ordinary) expect(commercialHandleRefusal(id), String(id)).toBeUndefined();
	});

	it("refuses SQL and schema on each store of release files and opens no store", async () => {
		const f = await published();
		try {
			for (const prefix of ["", "mcp_"]) for (const id of ["adult:current", f.id, "release:adult:current"]) {
				const calls = [
					[`${prefix}depmap_query_data`, { data_access_id: id, sql: SQL }],
					[`${prefix}depmap_get_schema`, { data_access_id: id }],
				] as const;
				for (const [tool, args] of calls) {
					const result = await f.rpc(tool, args, COMMERCIAL);
					expect(result.isError, `${tool} ${id}`).toBe(true);
					expect(result.structuredContent).toMatchObject({ success: false, error: { code: "NOT_LICENSED_FOR_COMMERCIAL_USE", details: { status: 451 } } });
					expect(JSON.stringify(result)).not.toContain("ACH-000001");
				}
			}
			expect(f.opened).not.toHaveBeenCalled();
			expect(f.upstream).not.toHaveBeenCalled();
		} finally { f.close(); }
	});

	it("refuses the same stores and each route inside depmap_execute", async () => {
		const f = await published();
		try {
			for (const prefix of ["", "mcp_"]) for (const id of [f.id, "release:adult:current"]) {
				const result = await f.rpc(`${prefix}depmap_execute`, { code: program(id) }, COMMERCIAL);
				const out = result.structuredContent.data;
				for (const name of ["query", "queryStaged", "route"]) {
					expect(out[name], `${name} ${id}`).toContain("NOT_LICENSED_FOR_COMMERCIAL_USE");
				}
				expect(out.route).toContain("451");
				expect(JSON.stringify(result)).not.toContain("ACH-000001");
			}
			expect(f.opened).not.toHaveBeenCalled();
			expect(f.upstream).not.toHaveBeenCalled();
		} finally { f.close(); }
	});

	it("serves a commercial caller what holds no release file", async () => {
		const f = await published();
		try {
			// Its own staged data, by the tool and inside the isolate.
			const staged = await f.rpc("depmap_execute", { code: 'return await db.stage([{ gene: "TP53", score: 1 }], "scores");' }, COMMERCIAL);
			expect(staged.isError, JSON.stringify(staged)).not.toBe(true);
			const handle = staged.structuredContent.data.data_access_id;
			expect(handle).toMatch(/^depmap_\d+_[a-f0-9]{32}$/);
			const rows = await f.rpc("depmap_query_data", { data_access_id: handle, sql: "SELECT gene, score FROM scores" }, COMMERCIAL);
			expect(rows.structuredContent.data.rows).toEqual([{ gene: "TP53", score: 1 }]);
			const schema = await f.rpc("depmap_get_schema", { data_access_id: handle }, COMMERCIAL);
			expect(schema.isError).not.toBe(true);
			expect(JSON.stringify(schema)).toContain("scores");
			const inside = await f.rpc("depmap_execute", { code: `return await api.query(${JSON.stringify(handle)}, "SELECT gene FROM scores");` }, COMMERCIAL);
			expect(inside.structuredContent.data.results).toEqual([{ gene: "TP53" }]);
			// The catalog and the import status hold no DepMap data.
			const search = await f.rpc("depmap_search", { query: "dependency" }, COMMERCIAL);
			expect(search.isError).not.toBe(true);
			const status = await f.rpc("depmap_release_status", { cohort: "adult" }, COMMERCIAL);
			expect(status.structuredContent.data.cohorts.adult.currentVersion).toBe("DepMap Public fixture");
		} finally { f.close(); }
	});

	it("does not change a caller without the commercial profile", async () => {
		const f = await published();
		try {
			for (const meta of [{}, { [LICENSE_PROFILE_META_KEY]: "research" }]) {
				for (const id of ["adult:current", f.id]) {
					const query = await f.rpc("depmap_query_data", { data_access_id: id, sql: SQL }, meta);
					expect(query.isError, JSON.stringify(query)).not.toBe(true);
					expect(query.structuredContent.data.rows).toEqual(CELLS);
					const schema = await f.rpc("depmap_get_schema", { data_access_id: id }, meta);
					expect(schema.isError).not.toBe(true);
					expect(JSON.stringify(schema)).toContain("depmap_rows");
				}
				const result = await f.rpc("depmap_execute", { code: program(f.id) }, meta);
				const out = result.structuredContent.data;
				expect(out.query.results).toEqual(CELLS);
				expect(out.queryStaged.results).toEqual(CELLS);
				expect(String(out.route)).not.toContain("NOT_LICENSED_FOR_COMMERCIAL_USE");
			}
			expect(f.upstream.mock.calls.map(([input]) => String(input))).toEqual(Array(2).fill("https://depmap.org/portal/api/gene_dependency/by_gene/7157"));
			expect(f.opened).toHaveBeenCalled();
		} finally { f.close(); }
	}, 30000);
});
