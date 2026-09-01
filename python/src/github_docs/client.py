"""Land documentation edits in a GitHub repository as pull requests.

Lists and edits markdown files under a configured set of folders, landing
every edit as a PR against the repository's default branch -- NEVER a direct
push to it. That is the whole point: a doc repo whose history already goes
through review for every change should not grow a side door just because the
edit arrived from a web form.

Auth is a GitHub personal access token for a bot or service account, supplied
by the caller. It needs `repo`, or fine-grained Contents + Pull-requests
read/write on the one repository.

stdlib ``urllib`` only -- no third-party HTTP dependency, so this drops into a
stdlib-first service without dragging a dependency tree behind it.

Flow for a save (see :meth:`GitHubDocsClient.save_file`):

  1. Look up the repository's default branch and its current tip SHA.
  2. Ensure a per-file branch ``<prefix><slugified-path>`` exists, branched off
     the default branch if it does not yet.
  3. PUT the new file content to that branch via the Contents API (one commit).
  4. Reuse an existing open PR for that branch if one exists, else open a new
     one. This is what makes repeated saves to the same file *update* rather
     than pile up duplicate PRs: the PR itself is the review mechanism, so no
     separate diff or version UI is needed.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

__all__ = [
    "Document",
    "DocumentSummary",
    "GitHubDocsClient",
    "GitHubDocsConfig",
    "GitHubDocsError",
    "SaveResult",
    "slugify_path",
]


class GitHubDocsError(Exception):
    """Anything that stopped an edit from landing.

    ``status`` is the upstream HTTP status when there was one, so a caller can
    turn a 404 into its own 404 and everything else into a 502 without parsing
    the message.
    """

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


_SLUG_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")


def slugify_path(path: str) -> str:
    """``handbook/the rules.md`` -> ``handbook-the-rules.md``.

    A branch name has to be stable for a given path -- that is what lets a
    second save find the first save's open PR instead of opening another one --
    and it has to survive the characters a path may contain that a ref may not.
    """
    return _SLUG_RE.sub("-", path).strip("-")


@dataclass(frozen=True)
class DocumentSummary:
    """One markdown file, as it appears in a listing."""

    path: str
    sha: str
    size: int = 0


@dataclass(frozen=True)
class Document:
    """One markdown file, with its contents decoded."""

    path: str
    content: str
    sha: str


@dataclass(frozen=True)
class SaveResult:
    """What a save produced.

    ``created`` is False when an existing open PR was reused rather than a new
    one opened.
    """

    branch: str
    pr_url: str
    pr_number: int
    created: bool


@dataclass(frozen=True)
class GitHubDocsConfig:
    """Everything that varies between one community's doc repo and another's."""

    #: ``owner/repo``.
    #:
    #: Point this at the repository's CURRENT canonical name. GitHub keeps a
    #: renamed or transferred repository's old name working via a 301 redirect,
    #: but ``urllib`` only auto-follows redirects for GET -- POST and PUT
    #: (branch create, content commit, PR open) hard-fail with "Moved
    #: Permanently" against the old name.
    repo: str

    #: A personal access token for a bot or service account.
    token: str = ""

    #: The path roots this client is willing to touch, e.g.
    #: ``("handbook", "policies")``.
    #:
    #: ``None`` means the whole repository. An EMPTY tuple means nothing, which
    #: is the safe reading of "the operator has not filled this in yet" -- not
    #: the same thing as ``None``. Anything outside the roots is refused before
    #: a request is made, so a form field cannot be talked into editing CI
    #: configuration or infrastructure code that happens to share the repo.
    allowed_roots: Optional[Tuple[str, ...]] = None

    #: File extensions this client lists and edits.
    extensions: Tuple[str, ...] = (".md",)

    #: Prefix for the per-file branch. Must end in something that keeps these
    #: refs out of the way of hand-made branches.
    branch_prefix: str = "docs-edit/"

    #: Overridable for GitHub Enterprise.
    api_base: str = "https://api.github.com"

    #: Seconds. A doc save is interactive; it should fail visibly rather than
    #: hang a request thread.
    timeout: float = 15.0

    user_agent: str = "github-docs"

    #: ``{path}`` and ``{author}`` are substituted.
    commit_message_template: str = "Update {path} (edited by {author})"
    pr_title_template: str = "Docs edit: {path}"
    pr_body_template: str = "Edited by **{author}** via the documentation editor.\n\nFile: `{path}`"

    def __post_init__(self) -> None:
        repo = self.repo.strip().strip("/")
        if not _REPO_RE.match(repo):
            # The caller's own configuration, so quoting it back is safe and is
            # the only way this is debuggable.
            raise ValueError(f"github-docs: {self.repo!r} is not an 'owner/repo' repository slug")
        object.__setattr__(self, "repo", repo)
        if self.allowed_roots is not None:
            object.__setattr__(
                self,
                "allowed_roots",
                tuple(root.strip().strip("/") for root in self.allowed_roots if root.strip().strip("/")),
            )

    @property
    def owner(self) -> str:
        return self.repo.split("/", 1)[0]


def _is_safe_path(path: str) -> bool:
    """A path this client is willing to send to GitHub.

    Deliberately narrow. Anything with an empty, ``.`` or ``..`` segment, a
    leading slash, a backslash, a scheme or whitespace is not a path in a
    repository, and is refused rather than escaped -- a path that needs
    escaping is a typo or an attack, and neither should reach the network.
    """
    if not path or path != path.strip() or path.startswith("/") or "\\" in path:
        return False
    segments = path.split("/")
    return all(segment not in ("", ".", "..") for segment in segments)


class GitHubDocsClient:
    """A doc-editing client for one repository."""

    def __init__(self, config: GitHubDocsConfig) -> None:
        self.config = config

    # -- HTTP ---------------------------------------------------------------

    def _redact(self, text: str) -> str:
        """Remove the token from a string on its way into an exception.

        The write half of this library DOES surface GitHub's own error message,
        unlike the read half, which surfaces nothing: an operator staring at a
        failed save needs to know whether it was a permissions problem or a
        merge conflict, and there is a human in the loop to read it. That makes
        it worth being explicit that the one thing which never travels with
        that message is the credential -- GitHub does not echo it back today,
        but a proxy or a future API might, and a control that depends on
        somebody else's behaviour is not a control.
        """
        token = self.config.token.strip()
        return text.replace(token, "***") if token else text

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        allow_404: bool = False,
    ) -> Tuple[int, Any]:
        if not self.config.token:
            raise GitHubDocsError(
                "no GitHub token is configured -- document editing is disabled until a "
                "personal access token for the documentation bot account is provisioned"
            )
        url = path if path.startswith("http") else f"{self.config.api_base.rstrip('/')}{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {
            "Authorization": f"Bearer {self.config.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": self.config.user_agent,
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.config.timeout) as resp:
                raw = resp.read()
                parsed = json.loads(raw) if raw else {}
                return resp.status, parsed
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {}
            if e.code == 404 and allow_404:
                return 404, parsed
            message = parsed.get("message") if isinstance(parsed, dict) else None
            raise GitHubDocsError(
                self._redact(message or f"GitHub API returned HTTP {e.code}"), status=e.code
            ) from e
        except urllib.error.URLError as e:
            raise GitHubDocsError(self._redact(f"could not reach GitHub: {e.reason}")) from e

    # -- Paths --------------------------------------------------------------

    def is_managed(self, path: str) -> bool:
        """Whether this client may read or write ``path``."""
        if not _is_safe_path(path):
            return False
        roots = self.config.allowed_roots
        if roots is None:
            return True
        return any(path == root or path.startswith(root + "/") for root in roots)

    def _require_managed(self, path: str) -> None:
        if not self.is_managed(path):
            roots = self.config.allowed_roots
            where = "the repository" if roots is None else f"the managed paths {roots}"
            raise GitHubDocsError(f"{path!r} is outside {where}", status=400)

    def branch_name_for(self, path: str) -> str:
        """The per-file branch a save to ``path`` commits to."""
        return f"{self.config.branch_prefix}{slugify_path(path)}"

    # -- Reads --------------------------------------------------------------

    def get_default_branch(self) -> str:
        _, repo_info = self._request("GET", f"/repos/{self.config.repo}")
        return str(repo_info["default_branch"])

    def get_ref_sha(self, branch: str, allow_404: bool = False) -> Optional[str]:
        status, data = self._request(
            "GET",
            f"/repos/{self.config.repo}/git/ref/heads/{urllib.parse.quote(branch)}",
            allow_404=allow_404,
        )
        if status == 404:
            return None
        return str(data["object"]["sha"])

    def create_ref(self, branch: str, sha: str) -> None:
        self._request(
            "POST",
            f"/repos/{self.config.repo}/git/refs",
            {"ref": f"refs/heads/{branch}", "sha": sha},
        )

    def list_documents(self) -> List[DocumentSummary]:
        """Every managed document, via the recursive git-trees API.

        One call covers the whole repository tree, instead of one Contents-API
        call per directory.
        """
        default_branch = self.get_default_branch()
        _, tree = self._request(
            "GET", f"/repos/{self.config.repo}/git/trees/{urllib.parse.quote(default_branch)}?recursive=1"
        )
        files: List[DocumentSummary] = []
        for entry in tree.get("tree", []):
            if entry.get("type") != "blob":
                continue
            path = entry["path"]
            if path.endswith(self.config.extensions) and self.is_managed(path):
                files.append(DocumentSummary(path=path, sha=entry["sha"], size=entry.get("size", 0)))
        files.sort(key=lambda f: f.path)
        return files

    def get_file(self, path: str, ref: Optional[str] = None) -> Document:
        self._require_managed(path)
        qs = f"?ref={urllib.parse.quote(ref)}" if ref else ""
        _, data = self._request(
            "GET", f"/repos/{self.config.repo}/contents/{urllib.parse.quote(path)}{qs}"
        )
        if data.get("encoding") != "base64":
            raise GitHubDocsError(f"unexpected content encoding {data.get('encoding')!r} for {path}")
        content = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
        return Document(path=path, content=content, sha=data["sha"])

    def find_open_pr(self, branch: str) -> Optional[Dict[str, Any]]:
        _, prs = self._request(
            "GET",
            f"/repos/{self.config.repo}/pulls"
            f"?head={self.config.owner}:{urllib.parse.quote(branch)}&state=open",
        )
        return prs[0] if prs else None

    # -- Writes -------------------------------------------------------------

    def save_file(
        self,
        path: str,
        content: str,
        author: str,
        message: Optional[str] = None,
    ) -> SaveResult:
        """Commit ``content`` to a per-file branch and open (or reuse) a PR.

        Never touches the default branch. Repeated saves to the same path land
        as further commits on the same branch and the same open PR.
        """
        self._require_managed(path)

        default_branch = self.get_default_branch()
        branch = self.branch_name_for(path)

        branch_sha = self.get_ref_sha(branch, allow_404=True)
        if branch_sha is None:
            base_sha = self.get_ref_sha(default_branch)
            if base_sha is None:
                raise GitHubDocsError(f"default branch {default_branch!r} has no tip commit")
            self.create_ref(branch, base_sha)

        # Current sha of the file ON THE BRANCH: the Contents API needs it to
        # update rather than reject the write as a conflicting create. It may
        # differ from the sha the editor loaded, if someone else saved to this
        # branch in the meantime.
        existing = self.get_file(path, ref=branch)
        commit_message = message or self.config.commit_message_template.format(path=path, author=author)
        body = {
            "message": commit_message,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "sha": existing.sha,
            "branch": branch,
        }
        self._request("PUT", f"/repos/{self.config.repo}/contents/{urllib.parse.quote(path)}", body)

        pr = self.find_open_pr(branch)
        if pr:
            return SaveResult(
                branch=branch, pr_url=pr["html_url"], pr_number=pr["number"], created=False
            )

        _, pr_data = self._request(
            "POST",
            f"/repos/{self.config.repo}/pulls",
            {
                "title": self.config.pr_title_template.format(path=path, author=author),
                "head": branch,
                "base": default_branch,
                "body": self.config.pr_body_template.format(path=path, author=author),
            },
        )
        return SaveResult(
            branch=branch, pr_url=pr_data["html_url"], pr_number=pr_data["number"], created=True
        )
