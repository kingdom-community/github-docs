# github-docs

**Run your community's documentation out of a GitHub repository.**

Your rules page, your onboarding guide, your staff handbook: write them as
markdown, keep them in a git repo, and let the repo be the source of truth. Your
website renders them. Edits from your web app arrive as pull requests, so
someone reviews a change to the rules before it is the rules.

That is one idea with two halves, and the two halves were built in different
languages — so this repo ships two packages.

| | Package | Language | Does |
|---|---|---|---|
| **Read** | [`@kingdom-community/github-docs`](./js) | TypeScript | Fetches markdown from the repo for rendering |
| **Write** | [`github-docs`](./python) | Python (stdlib only) | Lands edits as pull requests |

They are independent. Use one, use the other, use both. They do not talk to each
other; they talk to the same repository.

## The shape of it

```
                 acme-guild/handbook  (markdown in git)
                    ▲                        │
                    │ pull request           │ fetch
                    │                        ▼
        github-docs (Python)      @kingdom-community/github-docs (TS)
        your admin/staff app              your website
```

## Read side — `js/`

```bash
npm install @kingdom-community/github-docs
```

```ts
import {createDocsClient} from '@kingdom-community/github-docs';

const docs = createDocsClient({
    repo: 'acme-guild/handbook',
    documents: ['handbook/rules.md', 'handbook/getting-started.md']
});

const result = await docs.fetchMarkdown('rules');
if (result.status === 'ok') {
    render(result.markdown);
} else {
    renderPanel(`Read it on GitHub: ${docs.webUrl('rules')}`);
}
```

Two rules run through all of it, and they are the reason it is worth installing
rather than writing four lines of `fetch`:

1. **Failure is a value, not an exception.** Every function returns a
   discriminated result. GitHub having a bad minute produces a readable panel
   and an HTTP 200, never a 5xx. A page that has to remember to catch is a page
   that will one day forget.
2. **Nothing upstream is ever quoted back.** No response body, no header, no
   request URL, and above all no token appears in a returned value or in an
   error. There is no path by which a GitHub error page reaches your HTML.

It also ships the URL-scheme allowlist that keeps `[click me](javascript:…)` in
a community-authored document from becoming script execution in a reader's
browser — including the spellings that survive a naive
`startsWith('javascript:')`.

[Full documentation →](./js/README.md)

## Write side — `python/`

```bash
pip install github-docs
```

```python
from github_docs import GitHubDocsClient, GitHubDocsConfig

docs = GitHubDocsClient(GitHubDocsConfig(
    repo="acme-guild/handbook",
    token=os.environ["DOCS_GITHUB_TOKEN"],
    allowed_roots=("handbook", "policies"),
))

result = docs.save_file("handbook/rules.md", new_text, author="mod99")
print(result.pr_url)   # https://github.com/acme-guild/handbook/pull/42
```

Never a direct push. A save commits to a per-file branch and opens a pull
request — or finds the open one from the last save and adds to it, so repeated
edits to the same page update one PR instead of piling up duplicates. The pull
request *is* the review mechanism, which is why there is no diff or version UI
to build.

Standard library `urllib` only. No `requests`, no dependency tree.

[Full documentation →](./python/README.md)

## Why the split

The read side runs in a website's render layer, where the language is
TypeScript and the constraint is that an outage must not become an error page.
The write side runs in an admin app, where the language is Python and the
constraint is that nothing bypasses review. Different jobs, different failure
modes, different code. Sharing a repository keeps the two descriptions of "how
this community's docs work" from drifting apart.

## Development

```bash
# read side
(cd js && npm install && npm test)

# write side
(cd python && PYTHONPATH=src python3 -m unittest discover -s tests -v)
```

CI runs both on every push and pull request.

## License

MIT.

## Origins

Extracted from the website and infrastructure stack behind a Minecraft
community server, generalised and released under MIT.
