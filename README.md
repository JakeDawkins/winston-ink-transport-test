mynewcli
========



[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/mynewcli.svg)](https://npmjs.org/package/mynewcli)
[![Downloads/week](https://img.shields.io/npm/dw/mynewcli.svg)](https://npmjs.org/package/mynewcli)
[![License](https://img.shields.io/npm/l/mynewcli.svg)](https://github.com/JakeDawkins/mynewcli/blob/master/package.json)

<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g mynewcli
$ mynewcli COMMAND
running command...
$ mynewcli (-v|--version|version)
mynewcli/0.0.0 darwin-x64 node-v10.15.3
$ mynewcli --help [COMMAND]
USAGE
  $ mynewcli COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`mynewcli hello [FILE]`](#mynewcli-hello-file)
* [`mynewcli help [COMMAND]`](#mynewcli-help-command)

## `mynewcli hello [FILE]`

describe the command here

```
USAGE
  $ mynewcli hello [FILE]

OPTIONS
  -f, --force
  -h, --help       show CLI help
  -n, --name=name  name to print

EXAMPLE
  $ mynewcli hello
  hello world from ./src/hello.ts!
```

_See code: [src/commands/hello.ts](https://github.com/JakeDawkins/mynewcli/blob/v0.0.0/src/commands/hello.ts)_

## `mynewcli help [COMMAND]`

display help for mynewcli

```
USAGE
  $ mynewcli help [COMMAND]

ARGUMENTS
  COMMAND  command to show help for

OPTIONS
  --all  see all commands in CLI
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v2.2.3/src/commands/help.ts)_
<!-- commandsstop -->
