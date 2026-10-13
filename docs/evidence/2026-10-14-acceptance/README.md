# Acceptance update — October 14, 2026

See `summary.json` for exact commands, reports and what each test proves. The GitHub suite contains two scenarios with many HTTP/Git/browser assertions, not a live OAuth flow. The failure logs show defects reproduced before their fixes. The database migration is live; test source repositories and sessions are local fixtures.

The previous benchmark and provider smoke remain historical evidence. The new bounded local native Git comparison is stored separately and validates both final trees. Publication/cancellation and compressed Git negotiation corrections have fresh acceptance reports. Production GitHub OAuth and a single-repository live import remain pending.
