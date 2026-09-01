// The URL-scheme allowlist. Every URL a rendered markdown document is about to
// emit passes through here first.
//
// A document fetched from a git repository is authored content, and on a
// community site it is often authored by more than one person. These functions
// are the control that stops a markdown link from becoming script execution in
// a reader's browser.
//
// WHY THIS IS APPLIED TO THE RESOLVED URL AND NOT TO THE MARKDOWN SOURCE
//
// Validating the source misses reference-style links entirely. `[click](ref)`
// with `[ref]: javascript:alert(1)` defined two hundred lines below passes any
// check that reads the inline text, because at that point the href is the word
// `ref`. The only place that sees the URL the renderer is actually about to put
// in the DOM is the renderer's component override or link callback — so that is
// where this belongs, on the final resolved value, for BOTH `a` and `img`.
//
// WHY WHITESPACE AND CONTROL CHARACTERS ARE STRIPPED FIRST
//
// Browsers strip leading and trailing whitespace from URLs and remove tab, CR
// and LF from anywhere inside them before parsing. So `java\tscript:alert(1)`
// and ` javascript:alert(1)` are both live `javascript:` URLs in a browser, and
// both slip past a naive `startsWith('javascript:')`. Cleaning to what the
// browser will see and then validating THAT is the only order that is correct.
// The cleaned string is also what is returned, so the value checked is the value
// emitted rather than a second one that happens to look similar.
//
// WHAT IS ALLOWED
//
//   * `http:` and `https:` — ordinary links.
//   * `mailto:` — on links only. In an `src` it is meaningless.
//   * `#anchor` — in-page, on links only.
//   * anything with no scheme at all — relative, resolved against the site.
//
// Everything else is dropped: `javascript:` first among them, but also `data:`
// (a data URL can carry a whole HTML document), `vbscript:`, `file:` and every
// scheme nobody has thought of yet. The list is an allowlist rather than a
// blocklist for exactly that reason.

// Removes what a browser removes before parsing a URL: every C0 control
// character, DEL, and leading/trailing whitespace. Interior spaces are left
// alone — they cannot form a scheme, and a browser percent-encodes them.
const asBrowserWouldSee = (href: string): string =>
    href.replace(/[\u0000-\u001f\u007f]/g, '').trim();

// What the URL might mean once something else has decoded it.
//
// A markdown parser typically percent-encodes control characters before this
// code sees the href, so `java\tscript:alert(1)` can arrive here as
// `java%09script:alert(1)` — which has no scheme by the letter of the rule and
// would be waved through as a relative path. A browser reads it that way too,
// so it is inert TODAY. But it would be waved through for a reason that is a
// property of somebody else's encoder rather than of this allowlist, which is
// not a footing to stand a security control on.
//
// So the decision is made on a probe with those encodings removed, while the
// value RETURNED is the untouched cleaned one. Rejection is judged against the
// most dangerous reading; emission is never a string this function invented.
const probeOf = (href: string): string => href.replace(/%(0[0-9a-f]|1[0-9a-f]|20|7f)/gi, '');

// The scheme, lower-cased, or null when the value carries none. A URL with no
// scheme is relative and resolves against the current origin, which is safe by
// construction.
//
// The pattern is RFC 3986's: a scheme starts with a letter and continues with
// letters, digits, `+`, `-` and `.`. Anchored, so `/a:b` — a path containing a
// colon — is correctly read as having no scheme rather than as scheme `/a`.
const schemeOf = (href: string): string | null => {
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(href);
    return match ? match[1].toLowerCase() : null;
};

export const ALLOWED_LINK_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];
export const ALLOWED_IMAGE_SCHEMES: readonly string[] = ['http', 'https'];

/** A safe `href`, or null when the element must render as plain text instead. */
export const safeLinkUrl = (href: string | undefined | null): string | null => {
    const cleaned = asBrowserWouldSee(href ?? '');
    if (cleaned === '') {
        return null;
    }
    if (cleaned.startsWith('#')) {
        // In-page. A fragment cannot carry a scheme and cannot leave the page.
        return cleaned;
    }
    const scheme = schemeOf(probeOf(cleaned));
    if (scheme === null) {
        return cleaned;
    }
    return ALLOWED_LINK_SCHEMES.includes(scheme) ? cleaned : null;
};

/**
 * A safe `src`, or null. Narrower than a link: `mailto:` and `#anchor` are not
 * images, and admitting them would mean an `<img>` with a nonsense source rather
 * than no image at all.
 *
 * Note that an image embedded by URL is still a privacy leak — it discloses the
 * reader's IP address to whatever host is named — even when it is not an XSS
 * vector. Proxying images, or narrowing this to a set of known hosts, is a
 * decision for the site rather than for this package, and it is an `img-src`
 * change in the site's Content-Security-Policy as much as a change here.
 */
export const safeImageUrl = (src: string | undefined | null): string | null => {
    const cleaned = asBrowserWouldSee(src ?? '');
    if (cleaned === '' || cleaned.startsWith('#')) {
        return null;
    }
    const scheme = schemeOf(probeOf(cleaned));
    if (scheme === null) {
        return cleaned;
    }
    return ALLOWED_IMAGE_SCHEMES.includes(scheme) ? cleaned : null;
};

/**
 * Whether a resolved URL leaves the current site, and therefore needs
 * `target="_blank"` and `rel="noopener noreferrer"`. Relative URLs and in-page
 * anchors do not.
 */
export const isExternalUrl = (href: string): boolean => /^(https?:)?\/\//i.test(href.trim());
