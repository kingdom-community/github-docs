import {describe, expect, it} from 'vitest';

import {isExternalUrl, safeImageUrl, safeLinkUrl} from '../src/markdownUrl';

// The URL-scheme allowlist, on its own. This file is about the decision itself,
// and specifically about the ways a `javascript:` URL gets past a check that
// looks obviously correct.

describe('safeLinkUrl', () => {
    it('allows the four things a link may be', () => {
        expect(safeLinkUrl('https://example.com/page')).toBe('https://example.com/page');
        expect(safeLinkUrl('http://example.com')).toBe('http://example.com');
        expect(safeLinkUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com');
        expect(safeLinkUrl('#rules')).toBe('#rules');
        expect(safeLinkUrl('/handbook/general')).toBe('/handbook/general');
        expect(safeLinkUrl('../sibling')).toBe('../sibling');
    });

    it('refuses every scheme that is not on the list', () => {
        for (const href of [
            'javascript:alert(1)',
            // A data URL can carry a whole HTML document, which is why the list
            // is an allowlist and not "block javascript:".
            'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
            'vbscript:msgbox(1)',
            'file:///etc/passwd',
            'about:blank',
            'blob:https://example.com/1234'
        ]) {
            expect(safeLinkUrl(href), href).toBeNull();
        }
    });

    it('refuses the spellings a browser still executes', () => {
        // Every one of these is a live javascript: URL in a browser, and every
        // one of them survives `href.startsWith('javascript:')`. Browsers strip
        // leading and trailing whitespace and remove tab, CR and LF from
        // anywhere inside a URL before parsing it — so the check has to run on
        // the cleaned string, which is what this asserts.
        for (const href of [
            'JavaScript:alert(1)',
            'JAVASCRIPT:alert(1)',
            '  javascript:alert(1)  ',
            '\tjavascript:alert(1)',
            '\njavascript:alert(1)',
            'java\tscript:alert(1)',
            'java\nscript:alert(1)',
            'java\rscript:alert(1)',
            'jav\u0000ascript:alert(1)',
            '\u0001javascript:alert(1)',
            'javascript\u0000:alert(1)'
        ]) {
            expect(safeLinkUrl(href), JSON.stringify(href)).toBeNull();
        }
    });

    it('refuses the percent-encoded spellings a decoder downstream might revive', () => {
        // The probe is what makes these fail. They are inert in a browser
        // today, but only because of somebody else's encoder.
        for (const href of ['java%09script:alert(1)', 'java%0Ascript:alert(1)', '%20javascript:alert(1)']) {
            expect(safeLinkUrl(href), href).toBeNull();
        }
    });

    it('returns the CLEANED value, so what is checked is what is emitted', () => {
        // If the padded value were returned instead, the check would have run
        // on one string and the DOM would have received another.
        expect(safeLinkUrl('  https://example.com/a  ')).toBe('https://example.com/a');
        expect(safeLinkUrl('https://exam\tple.com/a')).toBe('https://example.com/a');
    });

    it('reads a colon in a path as a path rather than as a scheme', () => {
        // RFC 3986: a scheme starts with a LETTER. `/a:b` and `./a:b` are
        // relative paths, and refusing them would drop legitimate links for no
        // gain.
        expect(safeLinkUrl('/notes/a:b')).toBe('/notes/a:b');
        expect(safeLinkUrl('./a:b')).toBe('./a:b');
        expect(safeLinkUrl('9lives:x')).toBe('9lives:x');
    });

    it('treats nothing as nothing', () => {
        expect(safeLinkUrl('')).toBeNull();
        expect(safeLinkUrl('   ')).toBeNull();
        expect(safeLinkUrl(undefined)).toBeNull();
        expect(safeLinkUrl(null)).toBeNull();
    });
});

describe('safeImageUrl', () => {
    it('is narrower than a link', () => {
        expect(safeImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
        expect(safeImageUrl('/static/a.png')).toBe('/static/a.png');
        // Neither is an image. Admitting them would mean an <img> with a
        // nonsense source rather than no image at all.
        expect(safeImageUrl('mailto:someone@example.com')).toBeNull();
        expect(safeImageUrl('#anchor')).toBeNull();
    });

    it('refuses the same hostile schemes, including on an attribute a href-only rule would miss', () => {
        for (const src of [
            'javascript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'DATA:image/svg+xml,<svg onload=alert(1)>',
            ' java\tscript:alert(1)'
        ]) {
            expect(safeImageUrl(src), src).toBeNull();
        }
    });
});

describe('isExternalUrl', () => {
    it('is true only for something that leaves this site', () => {
        expect(isExternalUrl('https://example.com')).toBe(true);
        expect(isExternalUrl('http://example.com')).toBe(true);
        expect(isExternalUrl('//example.com/a')).toBe(true);

        expect(isExternalUrl('/handbook')).toBe(false);
        expect(isExternalUrl('#anchor')).toBe(false);
        expect(isExternalUrl('mailto:a@b.c')).toBe(false);
    });
});
