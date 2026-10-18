# Repository-history secret scan, October 18

This note records a repeat of the [October 16 history secret scan](2026-10-16-history-secret-scan.md) against a newer snapshot.
The October 16 note stays the dated record of that earlier snapshot, its detection controls and its coverage repair.

## Snapshot and result

On October 18, 2026, a fresh bare mirror of `AndrewDongminYoo/spendwall` was captured at 06:55:44 UTC.
Its default branch was `f7feeb3c61f2086960a247155022a6139b946cfb`.
`git rev-parse --is-shallow-repository` printed `false`.
It contained 46 refs: two branches and 44 pull-request refs, with no tag refs.
`git rev-list --all --count` printed 185 reachable commits.

The Gitleaks history scan returned **exit code 0** and logged `183 commits scanned.`, `scanned ~4605863 bytes (4.61 MB) in 587ms` and `no leaks found`.
The JSON report held zero findings.
This is evidence about this snapshot and scanner configuration, not proof that the repository contains no secret.
The result does not include commits added after the snapshot, including this evidence PR.
The staged guard and CI remain separate checks for subsequent changes.

## Scanner and configuration

The scan used the Homebrew Gitleaks binary, version `8.30.1`, with SHA-256 `f414bc2fb952be6c9072b75cb411e3368614ef4b16d48dbd9ad238034afd2302`.
This is the same binary hash as on October 16.
Git reported `2.54.0 (Apple Git-157)`.

The configuration, the empty ignore file and the options were the same as in the October 16 reproduction block: `[extend] useDefault = true`, `--ignore-gitleaks-allow`, `--redact=100`, decode depth 5, archive depth 0, a 180-second timeout and the same `--log-opts`, including the explicit `--format=medium --date=default --no-decorate`.

## Coverage

<!-- cspell:ignore numstat -->

Gitleaks reported 183 scanned commits against 185 reachable commits.
A separate `git log --all --full-history --diff-merges=separate --no-renames --numstat` pass found 185 distinct commits: 183 with textual additions and 2 without.
The two commits without textual additions are `f1aeba1`, the merge of #59, and `7930041`.
Both add only the binary file `docs/assets/devpost-thumbnail.png`.
Gitleaks skips non-archive binary files, so every commit with textual additions was scanned.

The October 16 negative controls (the deleted-history marker and the merge-only marker) were not repeated for this snapshot.
The scanner binary and options are identical, but this note does not have its own control result.

## Reproduction

Use the [October 16 reproduction block](2026-10-16-history-secret-scan.md#reproduction) without change, with two differences from this run:

- The working directory was the session scratchpad directory, not a directory from `mktemp -d`.
- The Homebrew binary was called by its absolute path, because `gitleaks` on `PATH` resolved to a Trunk-managed binary that reported an installation error.

## Recorded refs

The following ordered manifest has SHA-256 `57e9c5b40709144571a810273e28820659641669e43b7a1f09dd0b757cad21a6`, including a final newline.
Unlike on October 16, the manifest was not compared with a fresh `git ls-remote --refs` response at capture time.
Unlike the October 16 manifest, it holds no `refs/pull/39/merge` ref.

The second branch, `refs/heads/codex/issue-10-agent-auth` (closed draft PR #39), was in the snapshot.
It was deleted from the remote after the scan, on the operator's instruction.
Its commits stay reachable through `refs/pull/39/head`.

```plaintext
74c56908f68642056b73a1eec9bc856cce7b484b refs/heads/codex/issue-10-agent-auth
f7feeb3c61f2086960a247155022a6139b946cfb refs/heads/main
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
c5239602ebb63a887d3ad5f13669091cb98ef02a refs/pull/57/head
fe479f98453204b3813936968303cd58f3ed1c4c refs/pull/58/head
79300414a84d3986e510eff88de33ca4935faf5f refs/pull/59/head
3b207ad29a8d40baf819ad801542c513c234b58d refs/pull/60/head
fb7745e70947edccbbb735212a5ee9546dc3e56a refs/pull/62/head
775ef3ce03e11b370f893290ba0267a292b1c6f7 refs/pull/63/head
b7c329ccbf7a5651cf7d43fa5f9cef0ca9a83006 refs/pull/64/head
b5c15e50a4398e100a92d0d63ae38f8ec99d8daf refs/pull/67/head
cbb9992c3187507438608b77c0a3f042fcf69659 refs/pull/68/head
db1730af6fea8168fd4ecb091a992500091e885d refs/pull/69/head
4da56d41c31ecb4ff2d30da9c7936a011359755d refs/pull/70/head
810210117b513c70fb9d70242aa0acffa46c7866 refs/pull/71/head
749fdafd8d996ca7f116554890ec499fb9e6cb26 refs/pull/73/head
58ec043045e7a2bc40e83ac552e077152f602cfe refs/pull/74/head
3016db016b9472bb19180341fc0472aa0821dff6 refs/pull/75/head
8a9a9559ed22f44e3b26f24a5e799801aebde118 refs/pull/76/head
6d5631847670ddd1b0809e34a6af094a879c9ff5 refs/pull/77/head
```

## Remaining limits

The detection and coverage limits listed in the [October 16 note](2026-10-16-history-secret-scan.md#remaining-limits) apply to this snapshot too: built-in allowlists and detector patterns can miss credentials, and binary images, archive contents at depth 0, commit messages and content outside the advertised refs were not verified.
The scan must be repeated at the submission HEAD.
Hosting, the video, license coverage and the final submission remain separate #25 acceptance work.
