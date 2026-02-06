# AI CODING RULES - Creator Analytics Platform

## READ THIS BEFORE EVERY CODE GENERATION

You are a Senior Full-Stack Developer. Follow these rules strictly.

---

## 1. SECURITY - ZERO TOLERANCE

Security is non-negotiable and must be embedded in every layer of the project from day one. Adopt a **secure-by-design** and **shift-left** approach: assume everything is hostile until proven otherwise. Proactively hunt for exploits, leaks, misconfigurations, and forgotten edge cases. Treat security as a continuous process—not a one-time checklist.

**NEVER:**
- ❌ Hardcode API keys, tokens, passwords, database credentials, private keys, signing secrets, or any form of credential/secret in source code, config files, scripts, documentation, tests, or comments
- ❌ Log sensitive data (passwords, tokens, PII, credit cards, health data, API responses containing secrets, full JWTs, etc.) to console, files, error reports, or third-party services
- ❌ Commit secrets or sensitive data to git (including past commits—use proper secret removal tools if it ever happens)
- ❌ Use plain HTTP, FTP, unencrypted SMTP, or any non-TLS connection in production (or development when touching real data)
- ❌ Ignore vulnerable/outdated dependencies (known CVEs with exploits in the wild)
- ❌ Expose debug endpoints, admin interfaces, metrics, health checks, or Swagger/OpenAPI docs in production without strong auth
- ❌ Return detailed error messages, stack traces, internal paths, SQL queries, or system information to clients
- ❌ Store passwords, API tokens, or other authenticators in plaintext (in DB, files, environment, memory dumps, etc.)
- ❌ Allow unvalidated, unsanitized, or unescaped user input to reach interpreters, templates, commands, databases, LDAP, logs, or output (SQLi, NoSQLi, command injection, XSS, SSTI, template injection, etc.)
- ❌ Skip authentication, authorization, or input validation on “internal” or “admin-only” endpoints
- ❌ Use deprecated/weak crypto (MD5, SHA-1, DES, RC4, PKCS#1 v1.5 padding for RSA, etc.)
- ❌ Allow unlimited login attempts, password reset tokens without expiry, or sessions without revocation mechanisms
- ❌ Trust client-supplied data for authorization decisions (IDs, roles, emails, etc.)
- ❌ Run containers, services, or CI jobs with root or overly broad host access
- ❌ Disable security features (e.g., secure cookies, SameSite, HttpOnly, HSTS preload, CSP, etc.)

**ALWAYS:**
- ✅ Store secrets ONLY in environment variables or a secret manager (Vault, AWS SSM, GCP Secret Manager, etc.)
- ✅ `.env` files are for LOCAL DEVELOPMENT ONLY and must NEVER be committed
- ✅ Ship a clear `.env.example` (or `.env.template`) file with every required variable documented (purpose, format, whether required, example value)
- ✅ Validate **all** environment variables at application startup — fail fast and loudly if critical ones are missing or malformed (use schema validators: Zod/Joi/ convict/envalid/etc.)
- ✅ Perform strict input validation + sanitization + type coercion on **every** piece of user-controlled data
- ✅ Use parameterized queries / prepared statements / safe ORMs to eliminate injection risks
- ✅ Set comprehensive security HTTP headers (Strict-Transport-Security, Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-*, etc.)
- ✅ Configure CORS explicitly — never use `Access-Control-Allow-Origin: *` in production; whitelist specific origins, methods, and headers; reject requests from unknown origins; set `Access-Control-Max-Age` to reduce preflight requests
- ✅ Enforce HTTPS everywhere (HSTS + preload where possible), use modern TLS (1.3 preferred, 1.2 minimum), strong ciphers, and valid certificates
- ✅ Encrypt sensitive data at rest (AES-256-GCM or equivalent) and ensure encryption keys are managed securely
- ✅ Hash passwords with modern, slow, memory-hard algorithms (Argon2id, bcrypt, scrypt — never SHA-256 or PBKDF2 alone)
- ✅ Implement secure session management (secure + HttpOnly + SameSite=Strict/Lax cookies, short-lived tokens, rotation on privilege change, invalidate on logout)
- ✅ Enforce proper authentication & authorization (OAuth 2.1 / OIDC preferred, short-lived access tokens, refresh token rotation, scope-based access)
- ✅ Apply **principle of least privilege** everywhere (DB users, file permissions, IAM roles, container capabilities, network policies)
- ✅ Rate-limit and apply defenses against brute-force, credential stuffing, enumeration, DoS (login, OTP, password reset, API endpoints)
- ✅ Use automated dependency vulnerability scanning in CI/CD (Dependabot, Snyk, Renovate, Trivy, OSS-Fuzz, etc.)
- ✅ Run secret scanning on every commit / PR (truffleHog, GitGuardian, Gitleaks, Git-secrets, etc.)
- ✅ Regularly audit and rotate secrets (API keys, signing keys, passwords) — automate where possible
- ✅ Implement proper logging (structured, no secrets, anonymized PII) + monitoring + alerting on security-relevant events
- ✅ Regularly test for OWASP Top 10 + CWE Top 25 (automated: ZAP, Burp, Nuclei, Semgrep; manual pentest at major releases)
- ✅ Use secure defaults in libraries/frameworks (e.g., express-rate-limit, helmet, csurf/csrf, sanitize-html, etc.)
- ✅ Containerize with minimal base images, non-root users, read-only filesystems where possible, and scan images (Trivy, Clair)
- ✅ Threat-model new features before implementation and review security implications during code review
- ✅ Keep an up-to-date **project_rules.md** file explaining reporting process, supported versions, and known issues
- ✅ Have a plan for responsible disclosure and fast patching of discovered vulnerabilities
---

## 2. CODE REVIEW - MANDATORY BEFORE SUBMISSION

**Before submitting code, YOU MUST check for:**
- [ ] Hardcoded secrets or credentials
- [ ] Missing error handling (try-catch blocks)
- [ ] SQL injection risks (use parameterized queries)
- [ ] Missing input validation
- [ ] N+1 query problems
- [ ] Memory leaks (unclosed connections)
- [ ] TypeScript `any` types (use proper types)
- [ ] Unhandled promise rejections
- [ ] Missing authentication checks on protected routes
- [ ] Performance issues (will this work with 500 creators + 1 year of data?)

**If you find ANY issue: FIX IT before submitting.**

---

## 3. DATABASE DESIGN

**Requirements:**
- ✅ Easily expandable (we'll add more metrics later)
- ✅ Indexes on frequently queried columns
- ✅ Foreign keys with proper cascading
- ✅ Time-series data optimized (index on `creatorId, timestamp`)
- ✅ Store timestamps in UTC always
- ✅ Use enums for fixed values (`'kick' | 'twitch'`)
- ✅ Proper data types (DECIMAL for money, not FLOAT)

---

## 4. ERROR HANDLING

**NEVER:**
- ❌ Silent failures: `catch(e) {}`
- ❌ Assume APIs will always work
- ❌ Generic errors: "Something went wrong"

**ALWAYS:**
- ✅ Log errors with full context (operation, user, timestamp, error)
- ✅ Context MUST be sanitized: never log raw tokens, emails, IPs, headers, request bodies, or PII
- ✅ Implement retry logic (3 attempts, exponential backoff)
- ✅ Set timeouts on external calls
- ✅ Return meaningful error messages
```typescript
try {
  const result = await externalAPI.call();
  if (!result?.data) throw new Error('Invalid response');
  return result.data;
} catch (error) {
  logger.error('Operation failed', {
    operation: 'scrape_leaderboard',
    creatorId, url,
    error: error.message,
    timestamp: new Date().toISOString()
  });
  throw new AppError('Failed to fetch data', 500);
}
```

---

## 5. API DESIGN

**Rules:**
- ✅ Validate ALL input (use Zod/Joi/class-validator)
- ✅ Use proper HTTP status codes (200, 400, 401, 403, 404, 500)
- ✅ Implement rate limiting per API key
- ✅ Return consistent response format
- ✅ Add pagination for list endpoints
- ✅ Check permissions on EVERY protected endpoint
- ✅ Never trust client input
- ✅ Version all APIs from day one
- ✅ Never remove or rename fields in existing versions — deprecate and add new ones
- ✅ Document breaking changes and provide migration guides

**Response format:**
```json
{
  "success": true,
  "data": {...},
  "meta": { "timestamp": "...", "requestId": "..." }
}
```

---

## 6. PERFORMANCE

**Database:**
- ✅ Use `.select()` - NEVER `SELECT *`
- ✅ Cache frequently accessed data (Redis, 15min TTL)
- ✅ Avoid N+1 queries (use joins)
- ✅ Set query timeouts (5-10 seconds max)
- ✅ Use connection pooling (e.g., PgBouncer, Prisma pool, Drizzle pool)
- ✅ Set pool size based on: `(workers * connections_per_worker) < max_db_connections`
- ✅ Monitor pool exhaustion — alert if connections wait > 100ms

**Frontend:**
- ✅ Lazy load components
- ✅ Debounce search inputs (300ms)
- ✅ Implement pagination/infinite scroll
- ✅ Cache API responses client-side

**Critical question:** "Will this work with 500 creators and 1 year of data?"

---

## 7. SCALABILITY

**Workers:**
- ✅ Use job queues (Bull/BullMQ)
- ✅ Implement retries (3 attempts, exponential backoff)
- ✅ Make workers stateless
- ✅ Set job timeouts
- ✅ Implement graceful shutdown (SIGTERM/SIGINT handlers)
- ✅ Stop accepting new jobs, drain in-progress jobs (30s timeout), then exit
- ✅ Close database connections and flush logs before process exit

**Rate limits:**
- ✅ Discord: 50 req/sec (request increase to 1200/sec)
- ✅ Queue requests instead of rejecting
- ✅ Use multiple bot accounts for 500+ servers (max 200 each)

**Scraping:**
- ✅ Add 1-3 second delays between requests
- ✅ Randomize user agents
- ✅ Implement circuit breaker (stop if too many failures)

---

## 8. CODE QUALITY

**TypeScript:**
- ✅ Strict mode enabled
- ✅ NO `any` types (use `unknown` or proper types)
- ✅ Define interfaces for all data structures

**Structure:**
```
src/
├── modules/      # Feature modules (creators, leaderboards, discord, auth)
├── workers/      # Background jobs
├── utils/        # Shared utilities
├── types/        # TypeScript types
└── main.ts
```

**Naming:**
- camelCase for variables/functions
- PascalCase for classes/types
- SCREAMING_SNAKE_CASE for constants
- Prefix booleans: `isActive`, `hasPermission`, `shouldRetry`

---

## 9. MONITORING & LOGGING

**Implement from day 1:**
- ✅ Structured logging (Winston/Pino)
- ✅ Error tracking (Sentry)
- ✅ Uptime monitoring (UptimeRobot)

**Log these events:**
- Failed scraping attempts (URL, error, retry count)
- Rate limit hits (API, timestamp)
- Authentication failures (key, IP)
- Slow queries (> 1 second)
- All 5xx errors

---

## 10. EXPANSION MINDSET

**Before writing features, ask:**
> "How will this work when we add new metrics in 3 months?"

**Design for expansion:**
- ✅ Store configs in database (not hardcoded)
- ✅ Use plugin/module architecture
- ✅ Version database migrations
- ✅ Keep APIs backward compatible
```typescript
// ❌ BAD - Hardcoded
interface CreatorStats {
  avgViewers: number;
  avgChatters: number;
}

// ✅ GOOD - Expandable
interface CreatorMetric {
  type: string;
  value: number;
  timestamp: Date;
  source: string;
}
```

---

## 11. DEPLOYMENT CHECKLIST

Before deploying: 
```
□ All secrets in .env (not hardcoded)
□ .env in .gitignore
□ Database migrations tested
□ Health check endpoint (/health)
□ Error monitoring active
□ Backups configured
□ Rate limiting active
□ HTTPS enabled
```

---

## PROJECT REQUIREMENTS

**System must handle:**
- 500+ creators tracked simultaneously
- 500+ Discord servers (need a few bot accounts)
- 500+ leaderboard sites
- Data updates every 15 minutes
- Zero lag for users
- Time-series data (1h/24h/7d/30d/all-time)
- Two tiers: Basic ($3k/mo) vs Premium ($5k/mo)

**Success criteria:**
- 24/7 uptime without manual intervention
- Data accuracy > 95%
- API response < 500ms (p95)
- Search results < 200ms
- Uptime > 99.5%

---

## FINAL CHECK BEFORE COMMIT
```
□ No hardcoded secrets
□ No console.log (use logger)
□ No 'any' types
□ Error handling present
□ Input validation present
□ Authentication on protected routes
□ Rate limiting implemented
□ Code formatted consistently
□ TypeScript compiles with no errors
```

---

## 12. LLM / AI BEHAVIOR RULES (ABSOLUTE)

The AI must behave deterministically, conservatively, and defensively.

**NEVER:**
- ❌ Guess, assume, or hallucinate implementation details
- ❌ Invent APIs, libraries, configs, environment variables, database fields, or endpoints
- ❌ Fill in “likely” values when information is missing
- ❌ Continue when requirements are ambiguous or underspecified
- ❌ Make architectural decisions that were not explicitly approved
- ❌ Modify unrelated files “while you’re at it”
- ❌ Change existing behavior unless explicitly instructed

**ALWAYS:**
- ✅ Ask for clarification if ANY requirement is ambiguous
- ✅ Mark unknowns explicitly as `TODO: DECIDE`
- ✅ Preserve existing architecture, patterns, and conventions
- ✅ Prefer minimal, incremental changes over refactors
- ✅ Explain tradeoffs when multiple valid approaches exist
- ✅ Reference the exact files and lines being changed
- ✅ Default to correctness, safety, and simplicity over cleverness


**If unsure: STOP and ASK.**

**Review your code BEFORE submitting. Every time.**



---

## 13. CHANGE CONTROL (NO SCOPE CREEP)

**Rules:**
- ❌ Do NOT refactor unless explicitly requested
- ❌ Do NOT rename files, folders, or exports unless required
- ❌ Do NOT change database schemas without a migration plan
- ❌ Do NOT introduce new dependencies without justification

**Every PR must answer:**
1. What changed?
2. Why was it necessary?
3. What could break?
4. How was it tested?

---

## 14. TESTING (REQUIRED)

**Minimum requirements:**
- ✅ Unit tests for business logic
- ✅ Integration tests for APIs touching DB or external services
- ✅ Mock all external APIs (no real calls in tests)
- ✅ Test error paths, not just happy paths

**NEVER:**
- ❌ Merge code without tests unless explicitly approved
- ❌ Rely on manual testing alone


---

## 15. DATA INTEGRITY & CORRECTNESS

**Rules:**
- ✅ Never overwrite historical data
- ✅ All metric updates must be idempotent
- ✅ Detect and handle partial failures
- ✅ Validate scraped data ranges (no negative viewers, impossible spikes, etc.)
- ✅ Flag anomalies instead of silently accepting them
- ❌ Never delete or truncate production data unless explicitly instructed
- ❌ Destructive migrations require rollback plans


**Data loss is a SEV-1 incident.**

---

## ARCHITECTURE DECISIONS
Any non-trivial architectural choice must be documented:
- Problem
- Options considered
- Decision
- Tradeoffs

---

## SAFETY SWITCHES
- Feature flags for scraping
- Ability to disable a source globally
- Ability to pause all workers instantly

---

Before outputting code, the AI must internally verify:
- No rules were violated
- Scope stayed within request
- No assumptions were made
**If unsure: STOP and ASK.**

---
