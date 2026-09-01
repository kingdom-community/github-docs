// The one outbound call: fetching a markdown document out of a GitHub
// repository so a site can render it.
//
// Two failure rules run through everything below, and they are the reason this
// module is worth having rather than inlining a `fetch`.
//
//  1. **Failure is a value, not an exception.** Every function here answers
//     with a discriminated result. GitHub having a bad minute must produce a
//     readable panel and an HTTP 200, never a 5xx — and a page that has to
//     remember to catch is a page that will one day forget.
//  2. **Nothing upstream is ever quoted back.** No response body, no header, no
//     request URL and above all no token appears in a returned value or in an
//     error. The token travels in an `Authorization` header, so it is never in
//     a URL to begin with; keeping bodies out too means there is no path by
//     which a GitHub error page reaches a site's HTML.
//
// This is server-side code. The token must be read from a secret that carries
// no client-bundle prefix (no `NEXT_PUBLIC_`, no `VITE_`) and handed in here;
// it must never be reachable from a browser bundle.

import {
    entryForPath,
    entryForSlug,
    parseCatalogue,
    type DocEntry,
    type DocEntryInput
} from './catalogue.js';
import {requireRepoSlug} from './repo.js';
import {blobUrl, contentsApiUrl, DEFAULT_REF, rawUrl, resolveDocLink} from './urls.js';

/**
 * A few seconds. A page renders its "read it on GitHub" panel rather than
 * making a visitor wait on someone else's outage.
 */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * A megabyte. A documentation page is a few kilobytes; anything past this is
 * not the document that was asked for, and reading it into memory would be a
 * sink on a response this process does not control.
 */
export const DEFAULT_MAX_DOCUMENT_BYTES = 1048576;

export type MarkdownFetch =
    | {status: 'ok'; markdown: string}
    // Reached GitHub and did not get the document: a 404, a rate limit, a 500,
    // a timeout, a DNS failure, an oversized body. A page treats all of these
    // the same way — show the panel, link to GitHub — so they are not
    // distinguished here either. Distinguishing them would also mean deciding
    // what to say about an upstream status, which is the beginning of quoting
    // upstream back.
    | {status: 'unavailable'}
    // Asked for a document from a private repository with no token configured.
    // Distinct from `unavailable` because it is a deployment state rather than
    // an outage, and the panel should say so: nobody is served by telling an
    // operator that GitHub is down when the truth is that they never set the
    // secret.
    | {status: 'not-configured'}
    // The path is not in the catalogue. Also a deployment state rather than an
    // outage, and no request was made. A site normally turns this into a 404.
    | {status: 'not-listed'};

export type Transport = 'raw' | 'api';

export interface DocsClientConfig {
    /** `owner/repo`, or a GitHub URL. Validated when the client is built. */
    repo: string;
    /**
     * The git ref to read. Defaults to `HEAD`, which resolves to the
     * repository's default branch whatever it is called.
     */
    ref?: string;
    /**
     * A token with read access, for a private repository. Omit it for a public
     * one: sending credentials to a host that does not need them is how
     * credentials end up somewhere they should not be.
     */
    token?: string | null;
    /**
     * `raw` reads raw.githubusercontent.com; `api` reads the Contents API.
     * Defaults to `api` when a token is configured and `raw` when one is not,
     * because raw.githubusercontent.com does not accept a bearer token and the
     * Contents API is the path that works for a private repository.
     */
    transport?: Transport;
    /**
     * The documents this site may publish. Provide a list (or the
     * comma-separated string an environment variable comes in) to get a
     * deny-by-default catalogue: anything not named is refused before any
     * request is made.
     *
     * Leave it undefined for a repository whose whole contents are publishable,
     * in which case any syntactically valid path is fetched. Note that an empty
     * list is NOT the same as undefined — it publishes nothing, which is the
     * safe reading of "the operator has not filled this in yet".
     */
    documents?: readonly DocEntryInput[] | string;
    /** Defaults to {@link DEFAULT_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Defaults to {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
    maxDocumentBytes?: number;
    /** Override the API host. Mostly useful for a GitHub Enterprise install. */
    apiBase?: string;
    /** Injectable for tests; defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
}

export interface DocsClient {
    /** The repository slug, normalised. */
    readonly repo: string;
    /** The ref being read. */
    readonly ref: string;
    /** The catalogue, in the order it was configured. Empty when unset. */
    readonly documents: readonly DocEntry[];
    /** Catalogue lookup by URL segment. Null when unknown. */
    entryForSlug(slug: string): DocEntry | null;
    /** Catalogue lookup by repository path. Null when unknown. */
    entryForPath(path: string): DocEntry | null;
    /** Fetch a document by catalogue entry, slug, or repository path. */
    fetchMarkdown(target: DocEntry | string): Promise<MarkdownFetch>;
    /** Where a reader is sent when the fetch fails. */
    webUrl(target: DocEntry | string): string;
    /** The plain-text URL this client would fetch. */
    rawUrl(target: DocEntry | string): string;
    /** Rewrite a link found inside a fetched document. See `resolveDocLink`. */
    resolveLink(href: string, fromPath?: string): string;
}

