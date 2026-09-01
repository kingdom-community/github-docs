"""github-docs -- land documentation edits in a GitHub repository as pull requests.

The write half of a pair. Its sibling, ``@kingdom-community/github-docs`` on
npm, reads the same repository for rendering. Between them: documentation lives
as markdown in git, a website renders it, and edits arrive as reviewable pull
requests rather than as direct pushes.
"""

from .client import (
    Document,
    DocumentSummary,
    GitHubDocsClient,
    GitHubDocsConfig,
    GitHubDocsError,
    SaveResult,
    slugify_path,
)

__all__ = [
    "Document",
    "DocumentSummary",
    "GitHubDocsClient",
    "GitHubDocsConfig",
    "GitHubDocsError",
    "SaveResult",
    "slugify_path",
    "__version__",
]

__version__ = "0.1.0"
