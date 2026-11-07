# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**. Only the maintainer can see the report.

Include:

- what the problem is and which part of the application it affects (API endpoint, worker, UI page, configuration);
- steps to reproduce it, with example requests if possible;
- what an attacker could do with it;
- the commit or version you tested.

The maintainer aims to acknowledge reports within 7 days. Once a fix is ready, it is merged with a description of the issue, and you are credited unless you prefer not to be. Please give the fix time to land before disclosing the problem publicly.

This is a personal project with no hosted instance. Reports are about the code in this repository; there is no production deployment to test against, and there is no bug bounty.

## Supported versions

There are no releases yet. Fixes go to the `main` branch only.

## How the application protects itself

The full table, with the code location of each control, is in [docs/architecture.md](docs/architecture.md#security). In summary:

| Area                  | Control                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords             | scrypt with a per-user salt; same response and similar timing for unknown email and wrong password                                                   |
| Sessions              | random token in an `httpOnly`, `SameSite=Lax` cookie; only its SHA-256 hash is stored; logout deletes it server-side                                 |
| CSRF                  | synchronizer token in an `X-CSRF-Token` header on every state-changing request                                                                       |
| CI API keys           | shown once; stored as SHA-256 hashes; scoped to one project; revocable                                                                               |
| Tenant isolation      | every query is scoped to the project owner; other users' resources return 404 (tested)                                                               |
| Provider API keys     | AES-256-GCM encrypted at rest with `ENCRYPTION_KEY`; never returned by the API                                                                       |
| SSRF                  | provider URLs that resolve to private, loopback or link-local addresses are refused unless `ALLOW_PRIVATE_PROVIDER_URLS=true`; redirects are refused |
| XSS                   | strict Content-Security-Policy; the UI never uses `innerHTML`; a browser test checks that a `<script>` in model output does not run                  |
| Brute force and abuse | Redis rate limits on login, signup and the CI API; per-provider rate limit on model calls                                                            |
| SQL injection         | Prisma queries and tagged-template raw SQL, both parameterised                                                                                       |
| Error responses       | unexpected errors return a generic message and a request id; details stay in the logs                                                                |
| Dependencies          | `npm audit --omit=dev --audit-level=high` runs in CI                                                                                                 |

## Known limitations

- **DNS rebinding.** The SSRF check resolves the provider's hostname, and `fetch` resolves it again, so a hostile DNS server could answer differently the second time. Closing this needs the connection pinned to the checked address.
- **No `trust proxy` configuration.** Behind a reverse proxy, every client appears to come from the proxy, so rate limits are shared by all users. Configure it before deploying behind one.
- **No password reset, email verification, multi-factor authentication or account lockout.** Login is protected only by its rate limit.
- **The seeded demo password is public.** `npm run db:seed` is for local development; never run it against a reachable deployment.
- **`ENCRYPTION_KEY` has no rotation procedure.** Changing it makes stored provider keys unreadable.
- **No external security review** has been done.
