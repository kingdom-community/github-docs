# github-docs

Run your community's documentation out of a GitHub repository. This repo will
ship two packages that share one idea: the docs live as markdown in a git repo,
the website reads them, and edits land as pull requests. `js/` will hold
`@kingdom-community/github-docs`, a TypeScript reader that fetches markdown for
rendering and never lets an upstream failure become a 5xx or leak a token.
`python/` will hold `github-docs`, a stdlib-only writer that commits an edit to
a per-file branch and opens (or reuses) a pull request for it.
