# Changelog

## 0.1.8

- Preserve supported resolution flags across cold and warm Vitest launches and preflight. Resolve relative runtime preloads from the original working directory, not the scratch copy. Skip entry, debugger, test and watch modes. Reports retain the exact cold command, including any preload arguments. Thanks [@dallenpyrah](https://github.com/dallenpyrah) ([#4](https://github.com/joelhooks/mutant-cafe/pull/4)).
- Register owned Vitest processes with Bun's native preload when mutant.cafe is launched via Bun. The Bun CI job checks process ownership and verifies that the CLI diagnostic identifies the launcher after the preload. Thanks [@dallenpyrah](https://github.com/dallenpyrah) ([#5](https://github.com/joelhooks/mutant-cafe/pull/5), [#8](https://github.com/joelhooks/mutant-cafe/issues/8)). This still runs Vitest, not `bun test`.
- Projects launched with `--import tsx` or `--conditions` can get different results now that loader and condition flags reach the Vitest child processes.
- `testCommand` records the argv actually passed to the runtime, including absolute preload paths and temporary launcher, reporter and Bun ownership script paths. Those paths explain what ran from scratch; the command is diagnostic, not a stable key or a replay command. Review paths before sharing reports.
- Mutant IDs are unchanged from 0.1.7.
