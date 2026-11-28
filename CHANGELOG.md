# Changelog

## 0.2.0

- **New ID epoch.** Reset ID-keyed comparisons for this release. IDs change once; they no longer depend on source spans and stay stable across file filters and formatting-only edits. JSON lists and reports now include `idEpoch` and `toolVersion`. Old reports remain readable; don't join their IDs to this epoch. Thanks [@dallenpyrah](https://github.com/dallenpyrah) ([#7](https://github.com/joelhooks/mutant-cafe/pull/7)).
- Test support files stay out of the default scan. An explicit `--file` or config `include` opts them in without enabling declarations, dependencies, or test assertions. Thanks [@dallenpyrah](https://github.com/dallenpyrah) ([#6](https://github.com/joelhooks/mutant-cafe/pull/6)).
- Synthesized values use deterministic property order and tie-breaking across filters. Capped tagged unions still try the original discriminant first, then the others in declaration order. Thanks [@dallenpyrah](https://github.com/dallenpyrah) ([#9](https://github.com/joelhooks/mutant-cafe/pull/9)).

## 0.1.8

- Preserve supported resolution flags across cold and warm Vitest launches and preflight. Resolve relative runtime preloads from the original working directory, not the scratch copy. Skip entry, debugger, test and watch modes. Reports retain the exact cold command, including any preload arguments. Thanks [@dallenpyrah](https://github.com/dallenpyrah) ([#4](https://github.com/joelhooks/mutant-cafe/pull/4)).
- Register owned Vitest processes with Bun's native preload when mutant.cafe is launched via Bun. The Bun CI job checks process ownership and verifies that the CLI diagnostic identifies the launcher after the preload. Thanks [@dallenpyrah](https://github.com/dallenpyrah) ([#5](https://github.com/joelhooks/mutant-cafe/pull/5), [#8](https://github.com/joelhooks/mutant-cafe/issues/8)). This still runs Vitest, not `bun test`.
- Runtime conditions now reach Vitest processes. For example, `--conditions` can change which branch Node or Bun selects when `vitest.config` resolves a conditional package import at runtime. This does not set Vite's `resolve.conditions` for modules Vite transforms.
- User preloads such as `--import tsx` now also run in the preflight probe, the warm host, and every cold Vitest child. A preload with side effects can therefore run more than once per mutation run.
- `testCommand` records the argv actually passed to the runtime, including absolute preload paths and temporary launcher, reporter and Bun ownership script paths. Those paths explain what ran from scratch; the command is diagnostic, not a stable key or a replay command. Review paths before sharing reports.
- Mutant IDs are unchanged from 0.1.7.
