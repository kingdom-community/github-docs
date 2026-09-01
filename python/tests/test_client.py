"""Unit tests for the branch/PR-reuse logic.

``urllib.request.urlopen`` is mocked with a small fake GitHub API keyed on
(method, url), so these tests need no network access and never touch a real
repository.

Run:  python3 -m unittest discover -s tests -v
"""

import base64
import json
import unittest
import urllib.error
import urllib.parse
from unittest import mock

from github_docs import (
    Document,
    GitHubDocsClient,
    GitHubDocsConfig,
    GitHubDocsError,
    slugify_path,
)

REPO = "acme-guild/handbook"
# The stand-in secret handed to the client. The leak tests assert this exact
# string never reaches a returned value, a URL or an error message.
#
# Deliberately NOT shaped like a real credential: no `ghp_` / `gho_` /
# `github_pat_` prefix and no random-looking entropy, because this repo is
# public and a realistic-looking literal trips GitHub secret scanning, which
# files a false-positive alert and can block pushes that touch this line. The
# assertions only need a distinctive, greppable sentinel to look for, and this
# string is exactly as good at that job. Please do not "fix" it back into
# something that looks authentic.
TOKEN = "sentinel-not-a-real-credential-leak-canary"
ROOTS = ("handbook", "policies", "players")


def make_client(**overrides) -> GitHubDocsClient:
    settings = {"repo": REPO, "token": TOKEN, "allowed_roots": ROOTS}
    settings.update(overrides)
    return GitHubDocsClient(GitHubDocsConfig(**settings))


def _response(payload, status=200):
    resp = mock.MagicMock()
    resp.read.return_value = json.dumps(payload).encode()
    resp.status = status
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = False
    return resp


def _http_error(code=404, message="Not Found"):
    err = urllib.error.HTTPError(url="x", code=code, msg=message, hdrs=None, fp=None)
    err.read = mock.MagicMock(return_value=json.dumps({"message": message}).encode())
    return err


class FakeGitHub:
    """Routes urlopen(req) calls by (method, url-without-query) to a handler,
    so tests read as "given this API state, calling save_file() does X" rather
    than as a brittle ordered list of responses."""

    def __init__(self, client: GitHubDocsClient, edited_path: str = "handbook/example.md"):
        self.client = client
        self.edited_path = edited_path
        self.default_branch = "main"
        self.branch_exists = False
        self.branch_file_sha = "filesha-onbranch"
        self.default_branch_sha = "sha-on-main"
        self.open_prs = []  # dicts with html_url/number
        self.created_refs = []
        self.put_calls = []
        self.created_prs = []
        self.requests = []  # (method, full_url, headers)

    def __call__(self, req, timeout=None):
        method = req.get_method()
        url = req.full_url.split("?", 1)[0]
        self.requests.append((method, req.full_url, dict(req.headers)))

        if method == "GET" and url.endswith(f"/repos/{REPO}"):
            return _response({"default_branch": self.default_branch})

        if method == "GET" and "/git/ref/heads/" in url:
            branch = urllib.parse.unquote(url.split("/git/ref/heads/")[1])
            if branch == self.default_branch:
                return _response({"object": {"sha": self.default_branch_sha}})
            if branch == self.client.branch_name_for(self.edited_path) and self.branch_exists:
                return _response({"object": {"sha": "branch-tip-sha"}})
            raise _http_error()

        if method == "GET" and "/git/trees/" in url:
            return _response(
                {
                    "tree": [
                        {"type": "blob", "path": "handbook/b.md", "sha": "s2", "size": 20},
                        {"type": "blob", "path": "handbook/a.md", "sha": "s1", "size": 10},
                        {"type": "blob", "path": "handbook/logo.png", "sha": "s3", "size": 30},
                        {"type": "blob", "path": "infrastructure/main.tf", "sha": "s4", "size": 40},
                        {"type": "blob", "path": "README.md", "sha": "s5", "size": 50},
                        {"type": "tree", "path": "handbook", "sha": "s6"},
                    ]
                }
            )

        if method == "POST" and url.endswith("/git/refs"):
            body = json.loads(req.data)
            self.created_refs.append(body)
            self.branch_exists = True
            return _response({"ref": body["ref"]}, status=201)

        if method == "GET" and "/contents/" in url:
            return _response(
                {
                    "content": base64.b64encode(b"old content").decode(),
                    "encoding": "base64",
                    "sha": self.branch_file_sha,
                }
            )

        if method == "PUT" and "/contents/" in url:
            self.put_calls.append(json.loads(req.data))
            return _response({"content": {"sha": "newsha"}}, status=200)

        if method == "GET" and url.endswith("/pulls"):
            return _response(self.open_prs)

        if method == "POST" and url.endswith("/pulls"):
            body = json.loads(req.data)
            pr = {"html_url": f"https://github.com/{REPO}/pull/42", "number": 42, **body}
            self.created_prs.append(pr)
            return _response(pr, status=201)

        raise AssertionError(f"unexpected request: {method} {url}")


