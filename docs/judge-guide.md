# Judge run guide

## Choose the supported path

The recommended first run is the credential-free synthetic demo in the [README Quickstart](../README.md#quickstart).
It executes actual MCP calls, policy evaluation, PostgreSQL reservations, approval binding and the refund executor against synthetic payment responses.
It is suitable for checking the four documented scenarios, not for demonstrating live PayPal or model accuracy.

Public hosted demo URL: **not available**.
Hosting is tracked in [#20](https://github.com/AndrewDongminYoo/spendwall/issues/20).
AG Studio trial issuance remains deferred; public deployment needs a valid license.
Local evaluation is described in the [dashboard guide](dashboard.md#ag-studio-and-licenses).

## Prerequisites

- Node.js 24.21.0 and pnpm 11.24.0, verified with `node --version` and `pnpm --version`.
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
```

These are synthetic payment-write counts, not PayPal settlements.
The runner asserts the decisions and writes before printing `PASS`.
The approval scenario checks that no payment occurs while pending, then uses a separately held scripted human capability.
The injection fixture attempts out-of-ticket refunds; both are denied.
The velocity fixture permits two small refunds and rejects the third using persisted history.

Use `pnpm demo small`, `pnpm demo approval`, `pnpm demo injection` or `pnpm demo velocity` to isolate a scenario.
Each invocation creates a uniquely named disposable PostgreSQL container and temporary refund ledgers, then removes its own resources on completion or handled interruption.
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

On October 16, 2026, a new Linux ARM64 validation container ran a fresh public clone at `652ee1f921ff872a65734e1f28c0ab98f0937742`, frozen install and all four scenarios in **47 seconds**.
Node 24.21.0, pnpm 11.24.0, Git and a dedicated Docker daemon were ready before the timer started.
The pnpm store and inner Docker image store were empty; the measurement includes dependency downloads and the PostgreSQL image pull.
The four observed results were `small: PASS payments=1`, `approval: PASS payments=1`, `injection: PASS payments=0`, and `velocity: PASS payments=2`.
The documentation PR changes no runtime files relative to that revision.

The validation harness used a privileged disposable container with its own Docker daemon and no host Docker socket or credentials mounted.
That is test infrastructure, not a requirement for judges or a proposed deployment configuration.
Two earlier harness attempts failed because host-network loopback was unavailable and then because a disabled inner bridge prevented port publication; neither was counted as a successful run.
The successful run used normal inner bridge networking.
This is a bounded installation measurement, not a guarantee on other networks or machines.

## Remaining submission work

- A hosted URL and read-only judge access depend on #20 and a valid deployment license.
- The integrated live-sandbox judge flow is not delivered by the synthetic demo.
- Broader live Claude coverage, mobile push/biometric approval and the submission video require separate verification.
- The architecture diagram shows current composition, not completion of every item in the roadmap.

The [official rules](https://paypalaihackathon.devpost.com/rules) allow complete runnable setup instructions instead of a hosted URL.
That does not establish this project's final submission eligibility or satisfy outstanding project acceptance criteria automatically.
