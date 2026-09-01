import {describe, expect, it} from 'vitest';

import {
    entryForPath,
    entryForSlug,
    isSafeDocPath,
    parseCatalogue,
    slugForPath,
    titleForSlug
} from '../src/catalogue';

describe('isSafeDocPath', () => {
    it('accepts an ordinary path in a repository', () => {
        expect(isSafeDocPath('handbook/the-rules.md')).toBe(true);
        expect(isSafeDocPath('README.md')).toBe(true);
        expect(isSafeDocPath('a/b/c_1.2.md')).toBe(true);
    });

    it('refuses anything that is not one, rather than escaping it', () => {
        for (const path of [
            '../secrets.md',
            'handbook/../../etc/passwd',
            '/handbook/rules.md',
            'handbook//rules.md',
            'handbook\\rules.md',
            'handbook/rules.md?ref=main',
            'https://example.com/rules.md',
            'handbook/the rules.md',
            './rules.md',
            ''
        ]) {
            expect(isSafeDocPath(path), path).toBe(false);
        }
    });
});

describe('slugForPath and titleForSlug', () => {
    it('turns a path into a URL segment', () => {
        expect(slugForPath('handbook/The Rules.md')).toBe('the-rules');
        expect(slugForPath('handbook/getting-started.mdx')).toBe('getting-started');
        expect(slugForPath('rules.md')).toBe('rules');
    });

    it('turns a slug into an honest approximation of a title', () => {
        expect(titleForSlug('getting-started')).toBe('Getting Started');
        expect(titleForSlug('rules')).toBe('Rules');
        expect(titleForSlug('')).toBe('');
    });
});

describe('parseCatalogue', () => {
    it('reads the comma-separated string an environment variable comes in', () => {
        expect(parseCatalogue('handbook/rules.md, handbook/getting-started.md')).toEqual([
            {slug: 'rules', path: 'handbook/rules.md', title: 'Rules'},
            {slug: 'getting-started', path: 'handbook/getting-started.md', title: 'Getting Started'}
        ]);
    });

    it('preserves the order it was given', () => {
        expect(parseCatalogue(['c.md', 'a.md', 'b.md']).map((entry) => entry.slug)).toEqual(['c', 'a', 'b']);
    });

    // Deny-by-default. An operator who has not filled the list in publishes
    // nothing, rather than publishing the whole repository by accident.
    it('treats unset, empty and unusable input as "nothing is published"', () => {
        expect(parseCatalogue(undefined)).toEqual([]);
        expect(parseCatalogue(null)).toEqual([]);
        expect(parseCatalogue('')).toEqual([]);
        expect(parseCatalogue('   ,  ,')).toEqual([]);
        expect(parseCatalogue(['../escape.md', '/absolute.md'])).toEqual([]);
    });

    it('drops one bad entry without taking the rest of the list down', () => {
        expect(parseCatalogue(['handbook/rules.md', '../escape.md', 'handbook/faq.md']).map((e) => e.slug))
            .toEqual(['rules', 'faq']);
    });

    // Serving one document at another's URL is the worse failure.
    it('keeps the first of two entries that would fight over one URL', () => {
        expect(parseCatalogue(['handbook/rules.md', 'archive/rules.md'])).toEqual([
            {slug: 'rules', path: 'handbook/rules.md', title: 'Rules'}
        ]);
    });

    it('lets a caller override the derived slug, title and summary', () => {
        expect(
            parseCatalogue([
                {path: 'handbook/getting-started.md', slug: 'start', title: 'Start here', summary: 'Your first hour.'}
            ])
        ).toEqual([
            {
                slug: 'start',
                path: 'handbook/getting-started.md',
                title: 'Start here',
                summary: 'Your first hour.'
            }
        ]);
    });
});

describe('lookups', () => {
    const entries = parseCatalogue(['handbook/rules.md', 'handbook/faq.md']);

    it('resolves a known slug and refuses an unknown one', () => {
        expect(entryForSlug(entries, 'rules')?.path).toBe('handbook/rules.md');
        expect(entryForSlug(entries, 'nope')).toBeNull();
        expect(entryForSlug(entries, '')).toBeNull();
        expect(entryForSlug(entries, '../rules')).toBeNull();
    });

    it('resolves by repository path too', () => {
        expect(entryForPath(entries, 'handbook/faq.md')?.slug).toBe('faq');
        expect(entryForPath(entries, 'secrets.md')).toBeNull();
    });
});