// One fetch, bounded by a timeout and a size limit, with every failure
// collapsed to `unavailable`.
const fetchMarkdown = async (
    fetchImpl: typeof fetch,
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    maxBytes: number
): Promise<MarkdownFetch> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {headers, signal: controller.signal});
        if (!response.ok) {
            // The body is not read, not logged and not returned. An upstream
            // that echoed a credential back — GitHub does not, but an
            // intermediary might — must not be able to launder it through here.
            return {status: 'unavailable'};
        }
        const text = await response.text();
        if (text.length > maxBytes) {
            return {status: 'unavailable'};
        }
        return {status: 'ok', markdown: text};
    } catch {
        // Deliberately swallowed rather than rethrown or logged with the error
        // attached: the caller's contract is a value, and an upstream error
        // string is upstream text this process has no reason to carry around.
        return {status: 'unavailable'};
    } finally {
        clearTimeout(timer);
    }
};

/**
 * A document from a public repository, over raw.githubusercontent.com. No
 * token is sent, because none is needed.
 */
export const fetchRawMarkdown = async (
    url: string,
    options: {timeoutMs?: number; maxDocumentBytes?: number; fetchImpl?: typeof fetch} = {}
): Promise<MarkdownFetch> =>
    fetchMarkdown(
        options.fetchImpl ?? fetch,
        url,
        {Accept: 'text/plain'},
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
    );

/**
 * A document through the GitHub Contents API, which is the path that works for
 * a private repository.
 *
 * `vnd.github.raw` asks the API for the file itself rather than a JSON envelope
 * with a base64 body — one less encoding to get wrong, and no metadata about a
 * private repository in the response.
 */
export const fetchApiMarkdown = async (
    url: string,
    options: {
        token?: string | null;
        timeoutMs?: number;
        maxDocumentBytes?: number;
        fetchImpl?: typeof fetch;
    } = {}
): Promise<MarkdownFetch> => {
    const token = options.token?.trim();
    const headers: Record<string, string> = {
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    return fetchMarkdown(
        options.fetchImpl ?? fetch,
        url,
        headers,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
    );
};

/**
 * Build a reader for one repository.
 *
 * Throws only here, and only for configuration that cannot describe a
 * repository. After construction every failure is a value.
 */
export const createDocsClient = (config: DocsClientConfig): DocsClient => {
    const repo = requireRepoSlug(config.repo);
    const ref = config.ref?.trim() || DEFAULT_REF;
    const token = config.token?.trim() || null;
    const transport: Transport = config.transport ?? (token ? 'api' : 'raw');
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxDocumentBytes = config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    const apiBase = config.apiBase ?? 'https://api.github.com';
    const fetchImpl = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const hasCatalogue = config.documents !== undefined;
    const documents: readonly DocEntry[] = hasCatalogue ? parseCatalogue(config.documents) : [];

    // Resolve whatever the caller passed to a repository path, or null when the
    // catalogue refuses it. This is the gate: it runs before any URL is built,
    // so an unlisted path is never even turned into a request.
    const pathOf = (target: DocEntry | string): string | null => {
        if (typeof target !== 'string') {
            return target.path;
        }
        const value = target.trim();
        if (value === '') {
            return null;
        }
        if (hasCatalogue) {
            const found = entryForSlug(documents, value) ?? entryForPath(documents, value);
            return found ? found.path : null;
        }
        return parseCatalogue([value])[0]?.path ?? null;
    };

    const requirePath = (target: DocEntry | string): string => {
        const path = pathOf(target);
        if (path === null) {
            // Configuration, not upstream: quoting the caller's own value back
            // is safe and is the only way this is debuggable.
            throw new Error(
                `github-docs: ${JSON.stringify(typeof target === 'string' ? target : target.path)} is not a published document`
            );
        }
        return path;
    };

    return {
        repo,
        ref,
        documents,
        entryForSlug: (slug) => entryForSlug(documents, slug),
        entryForPath: (path) => entryForPath(documents, path),
        webUrl: (target) => blobUrl(repo, requirePath(target), ref),
        rawUrl: (target) => rawUrl(repo, requirePath(target), ref),
        resolveLink: (href, fromPath) => resolveDocLink(repo, href, {fromPath, ref}),
        fetchMarkdown: async (target) => {
            const path = pathOf(target);
            if (path === null) {
                return {status: 'not-listed'};
            }
            if (transport === 'api') {
                if (!token) {
                    return {status: 'not-configured'};
                }
                return fetchApiMarkdown(contentsApiUrl(repo, path, ref, apiBase), {
                    token,
                    timeoutMs,
                    maxDocumentBytes,
                    fetchImpl
                });
            }
            return fetchRawMarkdown(rawUrl(repo, path, ref), {
                timeoutMs,
                maxDocumentBytes,
                fetchImpl
            });
        }
    };
};
