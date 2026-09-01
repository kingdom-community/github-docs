// The catalogue: which documents a site is willing to publish, what URL each
// one lives at, and nothing else.
//
// Pure and dependency-free — nothing here reads the environment or touches the
// network. The raw configuration value arrives as an argument, read once by
// whatever constructs the client. Keeping it pure is what lets these rules be
// unit-tested exhaustively, which matters more here than anywhere else in the
// package: a catalogue is a security boundary as much as a convenience.
//
// It is a deny-by-default gate. A path not named in the catalogue is never
// fetched, never rendered, and never appears in an index or a sitemap; the
// check happens before the fetch, not after, so a site cannot be made to pull
// an unlisted file into memory at all.
//
// A catalogue is also cheaper than a directory listing: `/docs/<slug>` answers
// 404 for anything unknown without asking GitHub, which is one fewer upstream
// call and one fewer way to fail. That is worth doing for a public repository
// too, not only for a private one.

export interface DocEntry {
    /** The URL segment: `/docs/<slug>`. */
    slug: string;
    /**
     * The path in the repository, exactly as the catalogue named it. This is
     * the only string ever sent to GitHub.
     */
    path: string;
    /** A display title. Derived from the filename unless one was given. */
    title: string;
    /** One line for an index page or a meta description. Optional. */
    summary?: string;
}

/**
 * A catalogue entry as a caller may write it: a bare path, or a path with any
 * of the derived fields overridden.
 */
export type DocEntryInput = string | ({path: string} & Partial<Omit<DocEntry, 'path'>>);

// A path this package is willing to send to GitHub. Deliberately narrow: lower-
// and upper-case letters, digits, dot, dash, underscore and the separating
// slash. Anything else — a `..` segment, a leading slash, a backslash, a
// scheme, a query string, whitespace — is not a path in a repository and is
// dropped rather than escaped, because a catalogue entry that needs escaping is
// a typo or an attack and neither should reach the network.
const SAFE_DOC_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export const isSafeDocPath = (path: string): boolean =>
    SAFE_DOC_PATH.test(path) &&
    !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');

/** `handbook/the-rules.md` -> `the-rules`. */
export const slugForPath = (path: string): string => {
    const base = path.split('/').pop() ?? path;
    return base
        .replace(/\.mdx?$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
};

/**
 * `the-rules` -> `The Rules`. A filename is not a title, but it is an honest
 * approximation of one, and it is what the author typed.
 *
 * The alternative — fetching every catalogued file to read its first heading —
 * turns one index request into N upstream calls and N ways to fail. The
 * document's own heading appears once the page opens, which is soon enough.
 */
export const titleForSlug = (slug: string): string =>
    slug
        .split('-')
        .filter((word) => word !== '')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

/**
 * Build a catalogue.
 *
 * Accepts an array of entries, or a comma-separated string — the shape an
 * environment variable comes in. Order is preserved: it is the maintainer's
 * reading order, and there is no better one to invent.
 *
 * Unset, empty, or entirely unusable input yields an empty catalogue, which is
 * the "nothing is published" state rather than the "everything is published"
 * one. Unusable entries are dropped individually rather than throwing, so one
 * typo in a list of thirty does not take a site down.
 *
 * Two entries whose filenames slugify the same would fight over one URL; the
 * first wins and the second is dropped, because silently serving one document
 * at another's URL is the worse failure.
 */
export const parseCatalogue = (
    input: readonly DocEntryInput[] | string | undefined | null
): DocEntry[] => {
    const candidates: DocEntryInput[] =
        typeof input === 'string' ? input.split(',') : input ? [...input] : [];
    const entries: DocEntry[] = [];
    const seenSlugs = new Set<string>();
    for (const candidate of candidates) {
        const given = typeof candidate === 'string' ? {path: candidate} : candidate;
        const path = (given.path ?? '').trim();
        if (path === '' || !isSafeDocPath(path)) {
            continue;
        }
        const slug = (given.slug ?? slugForPath(path)).trim();
        if (slug === '' || seenSlugs.has(slug)) {
            continue;
        }
        seenSlugs.add(slug);
        const entry: DocEntry = {slug, path, title: given.title ?? titleForSlug(slug)};
        if (given.summary !== undefined) {
            entry.summary = given.summary;
        }
        entries.push(entry);
    }
    return entries;
};

/**
 * The catalogue lookup, and the only way a path should reach the fetch layer.
 * An unknown slug returns null, the page answers 404, and nothing is sent to
 * GitHub.
 */
export const entryForSlug = (entries: readonly DocEntry[], slug: string): DocEntry | null =>
    entries.find((entry) => entry.slug === slug) ?? null;

/** The same lookup by repository path rather than by slug. */
export const entryForPath = (entries: readonly DocEntry[], path: string): DocEntry | null =>
    entries.find((entry) => entry.path === path) ?? null;
