"""Validate the exact root deployer's tar extraction code without root access."""
from pathlib import Path
import io
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('zride-deploy.sh').read_text(encoding='utf-8')
EXTRACTOR = SCRIPT.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
REQUIRED = ['package.json', 'package-lock.json', 'server.mjs', 'world.mjs',
            'state-store.mjs', 'effects.mjs', 'game-state.mjs', 'cabin.mjs', 'observer.mjs', 'observer/index.html',
            'observer/app.js', 'observer/style.css', 'phone-client.mjs',
            'phone-client/index.html', 'phone-client/app.js', 'phone-client/style.css']


class DeploymentArchiveTests(unittest.TestCase):
    def run_archive(self, extra=None, omit=None, private_umask=False):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive, output = directory/'source.tar.gz', directory/'release'
            output.mkdir()
            with tarfile.open(archive, 'w:gz') as package:
                for name in REQUIRED:
                    if name == omit:
                        continue
                    item = tarfile.TarInfo(name)
                    item.mode = 0o4777
                    item.size = 2
                    package.addfile(item, io.BytesIO(b'{}'))
                if extra:
                    for item, content in extra:
                        package.addfile(item, io.BytesIO(content) if content is not None else None)
            extractor = ('import os; os.umask(0o077)\n' if private_umask else '') + EXTRACTOR
            result = subprocess.run([sys.executable, '-c', extractor, str(archive), str(output)],
                                    capture_output=True, text=True, timeout=20)
            files = [path.relative_to(output).as_posix() for path in output.rglob('*') if path.is_file()]
            if result.returncode == 0 and os.name == 'posix':
                self.assertEqual((output/'server.mjs').stat().st_mode & 0o7777, 0o644)
                self.assertEqual(output.stat().st_mode & 0o7777, 0o755)
                for path in output.rglob('*'):
                    if path.is_dir():
                        self.assertEqual(path.stat().st_mode & 0o7777, 0o755, path.relative_to(output).as_posix())
            return result, files

    def test_expected_runtime_is_extracted(self):
        result, files = self.run_archive()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(files), set(REQUIRED))

    @unittest.skipUnless(os.name == 'posix', 'Unix mode checks run on Linux CI and deployment guest')
    def test_file_only_tar_implicit_parent_directories_ignore_private_umask(self):
        # No directory TarInfo entries are emitted by this fixture producer.
        nested = tarfile.TarInfo('observer/nested/screens/view.js')
        nested.size = 2
        result, files = self.run_archive([(nested, b'{}')], private_umask=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('observer/nested/screens/view.js', files)

    def test_rejects_traversal_and_absolute_path_before_extracting(self):
        for path in ['../escape', '/tmp/escape', 'observer/../../escape', 'phone-client/../../escape']:
            with self.subTest(path=path):
                item = tarfile.TarInfo(path)
                item.size = 1
                result, files = self.run_archive([(item, b'x')])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(files, [])

    def test_rejects_links_special_files_and_unrelated_data(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]:
            with self.subTest(kind=kind):
                item = tarfile.TarInfo('observer/link.js')
                item.type, item.linkname = kind, '/etc/shadow'
                result, files = self.run_archive([(item, None)])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(files, [])
        for name in ['.env', 'zride.sqlite', 'node_modules/ws/index.js', 'phone-client/.env', 'phone-client/zride.sqlite']:
            item = tarfile.TarInfo(name)
            item.size = 1
            result, files = self.run_archive([(item, b'x')])
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(files, [])

    def test_rejects_duplicate_or_incomplete_runtime(self):
        item = tarfile.TarInfo('server.mjs')
        item.size = 1
        result, files = self.run_archive([(item, b'x')])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(files, [])
        result, files = self.run_archive(omit='state-store.mjs')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(files, [])

    def test_rejects_member_count_and_expansion_limit(self):
        extras = []
        for index in range(501):
            extras.append((tarfile.TarInfo(f'observer/empty-{index}.js'), None))
        result, files = self.run_archive(extras)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(files, [])
        content = bytes(17 * 1024 * 1024)
        item = tarfile.TarInfo('observer/oversized.js')
        item.size = len(content)
        result, files = self.run_archive([(item, content)])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(files, [])


if __name__ == '__main__':
    unittest.main()
