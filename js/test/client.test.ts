import {afterEach, describe, expect, it, vi} from 'vitest';

import {createDocsClient, type MarkdownFetch} from '../src/client';

const REPO = 'acme-guild/handbook';
const DOCS = ['handbook/rules.md', 'handbook/getting-started.md'];

// The stand-in secret, and a body that quotes it back. A real GitHub error
// body does not echo the credential, but an upstream that did — a
// misconfigured proxy, a future API, an intermediary — must not be able to
// launder it through this package.
//
// Deliberately NOT shaped like a real credential: no `ghp_` / `gho_` /
// `github_pat_` prefix and no random-looking entropy, because this repo is
// public and a realistic-looking literal trips GitHub secret scanning, which
// files a false-positive alert and can block pushes that touch this line. The
// leak assertions only need a distinctive, greppable sentinel to look for, and
// this string is exactly as good at that job. Please do not "fix" it back into
// something that looks authentic.
const TOKEN = 'sentinel-not-a-real-credential-leak-canary';
const LEAKY_BODY = `{"message":"Bad credentials: ${TOKEN}","documentation_url":"https://docs.github.com/rest"}`;

const okResponse = (text: string): Response =>
    ({ok: true, status: 200, text: async () => text} as unknown as Response);

const errorResponse = (status: number, body: string): Response =>
    ({ok: false, status, statusText: 'Unauthorized', text: async () => body} as unknown as Response);

// Everything a result could possibly carry, flattened to one string. If the
// token or the body is anywhere in the returned value — including on a property
// nobody thought to check — this catches it.
const everythingIn = (result: MarkdownFetch): string =>
    [
        JSON.stringify(result),
        ...Object.getOwnPropertyNames(result).map(
            (key) => `${key}=${String((result as unknown as Record<string, unknown>)[key])}`
        )
    ].join(' | ');

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the happy path', () => {
    it('returns the document', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse('# Rules\n'));
        const client = createDocsClient({repo: REPO, documents: DOCS, fetchImpl: fetchImpl as never});

        await expect(client.fetchMarkdown('rules')).resolves.toEqual({status: 'ok', markdown: '# Rules\n'});
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][0]).toBe(
            'https://raw.githubusercontent.com/acme-guild/handbook/HEAD/handbook/rules.md'
        );
    });

    it('accepts a slug, a repository path, or a catalogue entry', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse('body'));
        const client = createDocsClient({repo: REPO, documents: DOCS, fetchImpl: fetchImpl as never});

        for (const target of ['rules', 'handbook/rules.md', client.entryForSlug('rules')!]) {
            await expect(client.fetchMarkdown(target)).resolves.toEqual({status: 'ok', markdown: 'body'});
        }
    });
});

describe('failure is a value, not an exception', () => {
    // The point of the whole module: none of these reject, so no caller has to
    // remember to catch, and none of them can turn into a 5xx.
    const cases: [string, () => unknown][] = [
        ['a 404', () => vi.fn().mockResolvedValue(errorResponse(404, 'Not Found'))],
        ['a rate limit', () => vi.fn().mockResolvedValue(errorResponse(403, 'rate limit exceeded'))],
        ['an upstream 500', () => vi.fn().mockResolvedValue(errorResponse(500, 'Server Error'))],
        ['a network failure', () => vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'))],
        ['an abort', () => vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), {name: 'AbortError'}))],
        ['a body that never resolves to text', () => vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => {
                throw new Error('unexpected end of stream');
            }
        })]
    ];

    for (const [name, makeFetch] of cases) {
        it(`collapses ${name} to unavailable`, async () => {
            const client = createDocsClient({repo: REPO, documents: DOCS, fetchImpl: makeFetch() as never});
            await expect(client.fetchMarkdown('rules')).resolves.toEqual({status: 'unavailable'});
        });
    }

    it('refuses a document larger than the limit rather than holding it in memory', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse('x'.repeat(101)));
        const client = createDocsClient({
            repo: REPO,
            documents: DOCS,
            maxDocumentBytes: 100,
            fetchImpl: fetchImpl as never
        });
        await expect(client.fetchMarkdown('rules')).resolves.toEqual({status: 'unavailable'});
    });

    it('gives up after the timeout by aborting the request', async () => {
        const fetchImpl = vi.fn(
            (_url: string, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                })
        );
        const client = createDocsClient({
            repo: REPO,
            documents: DOCS,
            timeoutMs: 5,
            fetchImpl: fetchImpl as never
        });
        await expect(client.fetchMarkdown('rules')).resolves.toEqual({status: 'unavailable'});
    });
});

