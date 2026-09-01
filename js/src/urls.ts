// Where a document lives: the plain-text URL this package fetches, the URL a
// human is sent to when the fetch fails, and the rewrite that keeps links
// inside a fetched document pointing somewhere useful.
//
// Pure and dependency-free. Every function takes the repository slug as an
// argument.

import {repoWebUrl, requireRepoSlug} from './repo.js';

/**
 * The default git ref.
 *
 * `HEAD` resolves to whatever the repository's default branch is called, so
 * nothing here has to know whether that is `main`, `master` or something a
 * community picked for itself. Both github.com and raw.githubusercontent.com
 * accept it.
 */
export const DEFAULT_REF = 'HEAD';

// A path inside the repository, encoded the way a URL needs while leaving the
// separators alone. `encodeURIComponent` on the whole path would escape the
// slashes and ask GitHub for one long filename.
export const encodeDocPath = (path: string): string =>
    path.split('/').map(encodeURIComponent).join('/');

const tidyPath = (path: string): string => path.trim().replace(/^\/+/, '');

/** The plain-text URL of a document, for fetching. */
export const rawUrl = (repo: string, path: string, ref: string = DEFAULT_REF): string =>
    `https://raw.githubusercontent.com/${requireRepoSlug(repo)}/${encodeURIComponent(ref)}/${encodeDocPath(tidyPath(path))}`;

/** The document as a human reads it on GitHub. */
export const blobUrl = (repo: string, path: string, ref: string = DEFAULT_REF): string =>
    `${repoWebUrl(repo)}/blob/${encodeURIComponent(ref)}/${encodeDocPath(tidyPath(path))}`;

/** The GitHub Contents API endpoint for a document. */
export const contentsApiUrl = (
    repo: string,
    path: string,
    ref: string = DEFAULT_REF,
    apiBase: string = 'https://api.github.com'
): string => {
    const base = apiBase.replace(/\/+$/, '');
    const url = `${base}/repos/${requireRepoSlug(repo)}/contents/${encodeDocPath(tidyPath(path))}`;
    // `HEAD` is the Contents API's own default, so it is left off rather than
    // sent as a literal ref the API would have to resolve as a branch name.
    return ref === DEFAULT_REF ? url : `${url}?ref=${encodeURIComponent(ref)}`;
};

/**
 * A link target that already says where it goes: an absolute URL (`https:`,
 * `mailto:`), a protocol-relative one (`//host/path`), or an in-page anchor
 * (`#rules`). Everything else in a document written for GitHub resolves
 * against the repository.
 */
export const isSelfContainedTarget = (href: string): boolean =>
    href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href);

/**
 * Rewrite a link found inside a fetched document so it still goes where its
 * author meant.
 *
 * `[Rules](rules.md)` works on GitHub because the document is read from inside
 * the repository. Rendered on a website at `/docs/getting-started`, the browser
 * would resolve that against the site and 404. Relative targets are therefore
 * pointed back at the source repository on the same ref, with any `#fragment`
 * carried along untouched. Self-contained targets are returned unchanged.
 *
 * `fromPath` is the path of the document the link was found in, so
 * document-relative targets resolve against its directory the way they do on
 * GitHub. Omit it for a repository whose documents all sit at the root.
 */
export const resolveDocLink = (
    repo: string,
    href: string,
    options: {fromPath?: string; ref?: string} = {}
): string => {
    if (href === '' || isSelfContainedTarget(href)) {
        return href;
    }
    const ref = options.ref ?? DEFAULT_REF;
    const [target, ...fragmentParts] = href.split('#');
    const fragment = fragmentParts.length > 0 ? `#${fragmentParts.join('#')}` : '';
    if (target === '') {
        return href;
    }
    const resolved = resolveRepoPath(options.fromPath ?? '', target);
    if (resolved === null) {
        // The link climbs out of the repository. There is nothing above the
        // repository root to point at, so it is left as written rather than
        // turned into a URL that is confidently wrong.
        return href;
    }
    return `${blobUrl(repo, resolved, ref)}${fragment}`;
};

/**
 * Resolve a relative path against the directory of the document containing it,
 * the way a POSIX path resolves. Returns null if it escapes the repository
 * root — which is a link that was already broken on GitHub.
 */
export const resolveRepoPath = (fromPath: string, href: string): string | null => {
    const base = href.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
    const segments = [...base, ...href.replace(/^\//, '').split('/')];
    const resolved: string[] = [];
    for (const segment of segments) {
        if (segment === '' || segment === '.') {
            continue;
        }
        if (segment === '..') {
            if (resolved.length === 0) {
                return null;
            }
            resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    return resolved.length === 0 ? null : resolved.join('/');
};
