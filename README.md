# mutant.cafe

![MUTANT CAFE: a feral rat leaping a row of snap traps, some sprung and some not](https://raw.githubusercontent.com/joelhooks/mutant-cafe/main/assets/banner.jpg)

Mutation testing for [Effect](https://effect.website) TypeScript. mutant.cafe reads your types, breaks your functions in ways that still type-check, runs the tests related to each break, and lists the breaks your tests miss.

mutant.cafe is part of [rat-stack](https://ratstack.sh).

It is inspired by [cargo-mutants](https://mutants.rs) by Martin Pool ([source](https://github.com/sourcefrog/cargo-mutants), MIT). The core idea, replacing a function body with a plausible value of its return type and reporting what the tests don't notice, comes from cargo-mutants, and so does the operator experience: a baseline run first, a scratch copy of your tree, per-mutant timeouts, `--in-diff`, and a `mutants.out` directory of results. mutant.cafe ports those ideas to Effect; it shares no code with cargo-mutants.

## What it adds for Effect

An `Effect<A, E, R>` declares its failures in `E`. For each tagged error in `E`, mutant.cafe makes a mutant that swallows that error and succeeds instead. If no value of `A` can be synthesized, a separate `TagToDefect` mutant turns that tag into a defect. That is not a successful recovery: it checks whether tests distinguish typed failures from defects, rather than only asserting `Exit.isFailure`.

Other mutants, all chosen from the checker's view of the return type:

- `Effect.succeed(value)` for plausible values of `A`, `Effect.fail` of each tag, `Effect.die`, and `Effect.never` behind a measured timeout
- `Option.none()` and `Option.some(value)`
- `Stream.empty`, a one-element stream, and a failing stream
- a `Layer` that dies at build, even when its error type is `never`, plus one failing build per error tag
- flipped booleans and cycled literal unions

## Use it

Needs Node 24 or later, a `tsconfig.json`, and a passing suite on Vitest 5 or newer. Older Vitest versions stop during preflight with exit 8 and the installed version.

```sh
npm install -D mutant-cafe
npx mutant-cafe --list      # preview the mutants
npx mutant-cafe --jobs 4    # test them
```

It mutates internal functions by default, including `Effect.fn` and `Effect.fnUntraced`, object-literal arrows, service methods inside Layers, and the inner function of a curried export. Layer values and static Layer properties are targets too. Names follow their path, such as `Greeter.layer.greet`, `policy.canEdit`, and `guardFor.<inner>`. With `--exported-only`, targets must be reachable through an exported binding path: exported top-level functions, methods and functions in exported values, returned curried functions, and exported Layers with their returned service methods. Local declarations and arrows inside other function bodies are internal, even if their owner is exported. This keeps local helpers out without dropping exported object or service APIs.

Value synthesis includes branded strings and numbers, empty sets and maps, anonymous objects with cycled literal fields, and every assignable parameter as an identity replacement, named by the parameter. Boolean and literal unions with up to eight members are exhaustive, excluding an obvious original constant. Swallow mutants enumerate recoveries only for genuinely finite success types with at most four members, including both booleans. Numbers, strings, structs, Json and larger finite sets use one representative per error tag. Larger or recursive shapes have at most six synthesized representatives per function and genre, plus `undefined` when present. For `Schema.Json`, these are `null`, `""`, `0`, `false`, `[]` and `{}`. Capped tagged unions keep the original body's discriminant first, with fields emptied, then other variants in declaration order. Synthesis stops beyond depth four or 2 KiB of printed value text and records the bound. Assignable-parameter identities are separate from the literal cap. Values differing only by `as const` or redundant parentheses generate one mutant. Naked type-parameter returns get no fabricated values, but a same-typed parameter can still supply an identity mutant. Context-only generic types that cannot be named in the body are skipped with a reason. Literal leaves keep their type without making mutable arrays readonly. Generator mutants use the body's type before `Effect.fn` pipeables such as `Effect.scoped` or `Effect.map`.

Run it from the package whose tests you want to check. In a monorepo that resolves workspace packages through built output, build the package's dependencies first.

| Flag | Meaning |
| --- | --- |
| `--list` | print mutants, per-file counts, the total and the not-mutated count, then exit |
| `--exported-only` | only exported binding paths, curried returns and Layer service methods; exclude local helpers |
| `--in-diff <file>` | only mutants on lines a unified diff adds or changes |
| `--in-diff-range <A...B or A..B>` | select from `git diff` run at the repository root; exclusive with `--in-diff` |
| `--max-mutants <n>` | keep the first n selected mutants in repository path, line, column, id order |
| `--format <text or json or github>` | text by default; JSON for `--list`; Markdown for GitHub |
| `--summary-md <file>` | write the Markdown summary to a file |
| `--summary-marker <text>` | override the first-line `<!-- mutant.cafe -->` marker |
| `--advisory` | exit 0 for outcomes and baseline failure; usage and internal errors still fail |
| `--file <glob>`, `--exclude <glob>` | choose source files (repeatable) |
| `--jobs <n>` | scratch copies tested in parallel |
| `--timeout <s>` | per-mutant test timeout; default 5× the baseline run, at least 20 s |
| `--timeout-multiplier <x>`, `--minimum-test-timeout <s>` | tune that default |
| `--output <dir>` | results directory, default `mutants.out` |
| `--tsconfig <path>` | default `tsconfig.json` |

## CI

Use a git range to check changed bodies and a mutant budget to cap the work. The budget applies after file, diff and function selection. Ordering uses repository-relative file path (lexical, not locale-dependent), start line, column, then id. `--max-mutants 0` keeps none. Budget-skipped mutants are not outcomes.

This advisory GitHub Actions job writes a step summary and updates one sticky PR comment. Install mutant-cafe as a dev dependency first. Replace `npm ci` with your package manager's install command if needed; run the mutation command from the package you want to test.

```yaml
name: Mutation advisory
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  mutants:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - name: Check changed bodies
        run: >-
          npx --no-install mutant-cafe
          --in-diff-range "origin/${{ github.base_ref }}...HEAD"
          --max-mutants 40 --format github --advisory
          --summary-md mutant-summary.md
      - name: Update sticky comment
        if: github.event.pull_request.head.repo.full_name == github.repository
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('node:fs');
            const body = fs.readFileSync('mutant-summary.md', 'utf8');
            const marker = '<!-- mutant.cafe -->';
            const { owner, repo } = context.repo;
            const issue_number = context.issue.number;
            const comments = await github.paginate(github.rest.issues.listComments, {
              owner, repo, issue_number
            });
            const previous = comments.find(comment =>
              comment.user.type === 'Bot' && comment.body?.startsWith(marker)
            );
            if (previous) {
              await github.rest.issues.updateComment({
                owner, repo, comment_id: previous.id, body
              });
            } else {
              await github.rest.issues.createComment({ owner, repo, issue_number, body });
            }
```

Fork PRs still get the step summary; the example only posts comments on same-repository PRs. Do not switch this job to `pull_request_target` to grant untrusted PR code a write token. If a job or matrix tests multiple packages, give each summary a distinct `--summary-marker` and match that marker in the comment step.

`--format github` prints Markdown and writes the same content to `GITHUB_STEP_SUMMARY` when set. `--summary-md` also works with the default text output. The first line is `<!-- mutant.cafe -->` unless overridden. The summary counts all outcomes, lists up to 50 missed, timeout, untested and unreliable mutants with repository-root-relative paths, and says what would have failed without `--advisory`. Advisory mode does not hide bad arguments, bad refs, source errors or internal errors.

For automation without running tests, `--list --format json` prints one JSON document: `schemaVersion`, `tool`, `mutants` (the same `Mutant` shape used by report results), `notMutated`, and `counts` with `selected`, `run` and `budgetSkipped`. `selected` is the count before the budget; `run` is zero for a list and the number of recorded outcomes for an execution. The published `MutantList` and `RunReport` schemas are exported by `@mutant-cafe/core` in this workspace. Reports keep schema version 2: `selected`, `run` and `budgetSkipped` are additive optional fields, so older v2 reports still decode.

## Outputs

A mutant ID names the mutation and its site, not a version of your code. Within an ID epoch, the same site and representative keep their ID across trivia, type-only edits to the target and its surroundings, file filters, and file discovery order. Some type-only edits inside a body retained by a wrapper, such as method overloads or abstract members, can still change the wrapper ID. An import-adding mutant hashes the logical edit, not the retained file prefix.

Caught and missed outcomes are valid only for the run that produced them. Never reuse outcomes across code changes, even when the ID stays the same. Never join IDs across epochs; start a new comparison baseline when the epoch changes.

Results land in `mutants.out/`: `missed.txt`, `caught.txt`, `timeout.txt`, `unviable.txt`, `untested.txt`, `unreliable.txt`, `not-mutated.txt`, a context diff and a log per mutant, and `outcomes.json`. Every result line includes the mutant id used by `diff/<id>.diff` and `logs/<id>.log`. Lines show the declared return type when available, or an abbreviated inferred type; JSON keeps full types and uses report `schemaVersion: 2`. New JSON reports and lists include `idEpoch`, `toolVersion`, and `typescriptVersion` (the compiler loaded by mutant.cafe). The TypeScript version is diagnostic metadata, not an input to IDs or the epoch. Reports without an epoch still load as legacy reports. Add `mutants.out*` to `.gitignore`. Your source tree is never edited: each mutant runs in a scratch copy. Workspace dependency links back into the copied source tree, including package self-links, point at the scratch packages rather than the originals. Mutation imports are added when the file has no usable value import for an Effect API.

`not-mutated.txt` gives one located line per considered function or Layer value with omitted mutations: `file:line:column`, target path and reason. Layer values use their initializer location; unavailable locations print `?:?`. It reports unsupported return fields, generic returns, explicit exclusions, capped values with an omitted count, and error classes whose constructors are unavailable. A constructor failure does not suppress recoveries or defects. Callbacks in arguments and arrays have their own locations; schema and brand constants are not functions. When a return cannot be synthesized but inner functions are mutated, the reason says so. The summary includes the line count. A target that the compiler cannot analyse gets a located `analysis failed` reason without aborting the remaining targets. Faults discovered during viability checks join the same skip report rather than becoming unviable outcomes. Config and program-load failures still stop the run. With `--in-diff`, only skips from files touched by the diff are reported. An empty selection, including a zero budget or a diff outside function bodies, skips the baseline, prints the selection count and cause to stderr, and writes a report with zero run and no baseline command. An empty actionable summary says “No actionable mutants.” The baseline command prints before execution when there are selected mutants. A failed baseline still writes `outcomes.json`, including its command and output tail; TypeScript load errors print the tsconfig path and diagnostics.

The default source scan skips support files under `test/`, `tests/`, `__tests__/` and `__mocks__/` at any depth. An explicit `--file` or config `include` can select them. For example, `include: ["src/**/*.ts"]` also selects matching files under `src/__mocks__/` and `src/__tests__/`. To keep those folders out while using an explicit include, set `exclude: ["**/{test,tests,__tests__,__mocks__}/**"]` in `mutants.config.json`. Declaration files, dependencies, and `*.test` and `*.spec` files remain excluded. An include glob that matches no source file is a usage error, including a path outside the package root. Diff paths resolve from the Git toplevel, with support for `git diff --relative`; outside Git they resolve from the working directory.

| Exit code | Meaning |
| --- | --- |
| 0 | no missed, unreliable, untested or timed-out mutants |
| 1 | usage, source or tsconfig error |
| 2 | some mutants were missed, or untested with no unreliable results |
| 3 | baseline deadline exceeded, or some mutants timed out with no missed, unreliable or untested results |
| 4 | baseline tests fail |
| 5 | the `--in-diff` diff does not match the tree |
| 6 | the diff cannot be parsed |
| 7 | some results are unreliable, with none missed |
| 8 | installed Vitest is older than 5.0 |
| 9 | duplicate mutant ID; generation stops before any artifacts can be overwritten |
| 70 | internal error |

A duplicate ID is a tool bug, not a source or tsconfig error. The CLI names both mutation sites and stops before running tests or writing results. Report the diagnostic as a bug. `--advisory` does not suppress exit 9.

Precedence is **missed (2), unreliable (7), untested (2), then timeout (3)**. A real miss wins over unreliable results; unreliable wins over an empty selection or timeout.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| caught | a test failed, or a collected test run hung on `Effect.never` past its measured budget |
| missed | the selected tests passed |
| unviable | the mutant does not type-check |
| timeout | the tests ran past the per-mutant budget without a reported failure or evidence of a caught `Effect.never` |
| untested | related selection found no test files and the full-suite fallback did not fail |
| unreliable | an unsupported runner, an omitted importing test, or a selected test reading a built self-entry instead of the affected source |

For built-in Node pools, mutant.cafe checks an empty related selection once per source file with a temporary module-load poison. The full suite must pass, its control hook must run, and no module-load signal may appear before any mutants in that file can be returned as untested without execution. A caught dynamic import still emits the signal, so it keeps per-mutant fallback. Probes and their durations appear in `reachabilityProbes` in the report. Unsupported pools and unreliable selections keep the existing fallback. This optimization applies to both cold and warm modes.

Vitest first runs tests related to the mutated file. When that selects no test files, mutant.cafe reruns the package's full suite within the remaining budget. A failing fallback counts as caught, including dynamic-import consumers. A passing fallback is untested, not missed: unrelated passing tests do not prove they reached the mutant.

Before the baseline, mutant.cafe checks `package.json`'s test script and asks the installed Vitest for its resolved test files. It warns when another runner owns the test script or a test importing a target is omitted. Test support imported by selected tests is not an omitted suite. Affected viable mutants are unreliable and are not scored as missed; their diagnostics name the script or omitted test. Common wrappers (`pnpm exec vitest`, `npx vitest`, `cross-env … vitest`, chained commands and `vitest --project`) count as Vitest scripts. Delegated scripts such as `turbo run test` or `pnpm -r test` are unverified, not declared non-Vitest.

Only an explicit non-Vitest runner skips the baseline and makes all results unreliable. Delegated or unknown scripts and failed selection probes warn but do not disable the Vitest baseline.

Self-imports that resolve to built JavaScript are scoped: the export's `types` condition or explicit tsconfig `rootDir`/`outDir` maps the entry back to source and its import closure. A mutant in that closure is unreliable only if its actual selected tests include a test that imports the built entry. If mapping is unavailable, only that selected-test condition applies. Selection comes from the running Vitest reporter, including a full-suite fallback. Other mutants run normally; a built self-import never disables the baseline. Remapping a package link cannot rebuild its output.

This does not add `node:test` support. Literal relative imports are traced transitively; computed imports remain subject to the full-suite fallback.

Selection and partial failures come from Vitest's reporter hooks, not its human-readable messages. A reported failure still counts as caught if another test file hangs.

### Warm and cold runs

The baseline has a 30-minute overall hang guard, including selection and process startup. Set `--baseline-timeout 2400` (seconds), or `baselineTimeoutMs` in `mutants.config.json`, for a longer suite. Expiry reports `BaselineTimedOut`, names the limit and flag, and exits 3 rather than calling the original tests failed. Each paired calibration run uses that same baseline budget independently, across all scratch copies. Each cold execution also includes startup in its existing per-run budget. Cold runs launch the installed project's Vitest bin through the current runtime, without an npm wrapper or shell lookup; the printed command names the actual generated launcher. Cleanup runs after deadline expiry before the next execution.

Cold, warm and preflight launches inherit only supported resolution flags from the parent runtime arguments: `--conditions` (`-C`), `--import`, `--require` (`-r`), Bun's `--preload`, and Node's `--experimental-loader` (`--loader`) and `--experimental-import-meta-resolve`. Relative preload and loader paths resolve from the original working directory. Debugger, entry, test and watch modes are dropped with a warning; other runtime arguments are not replayed. The installed runner is still Vitest when launched through Bun, not `bun test`.

Set `MUTANT_CAFE_PROCESS_TRACE=/absolute/path/trace.jsonl` to opt into timestamped startup and cleanup stages: parent spawn, preload, birth inspection, child spawn, Vitest resolution/start, test-module start and cwd inspection. Traces append process IDs, times and stage details, not arguments, environment contents or test output. No trace file is written by default.

By default, mutant.cafe first verifies a clean cold baseline and stops if it fails. It then excludes unviable and probe-cached mutants from calibration. Small runs stay cold without more baselines. Other runs measure warm and cold after the successful primer, so both use warmed filesystem inputs. Warm must select the same files, pass, and be at least 10% faster. At decision time the samples and opened copies are already paid for. Projected savings must cover only startup for copies not yet opened; sample costs remain in the report but do not bias the choice. Reports include the decision, measured costs and testable-mutant count. Use a forcing flag to avoid calibration.

A warm scratch copy keeps one instance of the project's installed Vitest. Mutations and restores invalidate the changed module and its importers before the next run. Vitest's normal per-file isolation resets module-level state. Both modes use the project's configured worker count, or Vitest's default. `--jobs N` uses N scratch copies.

Use `--cold` to start a fresh Vitest process for each mutant that needs tests, or `--warm` to force a persistent instance. The flags are mutually exclusive. Warm execution supports isolated built-in `forks` and `threads` pools on Vitest major 5, verified against 5.1.0. Other majors, VM pools, browser mode, custom pools, `globalSetup`, `isolate: false`, `poolOptions.*.isolate: false` and `--no-isolate` use cold execution. Auto prints one `Vitest auto mode: <cold|warm>; <reason>` line, including cold fallbacks. The mode and reason match the baseline in `outcomes.json`; `--warm` warns once with the reason. `baseline.runnerModeReason` records the reason in either mode. Selection-only hosts can inspect refused configurations but cannot execute tests; quiet logging never relaxes execution checks. The adapter also checks the private fields and transform/invalidation interfaces it uses. Falling back for `globalSetup` ensures each mutant initializes from its own source, just as cold execution does.

After every warm execution, mutant.cafe closes the disposable worker pool and reaps test-created descendants before the next mutant. The Vitest/Vite host and its startup services remain alive. Test and hook timeouts, parallel bail and ordinary unhandled errors do not restart a healthy host. An unhandled error is a caught failure unless the project ignores it. Real worker death gets one pool retry; a second death switches the remaining run to cold mode. Only an unhealthy host is replaced. Reports and summaries include host restarts and unexpected pool resets from crashes, outer-deadline recovery or cancellation. Routine pool disposal is not counted. A host health check performs a trivial Vite transform as well as an IPC round trip. Worker-budget telemetry comes from Vitest's resolved config and is omitted when unavailable. Invalid telemetry never changes a verdict or triggers a pool retry: outcomes are written first, then the reporter warns with the bad field and value.

Each Vitest instance has an ownership ledger. Child spawns inherit a unique label. Cleanup checks recorded PID identities, parent chains and escaped process groups with POSIX `ps`, then stops, kills and verifies the owned tree. Cleanup runs before reuse and on exit. Inspection or ownership failures warn with tracked PIDs, keep the ledger and let the run continue; an unhealthy host is not reused. Each ownership sweep shares a 10-second deadline across discovery, signalling and retries. Inspector calls allow two seconds, discovery seven seconds and signalling three seconds, all clamped to that shared deadline. These are hang guards, not clean-run speed targets. PPID descendants in the snapshot are claimed before fallible label inspection, so degraded cleanup claims unlabelled children before signalling their known parents. Inspector subprocesses receive cancellation signals; a stalled inspection cannot turn interruption into minutes of serial retries. If inspection fails or the budget expires, cleanup still attempts SIGKILL for PIDs already birth-matched in that sweep, then warns about unconfirmed exits and unverified ledger PIDs. A stale ledger entry alone never authorizes a signal. Zombies do not count as live survivors, and unverifiable PIDs are never signalled. Explicit child environments are left unchanged. The preload is appended only for implicit children using the current Node executable. Inspector environment output is never logged or included in reports. A minimal-env grandchild that daemonizes after its parent exits can escape cleanup. After each run, a scratch-path scan warns with the PIDs of unowned survivors; it never kills a process on a path match alone. The warning scan recognizes birth-validated PIDs from every live mutant.cafe ledger, including selector hosts. It reuses the latest PID/birth/argv snapshot and checks cwd only for unknown processes born since the scratch session opened. Darwin restricts `lsof` to those candidate PIDs, drops exited or inaccessible PIDs and preserves partial output when another candidate exits during inspection. This warning-only filter never changes ownership or kill permissions. Each executed result records `backstopMs`, the total scratch-path scan time during that mutant. Summaries show its per-mutant p50/p90; baseline and selector-only scans are not samples. In a Git repository, scratch copies tracked and untracked files, including ignored build output, generated code and environment files. It links independent ignored checkouts and dependency trees with their own `.git` or `node_modules` back to their original paths without traversing them; relative imports and shared configs remain available, but functions inside those links are reported as not mutated, with a reason, before `--max-mutants` is applied. They do not appear in `mutants.json` or consume the mutation budget. An all-linked selection skips scratch creation and the baseline. Direct mutant edits through those links are refused. Unreadable ignored paths are skipped with a warning naming the denied path; readable siblings remain in scratch. Trees named by package `exports`, `imports`, `main`, `module` and `types` are copied even when ignored or holding their own `node_modules`. If Git discovery fails, scratch warns and uses the recursive copy instead. Outside Git, scratch keeps the recursive copy behavior. A source entry that vanishes during copying is skipped with a debug note. Dangling symlinks are skipped with a warning; permission errors on tracked inputs or scratch destinations, and missing destinations, still fail the copy. Scratch removal allows 30 seconds for large workspaces and sends failures to stderr, never into GitHub Markdown output.

Ordinary mutants use the configured timeout. For `Effect.never`, the reporter measures each passing test in the clean baseline. The budget uses the slowest test among the related files, including any full-suite fallback. A related-file probe selects those files. Comparing each task's original and probe timeouts distinguishes explicit options from inherited defaults; the probe's imposed timeout is not an original limit. The test and hook timeout is that duration × the timeout multiplier, with a 2 s floor, rather than the duration of the whole suite. Explicit per-test timeout options remain in effect, including larger values. Vitest does not expose a configuration API to raise a smaller explicit per-test timeout; those tests still use their own value. Reports record the computed timeout on each mutant result. The report also records the baseline test duration used as the budget base and the separate outer deadline. An inherited config timeout does not raise the outer deadline. That deadline allows the original startup time and the selected baseline files' collection, environment, hook and test durations, not the duration of the whole package. Cold and warm modes use the same per-test budget policy, so switching modes alone does not shorten a hanging test's timeout. A process killed before test collection is not credited as caught. Other mutants keep the existing per-test timeout of half their run budget. Both modes stop after the first reported failure.

## Prior art

[StrykerJS](https://stryker-mutator.io) and its Effect 4 fork [stryker-js-effect](https://github.com/systemfsoftware/stryker-js-effect) mutate syntax (operators, literals, blocks, and some Effect concurrency faults) and use the type checker to discard mutants that don't compile. mutant.cafe uses the checker to generate mutants from types instead. Use both if you like; they find different gaps.

## License

MIT. Part of [rat-stack](https://ratstack.sh).
