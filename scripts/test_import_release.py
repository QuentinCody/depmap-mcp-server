import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from import_release import CHUNK, Client, NoRedirect, fingerprints, save_new_state, upload


class Response(io.BytesIO):
    status = 200


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = b'ModelID,value\r\n' + b'ACH-1,0\r\n' * 10000
        self.file = self.root / 'matrix.csv'
        self.file.write_bytes(self.raw)
        self.selection = {'cohort': 'adult', 'version': 'fixture', 'expected_metadata_sha256': 'f' * 64,
                          'files': [{'release': 'fixture', 'filename': 'matrix.csv', 'role': 'crispr',
                                     'bytes': len(self.raw), 'md5': hashlib.md5(self.raw).hexdigest()}]}
        self.state = self.root / 'state.json'

    def server(self):
        test = self

        class Server:
            url = 'https://fixture.invalid/mcp'
            snapshot = None
            chunks = []
            calls = []
            lose = None
            wrong_sha = False
            wrong_ack = False
            wrong_publication = False
            publication = None

            def operation(self, action, **args):
                self.calls.append((action, args))
                if action == 'status':
                    return copy.deepcopy(self.snapshot or {'state': None})
                if action == 'begin':
                    self.snapshot = {'phase': 'uploading', 'data_access_id': 'depmap_bulk_adult_' + args['request_id'],
                                     'manifest': {'selection': args['selection'], 'manifest_sha256': 'a' * 64},
                                     'files': [{'verified': 0, 'bytes_received': 0, 'chunks': 0, 'sha256': None}]}
                    result = copy.deepcopy(self.snapshot)
                elif action == 'append':
                    test.assertEqual(args['chunk_index'], len(self.chunks))
                    self.chunks.append(base64.b64decode(args['data_base64'], validate=True))
                    file = self.snapshot['files'][0]
                    file.update(bytes_received=sum(map(len, self.chunks)), chunks=len(self.chunks))
                    result = {'next_chunk': len(self.chunks), 'bytes_received': file['bytes_received'] + int(self.wrong_ack)}
                elif action == 'verify':
                    test.assertEqual(b''.join(self.chunks), test.raw)
                    sha = '0' * 64 if self.wrong_sha else hashlib.sha256(test.raw).hexdigest()
                    self.snapshot['files'][0].update(verified=1, sha256=sha)
                    result = {'sha256': sha}
                elif action == 'publish':
                    test.assertTrue(self.snapshot['files'][0]['verified'])
                    self.snapshot['phase'] = 'sealed'
                    result = {'reused': self.publication is not None, 'current': {
                        'manifest_sha256': 'a' * 64, 'file_sha256': ['0' * 64 if self.wrong_publication else hashlib.sha256(test.raw).hexdigest()],
                        'data_access_id': self.snapshot['data_access_id']}}
                    self.publication = result['current']
                else:
                    raise AssertionError(action)
                if action == self.lose:
                    self.lose = None
                    raise OSError('lost reply')
                return result

        return Server()

    def test_exact_upload_and_idempotent_resume(self):
        server = self.server()
        first = upload(server, self.selection, [self.file], self.state)
        saved = self.state.read_bytes()
        count = len(server.chunks)
        second = upload(server, self.selection, [self.file], self.state)
        self.assertFalse(first['reused'])
        self.assertTrue(second['reused'])
        self.assertEqual(len(server.chunks), count)
        self.assertTrue(all(len(chunk) <= CHUNK for chunk in server.chunks))
        self.assertEqual(self.state.read_bytes(), saved)
        self.assertNotIn('token', self.state.read_text())

    def test_resume_after_each_lost_mutation_reply(self):
        for action in ['begin', 'append', 'verify', 'publish']:
            with self.subTest(action=action):
                server = self.server()
                server.lose = action
                state = self.root / (action + '.json')
                with self.assertRaisesRegex(OSError, 'lost reply'):
                    upload(server, self.selection, [self.file], state)
                saved = state.read_bytes()
                upload(server, self.selection, [self.file], state)
                self.assertEqual(state.read_bytes(), saved)
                self.assertEqual(b''.join(server.chunks), self.raw)
                self.assertEqual(sum(action == 'begin' for action, _ in server.calls), 1)

    def test_all_local_files_checked_before_network(self):
        server = self.server()
        selection = copy.deepcopy(self.selection)
        selection['files'] *= 2
        bad = self.root / 'bad.csv'
        bad.write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError, 'size/MD5'):
            upload(server, selection, [self.file, bad], self.state)
        self.assertEqual(server.calls, [])
        self.assertFalse(self.state.exists())

    def test_rejects_oversize_checksum_and_path_count(self):
        for raw, message in [(self.raw + b'x', 'exceeds'), (b'x' * len(self.raw), 'size/MD5')]:
            self.file.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, message):
                fingerprints(self.selection, [self.file])
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            fingerprints(self.selection, [])

    def test_saved_state_is_exclusive(self):
        save_new_state(self.state, {'original': True})
        with self.assertRaises(FileExistsError):
            save_new_state(self.state, {'original': False})
        self.assertEqual(json.loads(self.state.read_text()), {'original': True})
        self.assertEqual(list(self.root.glob('.depmap-import-*')), [])

    def test_resume_rejects_endpoint_selection_or_file_drift(self):
        server = self.server()
        upload(server, self.selection, [self.file], self.state)
        saved = self.state.read_bytes()
        for key, value in [('url', 'https://other.invalid/mcp'), ('selection', {}), ('files', [])]:
            state = json.loads(saved)
            state[key] = value
            self.state.write_text(json.dumps(state))
            server.calls.clear()
            with self.assertRaisesRegex(ValueError, 'different endpoint, selection or local file'):
                upload(server, self.selection, [self.file], self.state)
            self.assertEqual(server.calls, [])

    def test_rejects_remote_sha_and_ack_before_publication(self):
        for flag in ['wrong_sha', 'wrong_ack']:
            server = self.server()
            setattr(server, flag, True)
            with self.assertRaises(ValueError):
                upload(server, self.selection, [self.file], self.root / (flag + '.json'))
            self.assertIsNone(server.publication)

    def test_rejects_wrong_publication_bytes(self):
        server = self.server()
        server.wrong_publication = True
        with self.assertRaisesRegex(ValueError, 'Published snapshot bytes'):
            upload(server, self.selection, [self.file], self.state)

    def test_remote_verified_file_is_checked_on_resume(self):
        server = self.server()
        upload(server, self.selection, [self.file], self.state)
        server.snapshot['files'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Remote file differs'):
            upload(server, self.selection, [self.file], self.state)

    def test_conflict_override_is_explicit(self):
        server = self.server()
        upload(server, self.selection, [self.file], self.state, 'inspected-current')
        self.assertEqual(server.calls[-1][1]['expected_current'], 'inspected-current')

    def test_auth_url_and_redirect_controls(self):
        for url in ['http://remote.invalid/mcp', 'file:///tmp/mcp', 'http://localhost.evil/mcp']:
            with self.assertRaises(ValueError):
                Client(url, 'test')
        for url in ['https://example.invalid/mcp', 'http://127.0.0.1:8816/mcp', 'http://localhost:8816/mcp']:
            Client(url, 'test')
        with self.assertRaisesRegex(ValueError, 'DEPMAP_ADMIN_TOKEN'):
            Client('https://fixture.invalid/mcp', None)
        with self.assertRaisesRegex(ValueError, 'not forwarded'):
            NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid')

    def test_http_boundary_and_error_handling(self):
        seen = []
        def opener(request, timeout):
            seen.append(request)
            self.assertEqual(timeout, 60)
            return Response(json.dumps({'result': {'structuredContent': {'success': True, 'data': {'ok': True}}, 'content': []}}).encode())
        client = Client('https://fixture.invalid/mcp', 'fixture-secret', opener)
        self.assertEqual(client.operation('status', data_access_id='fixture'), {'ok': True})
        self.assertEqual(seen[0].get_header('Authorization'), 'Bearer fixture-secret')
        self.assertNotIn('fixture-secret', seen[0].data.decode())
        for result in [{'error': {'message': 'failed'}}, {'result': {'isError': True, 'structuredContent': {'success': False, 'error': 'failed'}}}]:
            client.open = lambda *args, **kwargs: Response(json.dumps(result).encode())
            with self.assertRaisesRegex(ValueError, 'failed'):
                client.operation('status')
        client.open = lambda *args, **kwargs: Response(b'x' * 131073)
        with self.assertRaisesRegex(ValueError, 'oversized'):
            client.operation('status')

    def test_recovers_more_than_default_100_staged_chunks(self):
        database = sqlite3.connect(':memory:')
        self.addCleanup(database.close)
        database.row_factory = sqlite3.Row
        database.executescript('CREATE TABLE payloads(id INTEGER, root_json TEXT); CREATE TABLE content_chunks(content_id TEXT, chunk_index INTEGER, chunk_data TEXT);')
        chunk_id = 'chunk_' + 'a' * 32
        payload = {'structuredContent': {'data': {'value': 'λ' * 12000}}, 'content': []}
        raw = json.dumps(payload, ensure_ascii=False)
        database.execute('INSERT INTO payloads VALUES (1,?)', ('__CHUNKED__:' + chunk_id,))
        for index, start in enumerate(range(0, len(raw), 100)):
            database.execute('INSERT INTO content_chunks VALUES (?,?,?)', (chunk_id, index, raw[start:start + 100]))
        client = Client('https://fixture.invalid/mcp', 'test')
        def call(name, args, depth=0):
            self.assertEqual(name, 'depmap_query_data')
            return {'rows': [dict(row) for row in database.execute(args['sql']).fetchmany(args.get('limit', 100))]}
        client.call = call
        self.assertEqual(client.recover('fixture', 1), payload)
        database.execute('DELETE FROM content_chunks WHERE chunk_index=1')
        with self.assertRaisesRegex(ValueError, 'sequence'):
            client.recover('fixture', 1)

    def test_recovery_budget_counts_utf8_bytes(self):
        client = Client('https://fixture.invalid/mcp', 'test')
        client.call = lambda *args: {'rows': [{'n': 10, 'bytes': 16 * 1024**2 + 1}]}
        with self.assertRaisesRegex(ValueError, 'budget'):
            client.recover('fixture', 1)


if __name__ == '__main__':
    unittest.main()
