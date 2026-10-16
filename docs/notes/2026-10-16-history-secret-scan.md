# Repository-history secret scan

## Snapshot and result

On October 16, 2026, a fresh bare mirror of `AndrewDongminYoo/spendwall` was captured at 14:25:55 UTC.
Its default branch was `f226b6a2b2630ca1c2fd5d7b2f8bc05f059db97f`.
The mirror was not shallow and its ref/object pairs matched a fresh `git ls-remote --refs` response.
It contained 30 advertised refs: two branches and 28 pull-request refs, with no tag refs.
There were 122 reachable commits, including the separate draft PR #39 branch and advertised merge ref.

The final Gitleaks history scan reported **122 commits, zero findings and exit code 0**, with no scanner warning or error entry.
Both the report and the complete process result were inspected.
This is evidence about this snapshot and scanner configuration, not proof that the repository contains no secret.
The result does not include commits added after the snapshot, including this evidence PR.
The staged guard and CI remain separate checks for subsequent changes.

## Scanner and configuration

The installed Homebrew Gitleaks binary reported version `8.30.1`, matching the version configured for the project's Trunk scanner.
No dependency or tool installation was performed.
The Trunk-managed binary's version command returned a build placeholder, so this run used the already-installed binary with a concrete version output and recorded its hash.
The selected binary SHA-256 was `f414bc2fb952be6c9072b75cb411e3368614ef4b16d48dbd9ad238034afd2302`.
Git reported `2.54.0 (Apple Git-157)`.

The explicit configuration contained only:

```toml
[extend]
useDefault = true
```

