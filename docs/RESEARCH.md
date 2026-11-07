# Research and problem selection

This document records how the project was chosen: the problem areas investigated, the evidence found, the five shortlisted opportunities, and why one was picked. Research was done in November 2026.

**Honesty rules used here:**

- **Verified** means a cited source says it.
- **Reported** means a source says it but is a vendor or secondary source, so treat it as directional.
- **Assumption / opportunity** means our own reasoning.

No market size, demand or competitor weakness is invented.

---

## 1. The brief

Focus on the AI domain, but not a chatbot, content generator, basic RAG app or thin LLM wrapper. Find a real problem faced by AI users or by teams building AI products, where software engineering (not model research) is the solution, and where the backend has real depth: queues, retries, concurrency, idempotency, caching, security, observability.

## 2. What the research found, by area

### LLM API reliability (rate limits, outages, retries)

- **Reported:** Datadog's 2026 report, as summarised by a secondary source, found about 5% of LLM call spans in production returned errors, with rate limits, capacity problems and timeouts making up most of them.
- **Reported (practitioner blogs, 2026):** naive retries without jitter cause synchronized "thundering herd" retries. Providers rate-limit on tokens as well as requests, and `Retry-After` should be honoured. Silent model or format changes during fallback have caused incidents.
- **Existing tools:** LiteLLM (open source, self-hosted, widely used), Portkey, Helicone. Comparisons conflict on what each offers self-hosted, so check vendor docs before relying on any one claim.

### AI agents in production