class TestConfig(unittest.TestCase):
    def test_rejects_something_that_is_not_a_repository_slug(self):
        for bad in ["handbook", "acme-guild/", "/handbook", "a/b/c", "https://github.com/a/b", ""]:
            with self.subTest(bad):
                with self.assertRaises(ValueError):
                    GitHubDocsConfig(repo=bad, token=TOKEN)

    def test_tidies_the_slashes_a_human_leaves_behind(self):
        self.assertEqual(GitHubDocsConfig(repo="  /acme-guild/handbook/ ", token=TOKEN).repo, REPO)

    def test_owner_is_the_first_half(self):
        self.assertEqual(GitHubDocsConfig(repo=REPO, token=TOKEN).owner, "acme-guild")


class TestNoTokenConfigured(unittest.TestCase):
    def test_raises_a_clear_error_when_the_token_is_missing(self):
        client = make_client(token="")
        with self.assertRaises(GitHubDocsError) as ctx:
            client.get_default_branch()
        message = str(ctx.exception)
        self.assertIn("token", message)
        # An error that says only "401" leaves an operator guessing; this one
        # names the missing thing and what it disables.
        self.assertIn("document editing is disabled", message)


class TestManagedPaths(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def test_managed_paths(self):
        self.assertTrue(self.client.is_managed("handbook/getting-started.md"))
        self.assertTrue(self.client.is_managed("policies/moderation.md"))
        self.assertTrue(self.client.is_managed("players/rules.md"))

    def test_unmanaged_paths_rejected(self):
        self.assertFalse(self.client.is_managed("infrastructure/terraform/main.tf"))
        self.assertFalse(self.client.is_managed("plugins/README.md"))
        self.assertFalse(self.client.is_managed("README.md"))
        # A prefix match is not a path match.
        self.assertFalse(self.client.is_managed("handbookish/x.md"))

    def test_traversal_is_refused_even_under_a_managed_root(self):
        for path in [
            "handbook/../infrastructure/main.tf",
            "handbook/./x.md",
            "/handbook/x.md",
            "handbook//x.md",
            "handbook\\x.md",
            " handbook/x.md",
            "",
        ]:
            with self.subTest(path):
                self.assertFalse(self.client.is_managed(path))

    def test_none_means_the_whole_repository(self):
        client = make_client(allowed_roots=None)
        self.assertTrue(client.is_managed("anything/at/all.md"))
        self.assertFalse(client.is_managed("../escape.md"))

    def test_empty_tuple_means_nothing_rather_than_everything(self):
        client = make_client(allowed_roots=())
        self.assertFalse(client.is_managed("handbook/rules.md"))

    def test_get_file_rejects_an_unmanaged_path(self):
        with self.assertRaises(GitHubDocsError):
            self.client.get_file("infrastructure/terraform/main.tf")

    def test_save_file_rejects_an_unmanaged_path(self):
        with self.assertRaises(GitHubDocsError):
            self.client.save_file("plugins/README.md", "x", "someone")

    def test_the_gate_runs_before_the_request_not_after(self):
        urlopen = mock.MagicMock()
        with mock.patch("urllib.request.urlopen", urlopen):
            with self.assertRaises(GitHubDocsError):
                self.client.save_file("infrastructure/main.tf", "x", "someone")
        urlopen.assert_not_called()


class TestBranchNaming(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def test_slugifies_path_separators(self):
        self.assertEqual(
            self.client.branch_name_for("handbook/getting-started.md"),
            "docs-edit/handbook-getting-started.md",
        )

    def test_stable_and_collision_free_for_distinct_paths(self):
        a = self.client.branch_name_for("policies/moderation.md")
        b = self.client.branch_name_for("policies/escalation.md")
        self.assertNotEqual(a, b)
        self.assertEqual(a, self.client.branch_name_for("policies/moderation.md"))

    def test_prefix_is_configurable(self):
        client = make_client(branch_prefix="content/")
        self.assertEqual(client.branch_name_for("handbook/a.md"), "content/handbook-a.md")

    def test_slugify_drops_the_characters_a_ref_may_not_carry(self):
        self.assertEqual(slugify_path("handbook/the rules!.md"), "handbook-the-rules-.md")


class TestListDocuments(unittest.TestCase):
    def test_lists_only_managed_markdown_sorted(self):
        client = make_client()
        fake = FakeGitHub(client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            files = client.list_documents()
        self.assertEqual([f.path for f in files], ["handbook/a.md", "handbook/b.md"])
        self.assertEqual(files[0].sha, "s1")
        self.assertEqual(files[0].size, 10)

    def test_extensions_are_configurable(self):
        client = make_client(extensions=(".md", ".png"))
        fake = FakeGitHub(client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            files = client.list_documents()
        self.assertEqual([f.path for f in files], ["handbook/a.md", "handbook/b.md", "handbook/logo.png"])


class TestGetFile(unittest.TestCase):
    def test_decodes_the_base64_envelope(self):
        client = make_client()
        fake = FakeGitHub(client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            doc = client.get_file("handbook/example.md")
        self.assertEqual(doc, Document(path="handbook/example.md", content="old content", sha="filesha-onbranch"))


class TestSaveFileCreatesBranchAndPr(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def test_creates_branch_and_opens_pr_when_none_exists(self):
        fake = FakeGitHub(self.client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            result = self.client.save_file("handbook/example.md", "new content", "someone")

        self.assertTrue(fake.created_refs, "expected a new branch ref to be created")
        self.assertEqual(
            fake.created_refs[0]["ref"], "refs/heads/docs-edit/handbook-example.md"
        )
        self.assertEqual(fake.created_refs[0]["sha"], "sha-on-main")
        self.assertEqual(len(fake.put_calls), 1)
        self.assertEqual(base64.b64decode(fake.put_calls[0]["content"]).decode(), "new content")
        self.assertTrue(result.created)
        self.assertEqual(result.pr_url, f"https://github.com/{REPO}/pull/42")

    def test_reuses_existing_open_pr_instead_of_opening_a_duplicate(self):
        fake = FakeGitHub(self.client)
        fake.branch_exists = True
        fake.open_prs = [{"html_url": f"https://github.com/{REPO}/pull/7", "number": 7}]
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            result = self.client.save_file("handbook/example.md", "second edit", "someone")

        self.assertFalse(result.created)
        self.assertEqual(result.pr_number, 7)
        self.assertEqual(fake.created_prs, [])
        self.assertEqual(fake.created_refs, [], "the branch already existed; it must not be recreated")

    def test_commit_message_includes_author(self):
        fake = FakeGitHub(self.client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            self.client.save_file("handbook/example.md", "content", "mod99")
        self.assertIn("mod99", fake.put_calls[0]["message"])

    def test_an_explicit_message_wins(self):
        fake = FakeGitHub(self.client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            self.client.save_file("handbook/example.md", "c", "mod99", message="Fix a typo")
        self.assertEqual(fake.put_calls[0]["message"], "Fix a typo")

    def test_templates_are_configurable(self):
        client = make_client(
            commit_message_template="docs: {path}",
            pr_title_template="[docs] {path}",
            pr_body_template="{author} edited {path}",
        )
        fake = FakeGitHub(client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            client.save_file("handbook/example.md", "c", "mod99")
        self.assertEqual(fake.put_calls[0]["message"], "docs: handbook/example.md")
        self.assertEqual(fake.created_prs[0]["title"], "[docs] handbook/example.md")
        self.assertEqual(fake.created_prs[0]["body"], "mod99 edited handbook/example.md")

    # The whole reason this library exists rather than a two-line push.
    def test_never_writes_to_the_default_branch(self):
        fake = FakeGitHub(self.client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            self.client.save_file("handbook/example.md", "content", "someone")

        branch = self.client.branch_name_for("handbook/example.md")
        self.assertEqual(fake.put_calls[0]["branch"], branch)
        self.assertNotEqual(fake.put_calls[0]["branch"], fake.default_branch)
        self.assertEqual(fake.created_prs[0]["base"], "main")
        self.assertEqual(fake.created_prs[0]["head"], branch)

    def test_updates_rather_than_recreates_by_sending_the_files_current_sha(self):
        fake = FakeGitHub(self.client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            self.client.save_file("handbook/example.md", "content", "someone")
        self.assertEqual(fake.put_calls[0]["sha"], "filesha-onbranch")


class TestCredentialHandling(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def test_token_travels_in_a_header_and_never_in_a_url(self):
        fake = FakeGitHub(self.client)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            self.client.save_file("handbook/example.md", "content", "someone")

        self.assertTrue(fake.requests)
        for method, url, headers in fake.requests:
            self.assertNotIn(TOKEN, url, f"{method} {url}")
            # urllib title-cases header names on the Request object.
            self.assertEqual(headers.get("Authorization"), f"Bearer {TOKEN}")

    def test_an_upstream_error_that_echoes_the_token_is_redacted(self):
        # GitHub does not echo the credential back, but a proxy or a future API
        # might, and an error message tends to end up in a log.
        def raise_leaky(req, timeout=None):
            raise _http_error(code=401, message=f"Bad credentials: {TOKEN}")

        with mock.patch("urllib.request.urlopen", side_effect=raise_leaky):
            with self.assertRaises(GitHubDocsError) as ctx:
                self.client.get_default_branch()

        self.assertNotIn(TOKEN, str(ctx.exception))
        self.assertIn("***", str(ctx.exception))
        self.assertEqual(ctx.exception.status, 401)


class TestErrorSurface(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def test_surfaces_the_upstream_status_so_a_caller_can_map_it(self):
        with mock.patch("urllib.request.urlopen", side_effect=_http_error(code=404, message="Not Found")):
            with self.assertRaises(GitHubDocsError) as ctx:
                self.client.get_default_branch()
        self.assertEqual(ctx.exception.status, 404)
        self.assertIn("Not Found", str(ctx.exception))

    def test_allow_404_turns_a_missing_ref_into_none_rather_than_an_error(self):
        with mock.patch("urllib.request.urlopen", side_effect=_http_error()):
            self.assertIsNone(self.client.get_ref_sha("no-such-branch", allow_404=True))

    def test_a_network_failure_becomes_a_readable_error(self):
        with mock.patch(
            "urllib.request.urlopen", side_effect=urllib.error.URLError("Name or service not known")
        ):
            with self.assertRaises(GitHubDocsError) as ctx:
                self.client.get_default_branch()
        self.assertIn("could not reach GitHub", str(ctx.exception))
        self.assertIsNone(ctx.exception.status)


if __name__ == "__main__":
    unittest.main()
