import { Command, flags } from "@oclif/command";
import winston from "winston";
import Transport from "winston-transport";
import React from "react";
import { render, Color, Box, Text } from "ink";
import sleep from "sleep-promise";
// import Spinner from "ink-spinner";

const TaskTree = ({
  task: { title, status, subtasks }
}: {
  task: Task<any>;
}) => {
  return (
    <Box flexDirection="column">
      <Box>
        {status === TaskStatus.PENDING && (
          <Box paddingRight={1} marginBottom={1}>
            <Color green>~</Color>
          </Box>
        )}
        {status === TaskStatus.SUCEEDED && <Color green>{"✔ "}</Color>}
        {status === TaskStatus.FAILED && <Color red>{"X "}</Color>}

        {title && <Text>{title}</Text>}
      </Box>

      {subtasks && subtasks.length && (
        <Box flexDirection="column" marginLeft={2}>
          {subtasks.map(subtask => (
            <TaskTree task={subtask} key={Math.random()} />
          ))}
        </Box>
      )}
    </Box>
  );
};

class WinstonInkTransport extends Transport {
  constructor(opts: any) {
    super(opts);
  }

  log({ level, message }: any, cb: any) {
    const { waitUntilExit } = render(
      <Color key={message} red={level === "error"} yellow={level === "warn"}>
        [{level}] {message}
      </Color>
    );
    waitUntilExit().then(() => {
      cb();
    });
  }
}

type TaskBody<T> = (t: Task<T>) => Promise<T>;

enum TaskStatus {
  PENDING,
  RUNNING,
  SUCEEDED,
  FAILED
}

class Task<T> {
  public readonly logger: winston.Logger;
  private _subtasks: Task<any>[] = [];
  private _status: TaskStatus = TaskStatus.PENDING;
  constructor(
    logger: winston.Logger,
    public readonly title: string | null,
    public readonly parent: Task<any> | null,
    private body: TaskBody<T>
  ) {
    if (title === null && parent !== null) {
      throw Error("Non-root tasks must have a title");
    }
    if (title != null && parent == null) {
      throw Error("Root tasks may not have a title");
    }
    this.logger = logger.child({
      taskTitle: this.title,
      path: this.path(),
      task: this,
      rootTask: this.rootTask()
    });
  }
  get subtasks(): ReadonlyArray<Task<any>> {
    return this._subtasks;
  }
  get status(): TaskStatus {
    return this._status;
  }
  isRoot() {
    return this.parent === null;
  }
  path(): string[] {
    if (this.title === null || this.parent === null) {
      return [];
    }
    return [...this.parent.path(), this.title];
  }
  rootTask(): Task<any> {
    return this.parent === null ? this : this.parent.rootTask();
  }

  private setStatus(status: TaskStatus) {
    this._status = status;
  }

  async run(): Promise<T> {
    this.setStatus(TaskStatus.RUNNING);
    this.logger.info("starting");
    try {
      return await this.body(this);
    } catch (e) {
      this.setStatus(TaskStatus.FAILED);
      throw e;
    } finally {
      if (this._status !== TaskStatus.FAILED) {
        this.setStatus(TaskStatus.SUCEEDED);
      }
      this.logger.info("ending");
    }
  }
  async task<U>(subTitle: string, subBody: TaskBody<U>) {
    const subTask = new Task(this.logger, subTitle, this, subBody);
    this._subtasks.push(subTask);
    return await subTask.run();
  }
}

async function runTasks<T>(
  logger: winston.Logger,
  body: TaskBody<T>
): Promise<T> {
  return await new Task(logger, null, null, body).run();
}

export default class Hello extends Command {
  static flags = {
    name: flags.string({ char: "n", description: "name to print" }),
    force: flags.boolean({ char: "f" }),
    ink: flags.boolean({ char: "i" })
  };

  async run() {
    const { flags } = this.parse(Hello);
    const name = flags.name || "world";

    const logger = winston.createLogger({
      transports: [
        flags.ink
          ? new WinstonInkTransport({})
          : new winston.transports.Console({
              format: winston.format.combine(
                winston.format(info => {
                  if (info.path) {
                    info.message = `[${info.path.join(" -> ")}] ${
                      info.message
                    }`;
                  }
                  return info;
                })(),
                winston.format.cli()
              )
            })
      ],
      exitOnError: false
    });

    logger.info(`hello ${name} from ./src/commands/hello.ts`);

    if (flags.force) logger.warn(`The --force is with you, ${name}.`);

    await runTasks(logger, async t => {
      await t.task("first thing", async t => {
        t.logger.info("first things first");
      });
      await t.task("second thing", async t => {
        t.logger.info("next things next");
        await t.task("nested under second", async t => {
          t.logger.info("doing a nested thing");
        });
      });
      await Promise.all([
        t.task("parallel 1", async t => {
          await sleep(500);
          t.logger.info("done");
        }),
        t.task("parallel 2", async t => {
          await sleep(500);
          t.logger.info("done");
        })
      ]);
    });
  }
}
