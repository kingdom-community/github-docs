# @kingdom-community/github-docs

Read your community's documentation out of a GitHub repository.

Fetches markdown from a repo so your site can render it, under two rules:
**failure is a value, not an exception**, and **nothing upstream is ever quoted
back**. Ships the URL-scheme allowlist that keeps a community-authored markdown
link from becoming script execution in a reader's browser.

This is the read half of [`kingdom-community/github-docs`](https://github.com/kingdom-community/github-docs).
The write half — landing edits as pull requests — is the Python package
[`github-docs`](https://github.com/kingdom-community/github-docs/tree/main/python).

## Install

```bash
npm install @kingdom-community/github-docs
```

Node 18 or newer (it uses the global `fetch`). ESM. Types included.

## Usage

```ts
import {createDocsClient} from '@kingdom-community/github-docs';

const docs = createDocsClient({
    repo: 'acme-guild/handbook',
    // Deny-by-default: only these are ever fetched, and anything else 404s
    // without asking GitHub at all.
    documents: [
        {path: 'handbook/getting-started.md', title: 'Getting started', summary: 'Your first hour.'},
        'handbook/rules.md',
        'handbook/commands.md'
    ]
});

// An index page.
for (const doc of docs.documents) {
    console.log(doc.slug, doc.title, doc.summary);
}

// A document page, at /docs/[slug].
const result = await docs.fetchMarkdown(slug);
switch (result.status) {
    case 'ok':
        return {props: {markdown: result.markdown}};
    case 'not-listed':
        return {notFound: true};
    case 'not-configured':
        // A deployment state, not an outage. Say so.
        return {props: {panel: 'Documentation is not configured on this deployment.'}};
    case 'unavailable':
        return {props: {panel: `Read it on GitHub: ${docs.webUrl(slug)}`}};
}
```

Note what does *not* appear: a `try`/`catch`. `fetchMarkdown` never rejects. It
returns a value for every way a fetch can go wrong — a 404, a rate limit, an
upstream 500, a timeout, a DNS failure, an oversized body — so a page cannot
forget to handle one and turn someone else's bad minute into your 5xx.

### A private repository

```ts
const docs = createDocsClient({
    repo: 'acme-guild/internal-handbook',
    token: process.env.DOCS_GITHUB_TOKEN,   // server-side secret, see below
    documents: process.env.DOCS_PUBLIC_FILES // "a/b.md, a/c.md"
});
```

With a token, the client reads through the GitHub Contents API (which accepts
one) rather than `raw.githubusercontent.com` (which does not). Without a token
it reads the raw host and sends no credentials at all — because sending
credentials to a host that does not need them is how credentials end up
somewhere they should not be.

### Rendering safely

Every URL a rendered document is about to emit should pass through the
allowlist first, in the renderer's component override or link callback — not
against the markdown source, which misses reference-style links entirely.

```tsx
import Markdown from 'markdown-to-jsx';
import {isExternalUrl, safeImageUrl, safeLinkUrl} from '@kingdom-community/github-docs';

const Link = ({href, children}: {href?: string; children?: React.ReactNode}) => {
    const safe = safeLinkUrl(href);
    if (safe === null) {
        return <>{children}</>;   // plain text, not a link to nowhere
    }
    const external = isExternalUrl(safe);
    return (
        <a href={safe} {...(external ? {target: '_blank', rel: 'noopener noreferrer'} : {})}>
            {children}
        </a>
    );
};

const Image = ({src, alt}: {src?: string; alt?: string}) => {
    const safe = safeImageUrl(src);
    return safe === null ? null : <img src={safe} alt={alt ?? ''} />;
};

<Markdown options={{overrides: {a: Link, img: Image}}}>{markdown}</Markdown>;
```

### Links written for GitHub

`[Rules](rules.md)` works when the document is read inside the repository. On
your site the browser would resolve it against your origin and 404. Point it
back at the source:

```ts
docs.resolveLink('rules.md', 'handbook/getting-started.md');
// https://github.com/acme-guild/handbook/blob/HEAD/handbook/rules.md
```

## Configuration

| Option | Default | What it does |
|---|---|---|
| `repo` | *(required)* | `owner/repo`, or a GitHub URL. Validated when the client is built — the only place this package throws. |
| `ref` | `'HEAD'` | The git ref to read. `HEAD` resolves to the default branch whatever it is called. |
| `token` | none | A read token, for a private repository. Omit for a public one. |
| `transport` | `'api'` with a token, `'raw'` without | Contents API vs `raw.githubusercontent.com`. |
| `documents` | *(unset)* | The catalogue. A list, or a comma-separated string. **Unset means the whole repository is fetchable; an empty list means nothing is.** |
| `timeoutMs` | `5000` | A page renders its panel rather than making a visitor wait on someone else's outage. |
| `maxDocumentBytes` | `1048576` | Anything larger is not the document that was asked for. |
| `apiBase` | `https://api.github.com` | For GitHub Enterprise. |
| `fetchImpl` | global `fetch` | Injectable, for tests. |

### Environment variables

This package reads none itself — a library that reads `process.env` is a library
you cannot test twice with different settings. Read them in your app and pass
the values in. Whatever you name yours, the token variable **must not** carry a
client-bundle prefix (`NEXT_PUBLIC_`, `VITE_`, …), or your bundler will inline
the credential into the browser bundle.

```ts
createDocsClient({
    repo: process.env.DOCS_REPO!,
    token: process.env.DOCS_GITHUB_TOKEN,
    documents: process.env.DOCS_PUBLIC_FILES
});
```

## The result type

```ts
type MarkdownFetch =
    | {status: 'ok'; markdown: string}
    | {status: 'unavailable'}      // reached GitHub, did not get the document
    | {status: 'not-configured'}   // a private repo with no token: a deployment state
    | {status: 'not-listed'};      // not in the catalogue; nothing was requested
```

`unavailable` deliberately does not say *why*. A page treats every upstream
failure the same way, and distinguishing them would mean deciding what to say
about an upstream status — which is the beginning of quoting upstream back.

## API

Everything is exported from the package root.

**Client** — `createDocsClient`, `fetchRawMarkdown`, `fetchApiMarkdown`,
`DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_DOCUMENT_BYTES`.

**Catalogue** — `parseCatalogue`, `entryForSlug`, `entryForPath`,
`isSafeDocPath`, `slugForPath`, `titleForSlug`.

**Repository** — `parseRepoSlug`, `requireRepoSlug`, `repoWebUrl`,
`releasesUrl`.

**URLs** — `rawUrl`, `blobUrl`, `contentsApiUrl`, `resolveDocLink`,
`resolveRepoPath`, `isSelfContainedTarget`, `encodeDocPath`, `DEFAULT_REF`.

**Markdown URL safety** — `safeLinkUrl`, `safeImageUrl`, `isExternalUrl`,
`ALLOWED_LINK_SCHEMES`, `ALLOWED_IMAGE_SCHEMES`.

## Development

```bash
npm install
npm test         # vitest
npm run typecheck
npm run build
```

## License

MIT.

## Origins

Extracted from the website and infrastructure stack behind a Minecraft
community server, generalised and released under MIT.
