// @kingdom-community/github-docs — the read half.
//
// Fetches markdown out of a GitHub repository so a site can render it, under
// two rules: failure is a value rather than an exception, and nothing upstream
// is ever quoted back.

export {
    createDocsClient,
    fetchApiMarkdown,
    fetchRawMarkdown,
    DEFAULT_MAX_DOCUMENT_BYTES,
    DEFAULT_TIMEOUT_MS,
    type DocsClient,
    type DocsClientConfig,
    type MarkdownFetch,
    type Transport
} from './client.js';

export {
    entryForPath,
    entryForSlug,
    isSafeDocPath,
    parseCatalogue,
    slugForPath,
    titleForSlug,
    type DocEntry,
    type DocEntryInput
} from './catalogue.js';

export {parseRepoSlug, releasesUrl, repoWebUrl, requireRepoSlug} from './repo.js';

export {
    blobUrl,
    contentsApiUrl,
    encodeDocPath,
    isSelfContainedTarget,
    rawUrl,
    resolveDocLink,
    resolveRepoPath,
    DEFAULT_REF
} from './urls.js';

export {
    isExternalUrl,
    safeImageUrl,
    safeLinkUrl,
    ALLOWED_IMAGE_SCHEMES,
    ALLOWED_LINK_SCHEMES
} from './markdownUrl.js';