This uses Gitleaks' built-in rules and built-in allowlists.
An explicit empty ignore file, no baseline and `--ignore-gitleaks-allow` prevented additional fingerprint or inline-comment exclusions.
The run set full redaction, decode depth 5, archive depth 0 and a 180-second timeout.
It did not limit target file size through `--max-target-megabytes`.
The [Gitleaks Git source](https://github.com/gitleaks/gitleaks/blob/v8.30.1/sources/git.go) reads added patch fragments and skips non-archive binary files; this is not a byte-for-byte scan of every Git object.

## Detection controls and coverage repair

Before accepting the result, an independent temporary repository committed a generated, nonfunctional token-shaped marker and deleted it in a later commit.
A second generated marker existed only in a merge commit and was also deleted afterward.
The same history command returned exit code 1 and identified both introducing commits.
Scanning the exported clean current tree returned exit code 0 and an empty report.
The marker values were absent from the redacted report.
These controls test deleted-history and merge-diff detection for that marker format, not every credential format.

The initial invocation inherited `log.date=iso8601-strict` and reported only 109 commits despite 122 reachable commits having textual additions.
Individual-commit diagnostics reproduced a zero commit count for 13 of them.
An explicit `--format=medium --date=default --no-decorate` restored the count in a targeted comparison, then the complete scan reported all 122.
The negative history controls were repeated with these final options and still detected both markers.
The [detector implementation](https://github.com/gitleaks/gitleaks/blob/v8.30.1/detect/detect.go) counts commit metadata attached to received fragments; the earlier count mismatch alone does not establish that every affected byte was omitted.
The final result uses the explicit format, not an assumption about the earlier run's coverage.

## Reproduction

Use the same installed Gitleaks version and a new temporary directory.
This fetches a new snapshot, which may differ from the recorded refs below.
Keep reports local and inspect only sanitized fields if findings appear.
An exit code other than zero is not a passing scan.

```sh
set -eu
test "$(gitleaks version)" = '8.30.1'
scan_dir=$(mktemp -d)
cat > "$scan_dir/scan.toml" <<'CONFIG'
[extend]
useDefault = true
CONFIG
: > "$scan_dir/empty-ignore"
git clone --mirror https://github.com/AndrewDongminYoo/spendwall.git "$scan_dir/repo.git"
git -C "$scan_dir/repo.git" rev-parse --is-shallow-repository
git -C "$scan_dir/repo.git" for-each-ref --format='%(objectname) %(refname)'
git -C "$scan_dir/repo.git" rev-list --all --count
gitleaks git "$scan_dir/repo.git" \
  --config "$scan_dir/scan.toml" \
  --gitleaks-ignore-path "$scan_dir/empty-ignore" \
  --ignore-gitleaks-allow --redact=100 --no-banner --no-color \
  --max-decode-depth=5 --max-archive-depth=0 --timeout=180 \
  --log-opts='--all --full-history --diff-merges=separate --no-ext-diff --no-textconv --no-renames --format=medium --date=default --no-decorate' \
  --report-format=json --report-path "$scan_dir/report.json"
```

Retain the ref inventory, scanner identity, control results and sanitized findings before removing the owned temporary directory.
Do not publish credential values, rotate keys or rewrite history merely to obtain a clean report.

## Recorded refs

The following ordered manifest has SHA-256 `2a3446447b6fb6935095acdc8ad36edf9b86f89423e29aab3c832fc0864ee769`, including a final newline.
The captured manifest matched all refs advertised by `git ls-remote --refs` at that time.

```plaintext
74c56908f68642056b73a1eec9bc856cce7b484b refs/heads/codex/issue-10-agent-auth
f226b6a2b2630ca1c2fd5d7b2f8bc05f059db97f refs/heads/main
05c22cfa0daf94ed534b9e2adc5091f91b606137 refs/pull/30/head
3bc5c4e4d51cffe223dae15c2178c3a372e2d101 refs/pull/31/head
184153136b07911e9354b6b50a813cd561f6ea44 refs/pull/32/head
60b84b06cbc3cebe8736c3cfac72215bc527d4d2 refs/pull/33/head
f2caff4a146591fc410d84510603019d808c91f4 refs/pull/34/head
a35932553a86aee2879e8983940681ee1c745b7f refs/pull/35/head
26127f01b9995a634e4d0442c57cc976d76a4644 refs/pull/36/head
bb8aa99110abf2c7e160403c73046978149497f8 refs/pull/37/head
5742dfd4825df73b1399af0af29ff9807fb91a21 refs/pull/38/head
74c56908f68642056b73a1eec9bc856cce7b484b refs/pull/39/head
4679357845b0edc0dcc6e3b4db0e2c7cc107d533 refs/pull/39/merge
f63731cb29703ce8ece5bfb407c3b1f124e65c29 refs/pull/40/head
45ede7504ea07c4f9fe7d9fbc48c6507614cc3d0 refs/pull/41/head
4dd296be94152027e54b3880ed502bd166380608 refs/pull/42/head
d3217b19b62834fabe2db5b7de9d5289a201198a refs/pull/43/head
d54332f133a25aee397f88d5e3a50649a8e5f0b8 refs/pull/44/head
307dd1bf7fbabfc1d2b3a094015297024bb6ee2e refs/pull/45/head
967fe2c2408d538cbdb5f54f33c85898836d52b2 refs/pull/46/head
dbab850444127e9b1bdf45b839b584ede911a58f refs/pull/47/head
528db957da1f9c872deeef1d7aa37cb04c177644 refs/pull/48/head
0f1be3790422e84e6032c372fd4b827266528a23 refs/pull/49/head
35f85373270a3a09dd535d45b9b11668f8786a26 refs/pull/50/head
0f9be6519850058390513585b4094ce513efaaa7 refs/pull/51/head
fc2a27fda67e7693f8b58933416211ff90a60efe refs/pull/52/head
4da8aca423bc667b41e58aa6d36ca59b1ffa0fef refs/pull/53/head
7612299ec7b503fc4af7eb2645cb70349c34ca91 refs/pull/54/head
4165fea694accbd1a6032fd568bc32a4999f2e66 refs/pull/55/head
42afccf47a96fdcc14f6c22702d1ae970d0c4876 refs/pull/56/head
```

## Remaining limits

Built-in allowlists and detector patterns can miss credentials.
Binary images, video, archive contents at depth 0, external LFS contents, submodule repositories, inaccessible refs, dangling objects and server-side retention outside the advertised refs were not verified.
Commit-message and annotated-tag content are not established by this patch-fragment scan.
The local working copy, ignored files and runtime secrets were outside the mirror and were not read.
No history rewriting, credential rotation, payment call, deployment or issue-state change was performed.
The temporary mirror and synthetic repositories were removed after sanitized evidence was preserved.
Video inspection, hosting/token renewal, license coverage and final submission remain separate #25 acceptance work.