describe('nothing upstream is ever quoted back', () => {
    it('does not put a failing response body or the token into the returned value', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(errorResponse(401, LEAKY_BODY));
        const client = createDocsClient({
            repo: REPO,
            documents: DOCS,
            token: TOKEN,
            fetchImpl: fetchImpl as never
        });

        const result = await client.fetchMarkdown('rules');

        expect(result).toEqual({status: 'unavailable'});
        const serialised = everythingIn(result);
        expect(serialised).not.toContain(TOKEN);
        expect(serialised).not.toContain('Bad credentials');
        expect(serialised).not.toContain('documentation_url');
        expect(serialised).not.toContain('401');
        // Not even the URL, which names the private repository.
        expect(serialised).not.toContain('api.github.com');
        expect(serialised).not.toContain(REPO);
    });

    it('does not read the body of a failing response at all', async () => {
        const text = vi.fn(async () => LEAKY_BODY);
        const fetchImpl = vi.fn().mockResolvedValue({ok: false, status: 500, text});
        const client = createDocsClient({
            repo: REPO,
            documents: DOCS,
            token: TOKEN,
            fetchImpl: fetchImpl as never
        });

        await client.fetchMarkdown('rules');

        expect(text).not.toHaveBeenCalled();
    });

    it('does not put an upstream error message into the returned value', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED using ${TOKEN}`));
        const client = createDocsClient({
            repo: REPO,
            documents: DOCS,
            token: TOKEN,
            fetchImpl: fetchImpl as never
        });

        const result = await client.fetchMarkdown('rules');
        expect(everythingIn(result)).not.toContain(TOKEN);
        expect(everythingIn(result)).not.toContain('ECONNREFUSED');
    });

    it('sends the token in a header and never in a URL', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse('# Rules'));
        const client = createDocsClient({
            repo: REPO,
            documents: DOCS,
            token: TOKEN,
            fetchImpl: fetchImpl as never
        });

        await client.fetchMarkdown('rules');

        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).not.toContain(TOKEN);
        expect(url).toBe('https://api.github.com/repos/acme-guild/handbook/contents/handbook/rules.md');
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
        // The raw-content host does not accept a bearer token, so nothing that
        // would send one there is used when a token is configured.
        expect(url).not.toContain('raw.githubusercontent.com');
    });

    it('sends no credentials at all to the public raw host', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse('# Rules'));
        const client = createDocsClient({repo: REPO, documents: DOCS, fetchImpl: fetchImpl as never});

        await client.fetchMarkdown('rules');

        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('raw.githubusercontent.com');
        expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Accept']);
    });
});

describe('deployment states are not outages', () => {
    it('says not-configured when the API transport has no token', async () => {
        const fetchImpl = vi.fn();
        const client = createDocsClient({
            repo: REPO,
            documents: DOCS,
            transport: 'api',
            fetchImpl: fetchImpl as never
        });

        await expect(client.fetchMarkdown('rules')).resolves.toEqual({status: 'not-configured'});
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('treats a blank token as no token', async () => {
        const client = createDocsClient({repo: REPO, documents: DOCS, transport: 'api', token: '   '});
        await expect(client.fetchMarkdown('rules')).resolves.toEqual({status: 'not-configured'});
    });
});

describe('the catalogue gate runs before the fetch, not after', () => {
    it('refuses an unlisted path without contacting GitHub', async () => {
        const fetchImpl = vi.fn();
        const client = createDocsClient({repo: REPO, documents: DOCS, fetchImpl: fetchImpl as never});

        for (const target of ['secrets.md', '../../etc/passwd', 'infrastructure/main.tf', 'nope', '']) {
            await expect(client.fetchMarkdown(target), target).resolves.toEqual({status: 'not-listed'});
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('publishes nothing when the catalogue is configured but empty', async () => {
        const fetchImpl = vi.fn();
        const client = createDocsClient({repo: REPO, documents: [], fetchImpl: fetchImpl as never});

        expect(client.documents).toEqual([]);
        await expect(client.fetchMarkdown('rules')).resolves.toEqual({status: 'not-listed'});
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('serves any valid path when no catalogue is configured at all', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse('anything'));
        const client = createDocsClient({repo: REPO, fetchImpl: fetchImpl as never});

        await expect(client.fetchMarkdown('whatever/doc.md')).resolves.toEqual({
            status: 'ok',
            markdown: 'anything'
        });
        // Still not a traversal, though: an unsafe path is not a path.
        await expect(client.fetchMarkdown('../../etc/passwd')).resolves.toEqual({status: 'not-listed'});
    });
});

describe('the rest of the client surface', () => {
    const client = createDocsClient({repo: 'https://github.com/acme-guild/handbook.git', documents: DOCS});

    it('normalises the repository it was configured with', () => {
        expect(client.repo).toBe(REPO);
        expect(client.ref).toBe('HEAD');
    });

    it('exposes the catalogue in configured order', () => {
        expect(client.documents.map((entry) => entry.slug)).toEqual(['rules', 'getting-started']);
        expect(client.entryForPath('handbook/rules.md')?.title).toBe('Rules');
    });

    it('builds the URLs a page needs', () => {
        expect(client.webUrl('rules')).toBe('https://github.com/acme-guild/handbook/blob/HEAD/handbook/rules.md');
        expect(client.rawUrl('rules')).toBe(
            'https://raw.githubusercontent.com/acme-guild/handbook/HEAD/handbook/rules.md'
        );
        expect(client.resolveLink('getting-started.md', 'handbook/rules.md')).toBe(
            'https://github.com/acme-guild/handbook/blob/HEAD/handbook/getting-started.md'
        );
    });

    it('throws on a URL builder for an unlisted document, since that is a programming mistake', () => {
        expect(() => client.webUrl('secrets.md')).toThrowError(/not a published document/);
    });
});
