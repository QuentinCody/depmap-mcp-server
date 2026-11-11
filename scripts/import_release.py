#!/usr/bin/env python3
"""Upload separately obtained, inventory-pinned DepMap CSV files; resume with a local state file."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.request
import uuid

CHUNK = 48 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Import endpoint redirected; admin credentials were not forwarded")


class Client:
    def __init__(self, url, token, opener=None):
        if not url.startswith("https://") and not re.match(r"^http://(?:localhost|127\.0\.0\.1)(?::[0-9]+)?/", url):
            raise ValueError("Use HTTPS or an explicit local development endpoint")
        if not token:
            raise ValueError("Set DEPMAP_ADMIN_TOKEN for the existing Worker")
        self.url, self.token = url, token
        self.open = opener or urllib.request.build_opener(NoRedirect()).open

    def call(self, name, arguments, depth=0):
        if depth > 4:
            raise ValueError("Unexpected recursive staging")
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": name, "arguments": arguments, "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {"name": "depmap-import", "version": "1"},
                "io.modelcontextprotocol/clientCapabilities": {}}}}
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "Authorization": "Bearer " + self.token, "mcp-method": "tools/call",
                   "mcp-name": name, "mcp-protocol-version": "2026-07-28"}
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        with self.open(request, timeout=60) as response:
            raw = response.read(131073)
            if response.status != 200 or len(raw) > 131072:
                raise ValueError("Invalid or oversized MCP response")
        envelope = json.loads(raw)
        if "error" in envelope:
            raise ValueError("MCP request failed: " + str(envelope["error"])[:1000])
        result = envelope["result"]
        structured = result["structuredContent"]
        if structured.get("staged") and structured.get("_staging"):
            result = self.recover(structured["data_access_id"], depth + 1)
            structured = result["structuredContent"]
        if result.get("isError") or structured.get("success") is False:
            raise ValueError("Import operation failed: " + str(structured.get("error", result.get("content")))[:2000])
        return structured.get("data", structured)

    def recover(self, access_id, depth):
        def rows(sql):
            return self.call("depmap_query_data", {"data_access_id": access_id, "sql": sql, "limit": 1025}, depth)["rows"]
        def text(table, column, where):
            lengths = rows("SELECT length(" + column + ") AS n, length(CAST(" + column + " AS BLOB)) AS bytes FROM " + table + " WHERE " + where)[0]
            size = lengths["n"]
            if type(size) is not int or not 0 <= size <= 16 * 1024**2 or not 0 <= lengths["bytes"] <= 16 * 1024**2:
                raise ValueError("Staged metadata exceeds the local recovery budget")
            return "".join(rows("SELECT substr(" + column + "," + str(start) + ",1000) AS part FROM " + table + " WHERE " + where)[0]["part"]
                           for start in range(1, size + 1, 1000))
        raw = text("payloads", "root_json", "id=1")
        if raw.startswith("__CHUNKED__:"):
            chunk_id = raw[len("__CHUNKED__:"):]
            if not re.fullmatch(r"chunk_[a-f0-9]{32}", chunk_id):
                raise ValueError("Invalid staged content pointer")
            indices = rows("SELECT chunk_index FROM content_chunks WHERE content_id='" + chunk_id + "' ORDER BY chunk_index LIMIT 1025")
            if not indices or [row["chunk_index"] for row in indices] != list(range(len(indices))) or len(indices) > 1024:
                raise ValueError("Invalid staged content sequence")
            parts = []
            size = 0
            for row in indices:
                part = text("content_chunks", "chunk_data", "content_id='" + chunk_id + "' AND chunk_index=" + str(row["chunk_index"]))
                size += len(part.encode())
                if size > 16 * 1024**2:
                    raise ValueError("Staged metadata exceeds the local recovery budget")
                parts.append(part)
            raw = "".join(parts)
        value = json.loads(raw)
        return json.loads(value) if isinstance(value, str) else value

    def operation(self, action, **arguments):
        return self.call("depmap_load_release", {"action": action, **arguments})


def fingerprints(selection, paths):
    if len(paths) != len(selection["files"]):
        raise ValueError("Supply exactly one local file per selected manifest entry, in order")
    result = []
    for spec, path in zip(selection["files"], paths):
        md5, sha = hashlib.md5(), hashlib.sha256()
        size = 0
        with Path(path).open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > spec["bytes"]:
                    raise ValueError("Local file exceeds declared bytes: " + str(path))
                md5.update(chunk)
                sha.update(chunk)
        if size != spec["bytes"] or md5.hexdigest() != spec["md5"].lower():
            raise ValueError("Local file size/MD5 differs from the selected provider pin: " + str(path))
        result.append({"path": str(Path(path).resolve()), "bytes": size, "md5": md5.hexdigest(), "sha256": sha.hexdigest()})
    return result


def save_new_state(path, state):
    path = Path(path)
    handle, name = tempfile.mkstemp(prefix=".depmap-import-", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(handle, "w") as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.link(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def upload_release_file(client, access_id, index, source, remote):
    offset, chunk_index = remote["bytes_received"], remote["chunks"]
    if type(offset) is not int or not 0 <= offset <= source["bytes"] or type(chunk_index) is not int or chunk_index < 0:
        raise ValueError("Invalid server resume position")
    with Path(source["path"]).open("rb") as stream:
        stream.seek(offset)
        while chunk := stream.read(CHUNK):
            result = client.operation("append", data_access_id=access_id, file_index=index, chunk_index=chunk_index, data_base64=base64.b64encode(chunk).decode())
            offset += len(chunk)
            chunk_index += 1
            if result["bytes_received"] != offset or result["next_chunk"] != chunk_index:
                raise ValueError("Server acknowledged a different upload position")
    verified = client.operation("verify", data_access_id=access_id, file_index=index)
    if verified["sha256"] != source["sha256"]:
        raise ValueError("Transferred file differs from the local SHA-256")


def upload(client, selection, paths, state_path, expected_current=None):
    local = fingerprints(selection, paths)  # Verify every local file before any network mutation.
    state_path = Path(state_path)
    if state_path.exists() or state_path.is_symlink():
        state = json.loads(state_path.read_text())
        if state.get("format_version") != "depmap-upload-1" or state["url"] != client.url or state["selection"] != selection or state["files"] != local:
            raise ValueError("State file belongs to a different endpoint, selection or local file; choose a new state path")
    else:
        state = {"format_version": "depmap-upload-1", "url": client.url, "selection": selection, "files": local, "request_id": str(uuid.uuid4())}
        # Keep the idempotency key before begin, including when its reply is lost.
        save_new_state(state_path, state)
    access_id = "depmap_bulk_" + selection["cohort"] + "_" + state["request_id"]
    status = client.operation("status", data_access_id=access_id)
    if status.get("state") is None and not status.get("manifest"):
        status = client.operation("begin", request_id=state["request_id"], selection=selection)
    if status.get("phase") == "published":
        access_id = status["current"]["data_access_id"]
        status = client.operation("status", data_access_id=access_id)
    if status.get("phase") == "aborted":
        raise ValueError("Snapshot was aborted; choose a new state path")
    if status.get("phase") not in ("uploading", "sealed"):
        raise ValueError("Unexpected import state")
    if status["manifest"]["selection"] != selection:
        raise ValueError("Remote snapshot selection differs from the retained local selection")
    for index, source in enumerate(local):
        remote = status["files"][index]
        if remote["verified"]:
            if remote["sha256"] != source["sha256"]:
                raise ValueError("Remote file differs from the local SHA-256")
            continue
        upload_release_file(client, access_id, index, source, remote)
    publish_args = {"data_access_id": access_id}
    if expected_current is not None:
        publish_args["expected_current"] = expected_current
    published = client.operation("publish", **publish_args)
    if published["current"]["manifest_sha256"] != status["manifest"]["manifest_sha256"]:
        raise ValueError("Published snapshot differs from the selected manifest")
    if published["current"]["file_sha256"] != [source["sha256"] for source in local]:
        raise ValueError("Published snapshot bytes differ from the local files")
    return {"publication": published["current"], "reused": published["reused"], "files": local, "state_file": str(state_path),
            "scope": "All selected complete files verified; no whole-release coverage, normalization or latest-release inference."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("selection", help="JSON selection containing exact inventory hash, release/file MD5 pins, roles and sizes")
    parser.add_argument("files", nargs="+", help="Separately obtained CSV paths in selected order")
    parser.add_argument("--url", required=True, help="Explicit deployed or local Worker /mcp URL")
    parser.add_argument("--state", required=True, help="New state path, or this import's existing state path for resumption")
    parser.add_argument("--expected-current", help="Explicit current snapshot selected after inspecting a publication conflict")
    args = parser.parse_args()
    selection = json.loads(Path(args.selection).read_text())
    selection["expected_metadata_sha256"] = selection["expected_metadata_sha256"].lower()
    for file in selection["files"]:
        file["md5"] = file["md5"].lower()
    client = Client(args.url, os.environ.get("DEPMAP_ADMIN_TOKEN"))
    print(json.dumps(upload(client, selection, args.files, args.state, args.expected_current), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        import sys
        print(str(error), file=sys.stderr)
        sys.exit(1)
