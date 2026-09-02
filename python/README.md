# github-docs

Land documentation edits in a GitHub repository as **pull requests**, never as
direct pushes.

Your staff app has a "save" button on a markdown editor. This turns that button
into a reviewable PR: commit to a per-file branch, open a pull request against
the default branch — or find the open one from the last save and add to it, so
repeated edits to the same page update one PR rather than piling up duplicates.

Standard library `urllib` only. No `requests`, no dependency tree.

This is the write half of [`kingdom-community/github-docs`](https://github.com/kingdom-community/github-docs).
The read half — fetching markdown for a website to render — is the npm package
[`@kingdom-community/github-docs`](https://github.com/kingdom-community/github-docs/tree/main/js).

## Install

```bash
pip install github-docs
```

Python 3.9 or newer.

## Usage

```python
import os

from github_docs import GitHubDocsClient, GitHubDocsConfig, GitHubDocsError

docs = GitHubDocsClient(
    GitHubDocsConfig(
        repo="acme-guild/handbook",
        token=os.environ["DOCS_GITHUB_TOKEN"],
        # Only these path roots may be listed or edited. Everything else in the
        # repo -- CI config, infrastructure code -- is refused before a request
        # is made.
        allowed_roots=("handbook", "policies", "players"),
    )
)

# What can be edited.
for doc in docs.list_documents():
    print(doc.path, doc.sha, doc.size)

# Load one into the editor.
current = docs.get_file("handbook/rules.md")
print(current.content)

# Save it.
try:
    result = docs.save_file("handbook/rules.md", new_text, author="mod99")
except GitHubDocsError as err:
    return render_error(str(err), status=err.status or 502)

print(result.pr_url)     # https://github.com/acme-guild/handbook/pull/42
print(result.created)    # False when it added to an existing open PR
```

## What a save actually does

1. Look up the repository's default branch and its current tip SHA.
2. Ensure the per-file branch `docs-edit/<slugified-path>` exists, branching it
   off the default branch if it does not.
3. PUT the new content to that branch through the Contents API — one commit,
   carrying the file's current SHA *on that branch* so the API updates rather
   than rejecting the write as a conflicting create.
4. Reuse the open PR for that branch if there is one, else open a new one.

Step 4 is what makes repeated saves *update*. The pull request is the review
mechanism, which is why there is no diff or version UI to build.

The default branch is never written to. That is the whole point: a doc repo
whose history already goes through review for every change should not grow a
side door just because the edit arrived from a web form.

## Configuration

`GitHubDocsConfig` is a frozen dataclass.

| Field | Default | What it does |
|---|---|---|
| `repo` | *(required)* | `owner/repo`. Validated on construction. |
| `token` | `""` | A GitHub personal access token. Needs `repo`, or fine-grained Contents + Pull-requests read/write on the one repository. |
| `allowed_roots` | `None` | Path roots this client may touch. `None` means the whole repository; an **empty tuple means nothing**, which is the safe reading of "not filled in yet". |
| `extensions` | `(".md",)` | Which files are listed and edited. |
| `branch_prefix` | `"docs-edit/"` | Prefix for the per-file branch. |
| `api_base` | `"https://api.github.com"` | For GitHub Enterprise. |
| `timeout` | `15.0` | Seconds. A save is interactive; it should fail visibly rather than hang a request thread. |
| `user_agent` | `"github-docs"` | Sent on every request. |
| `commit_message_template` | `"Update {path} (edited by {author})"` | `{path}` and `{author}` are substituted. |
| `pr_title_template` | `"Docs edit: {path}"` | " |
| `pr_body_template` | `"Edited by **{author}** ..."` | " |

This package reads no environment variables of its own — a library that reads
`os.environ` is a library you cannot configure twice in one process. Read yours
in your app and pass the values in.

Point `repo` at the repository's **current canonical name**. GitHub keeps a
renamed or transferred repository's old name working via a 301 redirect, but
`urllib` only auto-follows redirects for GET — the POST and PUT calls (branch
create, content commit, PR open) hard-fail with "Moved Permanently" against the
old name.

## Errors

Everything that stopped an edit from landing raises `GitHubDocsError`, which
carries `.status` — the upstream HTTP status when there was one — so a caller
can map a 404 to its own 404 and everything else to a 502 without parsing the
message.

Unlike the read half of this pair, the write half *does* surface GitHub's own
error message: an operator staring at a failed save needs to know whether it was
a permissions problem or a merge conflict, and there is a human in the loop to
read it. The one thing that never travels with that message is the credential —
the token is stripped from any error text on its way into the exception, because
a control that depends on somebody else's behaviour is not a control.

## API

- `GitHubDocsConfig(...)` — configuration.
- `GitHubDocsClient(config)`
  - `.list_documents() -> list[DocumentSummary]`
  - `.get_file(path, ref=None) -> Document`
  - `.save_file(path, content, author, message=None) -> SaveResult`
  - `.is_managed(path) -> bool`
  - `.branch_name_for(path) -> str`
  - `.get_default_branch()`, `.get_ref_sha()`, `.create_ref()`, `.find_open_pr()`
- `Document`, `DocumentSummary`, `SaveResult` — frozen dataclasses.
- `GitHubDocsError`
- `slugify_path(path)`

## Development

```bash
# from python/, with src/ on the path — or after `pip install -e .`
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

The tests mock `urllib.request.urlopen` with a small fake GitHub API keyed on
(method, url), so they need no network access and never touch a real repository.

## License

MIT.

## Origins

Extracted from the website and infrastructure stack behind a Minecraft
community server, generalised and released under MIT.
