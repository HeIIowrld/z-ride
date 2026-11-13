"""Trust-boundary tests for the public-repository deployment poller."""
from pathlib import Path
import importlib.util
import io
import tarfile
import unittest

SPEC = importlib.util.spec_from_file_location('pull_deploy', Path(__file__).with_name('pull-deploy.py'))
PULL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PULL)


class TrustedMainTests(unittest.TestCase):
    def trusted_run(self, **updates):
        run = dict(event='push', head_branch='main', status='completed', conclusion='success',
                   head_repository={'full_name': PULL.REPOSITORY},
                   path='.github/workflows/server-ci.yml', head_sha='a' * 40)
        run.update(updates)
        return run

    def test_accepts_only_successful_same_repo_main_push(self):
        self.assertEqual(PULL.tested_revision({'workflow_runs': [self.trusted_run()]}), 'a' * 40)
        for updates in [dict(event='pull_request'), dict(head_branch='feature'),
                        dict(status='in_progress'), dict(conclusion='failure'),
                        dict(head_repository={'full_name': 'attacker/z-ride'}),
                        dict(path='.github/workflows/fake.yml'), dict(head_sha='../escape')]:
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                PULL.tested_revision({'workflow_runs': [self.trusted_run(**updates)]})

    def source(self, extra=(), omit=None):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for name in sorted(PULL.REQUIRED):
                if name == omit:
                    continue
                member = tarfile.TarInfo('z-ride-SHA/server/' + name)
                member.size = 2
                archive.addfile(member, io.BytesIO(b'{}'))
            for member, content in extra:
                archive.addfile(member, io.BytesIO(content) if content is not None else None)
        return data.getvalue()

    def test_repackages_only_runtime_without_secrets(self):
        extra = tarfile.TarInfo('z-ride-SHA/server/.env')
        extra.size = 6
        packaged = PULL.runtime_bundle(self.source([(extra, b'secret')]))
        with tarfile.open(fileobj=io.BytesIO(packaged)) as archive:
            self.assertEqual(set(archive.getnames()), PULL.REQUIRED)
            self.assertTrue(all(member.mode == 0o644 for member in archive))

    def test_packages_game_and_bag_assets_for_the_production_extractor(self):
        names = ('style.css', 'bag.html', 'shared/ply.css', 'shared/bag.js',
                 'shared/item-icons.js', 'data/items.json', 'games/raindrop/index.html')
        entries = []
        for name in (*names, 'shared/private.css', 'codex.html', 'data/private.json'):
            item = tarfile.TarInfo('z-ride-SHA/minigames/' + name)
            item.size = 1
            entries.append((item, b'x'))
        with tarfile.open(fileobj=io.BytesIO(PULL.runtime_bundle(self.source(entries)))) as archive:
            self.assertEqual(set(archive.getnames()) - PULL.REQUIRED,
                             {'drive-assets/' + name for name in names})

    def test_rejects_links_traversal_duplicates_and_missing_runtime(self):
        link = tarfile.TarInfo('z-ride-SHA/server/phone-client/link.js')
        link.type, link.linkname = tarfile.SYMTYPE, '/etc/shadow'
        traversal = tarfile.TarInfo('z-ride-SHA/server/../../escape')
        traversal.size = 1
        duplicate = tarfile.TarInfo('z-ride-SHA/server/server.mjs')
        duplicate.size = 1
        for member, content in [(link, None), (traversal, b'x'), (duplicate, b'x')]:
            with self.subTest(path=member.name), self.assertRaises(ValueError):
                PULL.runtime_bundle(self.source([(member, content)]))
        with self.assertRaises(ValueError):
            PULL.runtime_bundle(self.source(omit='phone-client/app.js'))


if __name__ == '__main__':
    unittest.main()
