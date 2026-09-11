# Claude Overnight Agent

A local Claude Code plugin marketplace containing one plugin, **Overnight Agent**, which
lets you write a plan during the day, hand it off at bedtime, and wake up to committed,
independently verified work on a dedicated branch.

```
.
├── .claude-plugin/marketplace.json    the marketplace, "overnight-local"
├── plugins/overnight-agent/           the plugin — see its README for everything
└── sample-repo/                       a fixture with real defects, for trying it out
```

## Install

```bash
claude plugin marketplace add "/Users/liamsantos/Claude Overnight Agent"
claude plugin install overnight@overnight-local
```

The commands are then `/overnight:plan`, `/overnight:validate`, `/overnight:start`,
`/overnight:status` and `/overnight:stop`.

Requires Node 18 or newer, git, and a `claude` on your PATH that is signed in. The run
spawns headless sessions, so `claude -p "reply with: ok" --max-turns 1` has to work.

## Read next

**[plugins/overnight-agent/README.md](plugins/overnight-agent/README.md)** — how the run
loop works and why it is built that way, the plan format, every configuration option, the
safety model, and troubleshooting.

## Try it on the fixture

`sample-repo/` is a small Node project with genuine defects: a duration parser that does not
understand hours, an unimplemented retry function, a module with no tests, and a README with
no usage section. It starts at 4 passing and 6 failing tests, and its `OVERNIGHT_PLAN.md` has
five tasks that fix all of it.

**Make it its own repository first.** It ships as plain files, so without this the run would
branch and commit across this whole repository rather than the fixture. Preflight warns you
if you skip it.

```bash
cd sample-repo
git init && git add -A && git commit -m "fixture: three modules, an incomplete test suite"
```

Then walk the plan without changing anything:

```bash
node ../plugins/overnight-agent/scripts/runner.mjs --repo "$(pwd)" --dry-run
```

For a real run, open Claude Code in `sample-repo` and use `/overnight:start`. A genuine run
of this plan takes about seven minutes and ends at 18 passing tests across 5 commits.

## Verify the build

```bash
node plugins/overnight-agent/scripts/selftest.mjs
```

135 checks covering the plan parser, the validator, the safety hook, and the runner loop
driven through every failure path that matters: reviewer rejection, stuck detection,
dependent skipping, usage-limit backoff, worker crashes, stop requests, and crash recovery.