- **Verified:** _Measuring Agents in Production_ ([arXiv 2512.04123](https://arxiv.org/abs/2512.04123), Dec 2025) surveyed 300+ teams. They deliberately constrain agent autonomy and keep step counts low to stay reliable.
- **Reported:** widely repeated "86%/88% of agent pilots fail" figures conflict with each other and could not be traced to primary sources. **Not used.**
- **Reported:** durable-execution engines (Temporal, Inngest, DBOS, LangGraph checkpointing) resume workflows. Practitioners point out that resuming does not stop a side effect (sending an email, charging a card) from running twice, so tool calls still need idempotency keys.

### Evaluation and regression testing of prompts

- **Verified:** In interviews with engineers building LLM "copilot" products ([Parnin et al., arXiv 2312.14231](https://arxiv.org/abs/2312.14231)):
  - Classic unit testing did not fit ("every test is a flaky test").
  - Teams wanted benchmarks for regression decisions.
  - Running them automatically was limited by cost. One participant tried to automate testing and was asked to stop because of cost.
- **Verified:** The RETAIN study ([arXiv 2409.03928](https://arxiv.org/abs/2409.03928)) found users struggled to:
  - spot which output differences were regressions
  - understand why metric scores changed
  - keep systematic track of how prompt edits affected outputs
- **Verified:** A 2026 technical report ([arXiv 2601.22025](https://arxiv.org/abs/2601.22025)) argues that generic prompt "improvements" can hurt specific behaviour, so changes should be checked against task-specific test suites. It also notes that providers update models, sometimes without explicit versioning.
- **Existing tools:** Promptfoo (open-source CLI), Langfuse (open-source observability platform with datasets and experiments; [Thoughtworks Radar](https://www.thoughtworks.com/radar/platforms/langfuse) notes its v3 self-hosting needs ClickHouse, Redis and S3), Braintrust, LangSmith.

### Security (prompt injection, unbounded consumption)

- **Verified:** The OWASP Top 10 for LLM Applications (2025) ranks prompt injection first (LLM01). It includes _Unbounded Consumption_ (LLM10): runaway usage and cost, mitigated with rate limits, quotas and timeouts.
- Prompt-injection detection is an open research problem. A student project could not credibly claim to solve it.

### Cost control

- **Reported (vendor blogs):** recursive agents and fan-out multiply token spend. Per-identity budgets enforced at a gateway are the recommended control. There is no standard yet.

### Semantic caching

- **Reported:** Redis's own documentation says poorly configured semantic caches can have very high false-positive rates, and a tighter similarity threshold cuts hit rate. A banking case study reported a cache serving instructions for the wrong action. [Thoughtworks](https://www.thoughtworks.com/radar/languages-and-frameworks/gptcache) recommends careful assessment of GPTCache because of false positives and false negatives.
- **Takeaway used in this project:** in a _testing_ tool, a wrong cached answer is worse than no cache, so PromptGate uses **exact-match** caching only.

### RAG knowledge freshness

- **Reported (practitioner and vendor posts):** vector indexes drift from source documents, deleted documents leave orphan vectors, and incremental re-embedding with content hashing is recommended. The evidence is real but mostly vendor-authored.

### Structured output reliability

- **Reported:** provider-side constrained decoding fixes JSON syntax but not semantically wrong values. Libraries like Instructor validate and retry. This is mostly a library-level concern.

## 3. Shortlist

| #   | Opportunity                                        | Strength of evidence                   | Existing solutions                                | Backend depth                                                                     | Solo feasibility                                          | Interview value                                        |
| --- | -------------------------------------------------- | -------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| 1   | **Prompt / model regression testing service**      | Strong: peer-reviewed / arXiv studies  | Promptfoo, Langfuse, Braintrust, LangSmith        | Very high: async jobs, retries, rate limits, idempotency, caching, crash recovery | High                                                      | High: every feature leads to an engineering discussion |
| 2   | LLM reliability gateway (retry, fallback, budgets) | Medium: mostly practitioner and vendor | LiteLLM, Portkey, Helicone (mature)               | High, but a mostly synchronous proxy                                              | High                                                      | High, but crowded and close to "wrapper" territory     |
| 3   | Durable agent execution with idempotent tool calls | Medium                                 | Temporal, Inngest, DBOS, LangGraph                | Very high                                                                         | Medium: hard to demonstrate honestly without a real agent | Medium: abstract to demo                               |
| 4   | RAG freshness and sync engine                      | Medium: vendor-heavy                   | Mostly do-it-yourself; streaming database vendors | High                                                                              | Medium: needs an embedding pipeline                       | Medium                                                 |
| 5   | Structured-output validation and repair            | Medium                                 | Instructor, outputguard                           | Medium: mostly a library                                                          | High                                                      | Low to medium                                          |

## 4. Selection: prompt regression testing (PromptGate)

**What exactly is the problem?** When a team changes a prompt (or the model behind it), they need to know which known-good behaviours broke. Outputs vary, manual checking does not scale, and re-running a whole suite on every change costs money.

**Who experiences it?** Developers and teams shipping features built on LLM APIs: support bots, classifiers, extraction pipelines.

**Why does it happen?** LLM output is not deterministic, prompts are edited as casually as copy text, and models change underneath the application. Classic unit-test tooling assumes deterministic functions and free execution, so neither assumption holds.

**How is it solved today?** Manual spot checks, hand-rolled scripts, or tools such as Promptfoo (CLI, local), Langfuse experiments, Braintrust and LangSmith.

**Why might those be insufficient for some teams?** This is stated as an _opportunity_, not a verified market gap:

- The studies above name **cost** and **telling regressions apart from noise** as the pain points.
- PromptGate tackles both with an exact-match cache (unchanged cases cost nothing) and a per-case comparison where only _regressions_ fail the gate, so known failures do not block a merge.
- It is self-hostable with just Postgres and Redis.
- We make **no claim** that existing tools fail at these things. Several handle them well.

**What does the proposed system do?** It stores immutable prompt versions and test suites. A run is broken into one job per test case, and workers execute the jobs with retries, rate limiting and caching. You can then compare runs and expose a pass/fail gate to CI.

**What makes it technically interesting?** Each feature maps to a real backend problem:

- Two workers must never run the same job: row locks with `SKIP LOCKED`.
- A dead worker's jobs must be recovered: leases and a reaper.
- A slow worker must not overwrite a newer result: fencing.
- Many workers must respect one provider's rate limit: an atomic Redis token bucket.
- A CI retry must not create a duplicate run: idempotency keys with a unique index.
- Creating a run must never leave orphaned or missing jobs: a single transaction.

**How is our implementation different?** Not in features (mature tools have more). It is different in being small enough to read end to end, with each of those guarantees covered by a test that reproduces the race or failure.

## 5. Problems deliberately not chosen

- **A chatbot or RAG app:** excluded by the brief, and offers little backend depth beyond calling an API.
- **Prompt-injection detection:** an unsolved research problem; a student implementation would overclaim.
- **Semantic caching as a product:** documented false-positive risk; hard to do responsibly.
- **Combining several of the above:** would add features without adding depth, and make the project harder to explain.

## Sources

- Parnin et al., _Building Your Own Product Copilot: Challenges, Opportunities, and Needs_, arXiv:2312.14231
- _RETAIN: Interactive Tool for Regression Testing Guided LLM Migration_, arXiv:2409.03928
- _When Generic Prompt Improvements Hurt: Evaluation-Driven Iteration for LLM Applications_, arXiv:2601.22025
- _Measuring Agents in Production_, arXiv:2512.04123
- OWASP Top 10 for LLM Applications 2025: [genai.owasp.org/llm-top-10](https://genai.owasp.org/llm-top-10/)
- Thoughtworks Technology Radar: [Langfuse](https://www.thoughtworks.com/radar/platforms/langfuse), [GPTCache](https://www.thoughtworks.com/radar/languages-and-frameworks/gptcache)
- Redis: [LangCache concepts](https://redis.io/docs/latest/develop/ai/context-engine/langcache/concepts/)
- AWS Architecture Blog, _Exponential Backoff and Jitter_ (basis for the retry strategy)
- Practitioner posts on LLM API resilience and durable agents (tianpan.co, 2026). Used only as "reported" context.
