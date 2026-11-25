---
"tapflow": minor
"@tapflowio/flow-runner": minor
---

`tapflow flow import --from maestro` converts Maestro flows into tapflow flows (#1094). A flow converts whole or not at all: when a command has no tapflow step, no file is written for that flow and the command is reported with its file and line. `runFlow` subflows are inlined and `${NAME}` is filled from the flow's `env` or `--env`. `--report` writes the result as JSON in a format that names no source tool, and `@tapflowio/flow-runner` exports `convertMaestroFlow` and `flowToYaml`.
