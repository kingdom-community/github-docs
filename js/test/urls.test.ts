import {describe, expect, it} from 'vitest';

import {parseRepoSlug, releasesUrl, repoWebUrl, requireRepoSlug} from '../src/repo';
import {
    blobUrl,
    contentsApiUrl,
    isSelfContainedTarget,
    rawUrl,
    resolveDocLink,
    resolveRepoPath
} from '../src/urls';

const REPO = 'acme-guild/handbook';

describe('parseRepoSlug', () => {
    it('accepts a bare slug', () => {
        expect(parseRepoSlug('acme-guild/handbook')).toBe(REPO);
    });

    it('tolerates the slashes and spaces a human puts in an environment variable', () => {
        expect(parseRepoSlug('  /acme-guild/handbook/ ')).toBe(REPO);
    });

    it('accepts the URL shapes people actually paste', () => {
        expect(parseRepoSlug('https://github.com/acme-guild/handbook')).toBe(REPO);
        expect(parseRepoSlug('https://github.com/acme-guild/handbook.git')).toBe(REPO);
        expect(parseRepoSlug('https://github.com/acme-guild/handbook/tree/main/docs')).toBe(REPO);
        expect(parseRepoSlug('http://GitHub.com/acme-guild/handbook?tab=readme')).toBe(REPO);
    });

    it('returns null rather than guessing', () => {
        for (const value of ['', '   ', 'handbook', 'acme-guild/', '/handbook', 'a/b/c', '../../etc', undefined, null]) {
            expect(parseRepoSlug(value as string | undefined | null), String(value)).toBeNull();
        }
    });

    // The one place this package throws, and it throws on the caller's own
    // configuration rather than on anything upstream.
    it('throws from requireRepoSlug, quoting only the value the caller passed', () => {
        expect(() => requireRepoSlug('not a repo')).toThrowError(/"not a repo"/);
    });
});

describe('repository URLs', () => {
    it('builds the web and releases URLs', () => {
        expect(repoWebUrl(REPO)).toBe('https://github.com/acme-guild/handbook');
        expect(releasesUrl('https://github.com/acme-guild/handbook')).toBe(
            'https://github.com/acme-guild/handbook/releases'
        );
    });
});

describe('document URLs', () => {
    it('builds the raw URL the site fetches', () => {
        expect(rawUrl(REPO, 'handbook/rules.md')).toBe(
            'https://raw.githubusercontent.com/acme-guild/handbook/HEAD/handbook/rules.md'
        );
    });

    it('builds the URL a reader is sent to when the fetch fails', () => {
        expect(blobUrl(REPO, 'handbook/rules.md')).toBe(
            'https://github.com/acme-guild/handbook/blob/HEAD/handbook/rules.md'
        );
    });

    it('honours an explicit ref', () => {
        expect(rawUrl(REPO, 'rules.md', 'v2')).toBe(
            'https://raw.githubusercontent.com/acme-guild/handbook/v2/rules.md'
        );
        expect(blobUrl(REPO, 'rules.md', 'v2')).toBe('https://github.com/acme-guild/handbook/blob/v2/rules.md');
    });

    it('encodes the path without eating its separators', () => {
        expect(rawUrl(REPO, 'a b/c&d.md')).toBe(
            'https://raw.githubusercontent.com/acme-guild/handbook/HEAD/a%20b/c%26d.md'
        );
    });

    it('leaves HEAD off the Contents API call, since that is its own default', () => {
        expect(contentsApiUrl(REPO, 'handbook/rules.md')).toBe(
            'https://api.github.com/repos/acme-guild/handbook/contents/handbook/rules.md'
        );
        expect(contentsApiUrl(REPO, 'handbook/rules.md', 'v2')).toBe(
            'https://api.github.com/repos/acme-guild/handbook/contents/handbook/rules.md?ref=v2'
        );
    });
});

describe('resolveRepoPath', () => {
    it('resolves against the directory of the document containing the link', () => {
        expect(resolveRepoPath('handbook/getting-started.md', 'rules.md')).toBe('handbook/rules.md');
        expect(resolveRepoPath('handbook/getting-started.md', './rules.md')).toBe('handbook/rules.md');
        expect(resolveRepoPath('handbook/getting-started.md', '../faq.md')).toBe('faq.md');
        expect(resolveRepoPath('handbook/getting-started.md', '/docs/rules.md')).toBe('docs/rules.md');
    });

    it('refuses a link that climbs out of the repository', () => {
        expect(resolveRepoPath('handbook/getting-started.md', '../../etc/passwd')).toBeNull();
    });
});

describe('resolveDocLink', () => {
    it('leaves a link that already says where it goes alone', () => {
        expect(resolveDocLink(REPO, '#commands')).toBe('#commands');
        expect(resolveDocLink(REPO, 'https://example.test/x')).toBe('https://example.test/x');
        expect(resolveDocLink(REPO, '//example.test/x')).toBe('//example.test/x');
        expect(resolveDocLink(REPO, 'mailto:staff@example.test')).toBe('mailto:staff@example.test');
        expect(resolveDocLink(REPO, '')).toBe('');
    });

    // Without this, `[Rules](rules.md)` inside getting-started.md resolves
    // against the site rendering it and 404s.
    it('points a relative link back at the source repository', () => {
        expect(resolveDocLink(REPO, 'rules.md')).toBe(
            'https://github.com/acme-guild/handbook/blob/HEAD/rules.md'
        );
        expect(resolveDocLink(REPO, './rules.md')).toBe(
            'https://github.com/acme-guild/handbook/blob/HEAD/rules.md'
        );
        expect(resolveDocLink(REPO, '/docs/rules.md')).toBe(
            'https://github.com/acme-guild/handbook/blob/HEAD/docs/rules.md'
        );
    });

    it('resolves against the containing document when one is given', () => {
        expect(resolveDocLink(REPO, 'rules.md', {fromPath: 'handbook/getting-started.md'})).toBe(
            'https://github.com/acme-guild/handbook/blob/HEAD/handbook/rules.md'
        );
    });

    it('carries a fragment along untouched', () => {
        expect(resolveDocLink(REPO, 'rules.md#no-griefing')).toBe(
            'https://github.com/acme-guild/handbook/blob/HEAD/rules.md#no-griefing'
        );
    });

    it('leaves a link that climbs out of the repository as written', () => {
        expect(resolveDocLink(REPO, '../../etc/passwd', {fromPath: 'handbook/a.md'})).toBe('../../etc/passwd');
    });
});

describe('isSelfContainedTarget', () => {
    it('recognises the three shapes that need no rewriting', () => {
        expect(isSelfContainedTarget('#a')).toBe(true);
        expect(isSelfContainedTarget('//example.test')).toBe(true);
        expect(isSelfContainedTarget('https://example.test')).toBe(true);
        expect(isSelfContainedTarget('rules.md')).toBe(false);
        expect(isSelfContainedTarget('/docs/rules.md')).toBe(false);
    });
});
