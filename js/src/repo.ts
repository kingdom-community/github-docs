// Repository identity: turning whatever a human typed into the `owner/repo`
// slug the rest of this package sends to GitHub, and back into URLs a reader
// can open.
//
// Pure and dependency-free: nothing here reads the environment or touches the
// network. The slug arrives as an argument, read once by whatever configures
// the client. Keeping it pure is what lets these rules be unit-tested
// exhaustively.

// A repository slug that GitHub will accept. Owner and repository names are
// letters, digits, dot, dash and underscore; anything else — a path segment, a
// query string, whitespace, a `..` — is not a slug and is refused rather than
// escaped, because a slug that needs escaping is a typo or an attack and
// neither should reach the network.
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Strip the wrapping a human leaves behind: surrounding whitespace, leading and
// trailing slashes, a trailing `.git`. These values usually come from an
// environment variable someone typed by hand, and none of that wrapping changes
// which repository is meant.
const tidy = (value: string): string =>
    value.trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');

/**
 * The `owner/repo` slug for a repository, or null when the input is not one.
 *
 * Accepts a bare slug (`acme/handbook`) or a GitHub URL in any of the shapes
 * people paste — `https://github.com/acme/handbook`, with or without a
 * trailing `.git`, `/tree/main`, a fragment or a query string.
 */
export const parseRepoSlug = (value: string | undefined | null): string | null => {
    const raw = (value ?? '').trim();
    if (raw === '') {
        return null;
    }
    const fromUrl = /github\.com\/([^/#?]+)\/([^/#?]+)/i.exec(raw);
    const candidate = fromUrl ? `${fromUrl[1]}/${fromUrl[2]}` : raw;
    const slug = tidy(candidate);
    return SLUG_PATTERN.test(slug) ? slug : null;
};

/**
 * The same as {@link parseRepoSlug}, but throws on an unusable value.
 *
 * This is the one place in the package that throws, and it does so at
 * construction time rather than at fetch time: a misconfigured repository is a
 * deployment mistake to fix, not an upstream outage to render a panel about.
 * Once a client exists, every later failure is a value.
 */
export const requireRepoSlug = (value: string | undefined | null): string => {
    const slug = parseRepoSlug(value);
    if (slug === null) {
        // The offending value is quoted here because it is the caller's own
        // configuration, not anything that came back from GitHub.
        throw new Error(`github-docs: ${JSON.stringify(value)} is not an "owner/repo" repository slug or GitHub URL`);
    }
    return slug;
};

/** `owner/repo` -> the repository's web URL. */
export const repoWebUrl = (repo: string): string => `https://github.com/${requireRepoSlug(repo)}`;

/** The repository's releases page. */
export const releasesUrl = (repo: string): string => `${repoWebUrl(repo)}/releases`;
