# Security Policy

This app stores HRIS session cookies in a local SQLite database under `data/`.

Before pushing to GitHub:

- Do not commit `data/`, `.env`, browser captures, screenshots, or real credentials.
- Rotate any HRIS password or session token that may have been committed accidentally.
- Keep the repository private unless the HRIS owner has approved publishing the integration details.

Report security issues privately to the repository owner.
