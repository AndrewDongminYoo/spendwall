# Judge run guide

## Choose the supported path

The recommended first run is the credential-free synthetic demo in the [README Quickstart](../README.md#quickstart).
It executes actual MCP calls, policy evaluation, PostgreSQL reservations, approval binding and the refund executor against synthetic payment responses.
It is suitable for checking the five documented scenarios (four refund cases and the buyer-side shopping flow), not for demonstrating live PayPal or model accuracy.

Public hosted demo URL: **not available**.
Hosting is tracked in [#20](https://github.com/AndrewDongminYoo/spendwall/issues/20).
AG Studio trial issuance remains deferred; public deployment needs a valid license.
Local evaluation is described in the [dashboard guide](dashboard.md#ag-studio-and-licenses).

## Prerequisites

- Node.js 24.22.2 and pnpm 11.24.0, verified with `node --version` and `pnpm --version`.
- Git, Docker CLI and a running local Docker daemon, verified with `git --version` and `docker info`.
- Internet access for the repository, package registry and the first `postgres:17-alpine` image pull.
- A terminal on the Docker host; the runner connects to a dynamically published loopback port.
  A remote Docker daemon is not supported by this Quickstart.

Docker Desktop supplies the local daemon on macOS/Windows; use a local daemon on Linux.
No Trunk installation, Compose startup, database migration command, seed capture, model key or trial is needed for the default demo.
Toolchain installation is a prerequisite, outside the ten-minute rehearsal timer.

## First run and expected results

Run the four commands in the README Quickstart from a directory where `spendwall` does not already exist.
The default run prints `RECORDED AGENT CALLS / SYNTHETIC PAYMENTS / SCRIPTED HUMAN APPROVAL` before processing tickets.
The expected final lines are:

```log
small: PASS payments=1
approval: PASS payments=1
injection: PASS payments=0
velocity: PASS payments=2
shopping: PASS payments=1
```

These are synthetic payment-write counts, not PayPal settlements.
The runner asserts the decisions and writes before printing `PASS`.
The approval scenario checks that no payment occurs while pending, then uses a separately held scripted human capability.
The injection fixture attempts out-of-ticket refunds; both are denied.
The velocity fixture permits two small refunds and rejects the third using persisted history.
The [shopping](shopping.md) fixture denies an agent-supplied price, creates one catalog order with its approve link, denies capture before buyer approval, then captures once after a scripted buyer approval on the synthetic PayPal page.

Use `pnpm demo small`, `pnpm demo approval`, `pnpm demo injection`, `pnpm demo velocity` or `pnpm demo shopping` to isolate a scenario.
The optional, synthetic `pnpm demo dispute` scenario is not part of the default run or the expected output above; the [agent guide](../apps/agent-demo/README.md#opt-in-dispute-deadline-scenario) describes it.
Each invocation creates a uniquely named disposable PostgreSQL container, plus temporary refund ledgers when it runs a refund scenario, then removes its own resources on completion or handled interruption.
Do not use the synthetic ledger lifecycle as production recovery guidance.

### If a run fails

| Symptom                      | Action                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node/pnpm version mismatch   | Use the pinned versions before installing packages                                                                                                              |
| Docker unavailable           | Start the local daemon and confirm `docker info` succeeds                                                                                                       |
| Image pull failure           | Run `docker pull postgres:17-alpine`, then retry; the runner's uncached download has a five-minute deadline                                                     |
| Dependency download failure  | Check registry/network access and repeat the frozen install                                                                                                     |
| Scenario does not print PASS | Preserve the output and stop; do not substitute a successful screenshot for the failing run                                                                     |
| Process was forcibly killed  | Inspect `docker ps -a --filter name=spendwall-demo-` and the `spendwall.demo.pid` label; remove only the stopped run's exact container after checking ownership |

Normal cancellation uses Ctrl+C.
Do not prune unrelated containers, delete private payment ledgers or bypass repository hooks to repair the demo.

## Dashboard walkthrough

Build and start the separate preview with the README dashboard commands.
Open the printed local URL and use the disposable token from that invocation.
This token grants read access to the synthetic preview merchant; it is not a production credential or human approval authority.

1. Inspect confirmed refunds, pending approval reservations and denial counts.
2. Use the three audit buttons: weekly attempts above USD 100, denial rule groups and support-bot reservation history.
3. Check that the synthetic label remains visible and each answer replaces one result widget.
4. Disconnect or refresh to clear the prior result; stop the server with Ctrl+C when finished.

The preview creates independent fixture data rather than replaying the terminal demo's database.
AG Studio evaluation watermarks are expected and must not be hidden in evidence.
The [recording](assets/dashboard-demo.gif) and [static frame](assets/dashboard-demo.png) show this path; they do not depict a real Claude request.
For an existing database, follow the dedicated [read-only configuration](dashboard.md#existing-firewall-database) and keep its keys outside the browser build and Git.

## Optional live services are separate

The issue originally proposed `docker compose up`, then `pnpm seed && pnpm demo` with personal sandbox keys.
That is not a connected live-demo path in this revision.
Compose starts only PostgreSQL, seed creates sandbox captures, and the agent demo always uses synthetic payment responses.
Do not run seed to prepare the credential-free Quickstart.

If deliberately evaluating the separate sandbox adapter, first read [sandbox setup](sandbox.md), [seed behavior and recovery](seed.md), and [proxy boundaries](proxy.md).
Use a separate seed output for a different PayPal app; preserve its request IDs and private execution ledgers.
Seeding creates/captures sandbox orders; the refund smoke command submits sandbox refunds.
The W0 proxy does not enforce the demo's policy/approval pipeline.
The recorded SSE/REST observations in the proxy guide are dated evidence, not proof of current provider availability.

Optional `pnpm demo small --live` invokes a paid Claude model but still uses synthetic payments.
Its interactive human approval differs from the default scripted fixture; see the [agent guide](../apps/agent-demo/README.md#optional-claude-run).
Approval summaries and dashboard queries require their own explicit server-side configuration.
No real credentials are required for the recorded rehearsal.
The subsequent [live Claude rehearsal](notes/2026-10-16-live-rehearsal.md) exercised four existing fixtures with synthetic payments, including noninteractive denial of the approval case.
Its injection result differs from recorded replay and does not demonstrate the firewall's out-of-ticket denial path.
No live payment request was made for either rehearsal.

## Rehearsal evidence

On October 30, 2026 (KST; 03:50:37 to 03:50:57 UTC), a new Linux ARM64 `node:24.22.2-bookworm` validation container ran a fresh public clone at `ce91dfaaa8cfa9af09cfdb3b597c40593b87d14d`, frozen install and all five default scenarios in **20 seconds**.
Node 24.22.2, pnpm 11.24.0 (activated with Corepack), Git 2.39.5 and a dedicated Docker daemon (Debian `docker.io` 20.10.24) were ready before the timer started.
The pnpm store directory did not exist and the inner Docker image store held no images, so package downloads and the PostgreSQL image pull were included in the measurement.
The five observed results were `small: PASS payments=1`, `approval: PASS payments=1`, `injection: PASS payments=0`, `velocity: PASS payments=2` and `shopping: PASS payments=1`.
The cloned checkout remained clean and no `spendwall-demo-` container remained afterward.
The harness used the privileged disposable-container arrangement described below, without a host Docker socket or credentials mounted.
This documentation update changes no runtime files or dependencies relative to that revision; the result does not reverify PayPal connectivity or mobile behavior after the SDK update.

On October 27, 2026 (KST; 04:51:25 to 04:51:44 UTC), a new Linux ARM64 `node:24.22.1-bookworm` validation container ran a fresh public clone at `bd43915883acc4a12ae8be17ee6da9be39054c32`, frozen install and all five default scenarios in **19 seconds**.
Node 24.22.1, pnpm 11.24.0 (activated with Corepack), Git 2.39.5 and a dedicated Docker daemon (Debian `docker.io` 20.10.24) were ready before the timer started.
The pnpm store directory did not exist and the inner Docker image store held no images, so the measurement includes every package download (the frozen install downloaded 209 packages, reusing none, in 3.9 seconds) and the PostgreSQL image pull.
The five observed results were `small: PASS payments=1`, `approval: PASS payments=1`, `injection: PASS payments=0`, `velocity: PASS payments=2` and `shopping: PASS payments=1`, and no `spendwall-demo-` container remained afterwards.
The host was a Mac mini (Apple silicon) running Docker Engine 29.9.2 in Docker Desktop with 10 CPUs and about 7.7 GiB of memory in its VM; its load average was about 7 during the run.
The harness had the same shape as the October 18 run described below: a privileged disposable container with its own daemon, no host Docker socket or credentials mounted, and default bridge networking.
The documentation PR changes no runtime files relative to that revision.
This run does not isolate whether network, host load or project changes explain the difference from the 152-second run.

On October 18, 2026 (KST; 23:54:34 to 23:57:06 UTC on October 17), a new Linux ARM64 `node:24.21.0-bookworm` validation container ran a fresh public clone at `fdb83d165279396ec56b62c6d24b601a35008dd5`, frozen install and all five default scenarios in **152 seconds**.
Node 24.21.0, pnpm 11.24.0, Git 2.39.5 and a dedicated Docker daemon were ready before the timer started.
The pnpm store directory did not exist and the inner Docker image store held no images, so the measurement includes every package download (the frozen install added 210 packages in 44.1 seconds) and the PostgreSQL image pull.
The five observed results were `small: PASS payments=1`, `approval: PASS payments=1`, `injection: PASS payments=0`, `velocity: PASS payments=2` and `shopping: PASS payments=1`.
The host was a Mac mini (Apple silicon) running Docker Desktop with 10 CPUs and about 7.7 GiB of memory in its VM; its load average was about 11 during the run.
The documentation PR changes no runtime files relative to that revision.

The validation harness used a privileged disposable container with its own Docker daemon (Debian `docker.io` 20.10.24) and no host Docker socket or credentials mounted.
That is test infrastructure, not a requirement for judges or a proposed deployment configuration.
The inner daemon started with its default bridge networking.
An earlier version of this harness exited before the timer started, because listing the absent pnpm store directory failed under the shell's strict pipeline error option; it ran no clone or demo and was not counted as a run.
This is a bounded installation measurement on one busy host, not a guarantee on other networks or machines.

An earlier fresh-container run on October 16, 2026, at `652ee1f921ff872a65734e1f28c0ab98f0937742`, completed the then four default scenarios in 47 seconds after two harness attempts had failed on host-network loopback and a disabled inner bridge.
That run predates the `shopping` scenario, so it does not measure the current default demo.

The October 16, 2026, [repository-history secret scan](notes/2026-10-16-history-secret-scan.md) records a snapshot at `f226b6a` with 30 advertised refs and 122 reachable commits.
Gitleaks reported zero findings after deleted-history and merge-only detection controls, with explicit Git output formatting to make the commit coverage count agree.
That text-history result excludes media inspection and does not establish that every secret format is detected or that later commits are covered.
A [repeat scan on October 18, 2026](notes/2026-10-18-history-secret-scan.md), at `f7feeb3` with 46 refs and 185 reachable commits, also reported zero findings; it did not repeat the detection controls.

## Remaining submission work

- A hosted URL and read-only judge access depend on #20 and a valid deployment license.
- The integrated live-sandbox judge flow is not delivered by the synthetic demo.
- Broader live Claude coverage, Android push/biometric approval ([#103](https://github.com/AndrewDongminYoo/spendwall/issues/103)) and the submission video require separate verification.
  The [iPhone recording](recording-approval.md#paypal-sandbox-mode) and [iOS edge checks](notes/2026-10-27-approver-ios-edge-checks.md) have dated evidence; physical-device dispute deadline delivery remains unverified under #28.
- The architecture diagram shows current composition, not completion of every item in the roadmap.

The [official rules](https://paypalaihackathon.devpost.com/rules) allow complete runnable setup instructions instead of a hosted URL.
That does not establish this project's final submission eligibility or satisfy outstanding project acceptance criteria automatically.
