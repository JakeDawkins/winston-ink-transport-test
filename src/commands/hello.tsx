import { Command, flags } from "@oclif/command";
import winston from "winston";
import Transport from "winston-transport";
import React from "react";
import { render, Color, Box, Text, Instance } from "ink";
import sleep from "sleep-promise";
import Spinner from "ink-spinner";

const treeLogFormatter = winston.format.printf(info => info.message);

const TaskTree = ({
  task,
  logsByTask
}: {
  task: Task<any> | null;
  logsByTask: Map<Task<any>, any[]>;
}) => {
  if (task == null) {
    return <Box>Initializing...</Box>;
  }

  const { title, status, subtasks, rootTask, parent } = task;
  // this is the root task -- it has no name/status that we care about
  const isRoot = !parent;

  const logs = logsByTask.get(task) || [];

  return (
    <Box flexDirection="column">
      {/* don't render spinner/done/error for root task -- it's unimportant */}
      {!isRoot && (
        <Box>
          {status === TaskStatus.RUNNING && (
            <Color green>
              <Spinner type="dots" />{" "}
            </Color>
          )}
          {status === TaskStatus.SUCEEDED && <Color green>{"✔ "}</Color>}
          {status === TaskStatus.FAILED && <Color red>{"X "}</Color>}
          {title && <Text>{title}</Text>}
        </Box>
      )}

      {logs && logs.length ? (
        <Box flexDirection="column" marginLeft={2}>
          {logs.map((log, i) => (
            // XXX filter out if transform returns falsey
            <Box key={i}>
              ✏️ {treeLogFormatter.transform(log)[Symbol.for("message")]}
            </Box>
          ))}
        </Box>
      ) : null}

      {subtasks && subtasks.length ? (
        <Box
          flexDirection="column"
          marginLeft={isRoot ? 0 : 2 /* don't indent top-level tasks*/}
        >
          {subtasks.map(subtask => (
            <TaskTree
              task={subtask}
              key={Math.random()}
              logsByTask={logsByTask}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
};

class WinstonInkTransport extends Transport {
  private ink: Instance;
  private logsByTask = new Map<Task<any>, any[]>();
  constructor(opts: any) {
    super(opts);
    this.ink = render(<TaskTree task={null} logsByTask={this.logsByTask} />);
  }

  log(info: any, cb: any) {
    if (!info.meta && info.task) {
      const task = info.task as Task<any>;
      if (!this.logsByTask.has(task)) {
        this.logsByTask.set(task, []);
      }
      this.logsByTask.get(task)!.push(info);
    }
    if (info.rootTask) {
      this.ink.rerender(
        <TaskTree task={info.rootTask} logsByTask={this.logsByTask} />
      );
    }
    cb();
  }

  finish() {
    this.ink.unmount();
  }
}

type TaskBody<T> = (t: Task<T>) => Promise<T>;

enum TaskStatus {
  PENDING,
  RUNNING,
  SUCEEDED,
  FAILED
}

// TODO use an interface so we don't need all the Task<any>?
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
    this.logger.info("starting", { meta: true });
    try {
      return await this.body(this);
    } catch (e) {
      this.setStatus(TaskStatus.FAILED);
      throw e;
    } finally {
      if (this._status !== TaskStatus.FAILED) {
        this.setStatus(TaskStatus.SUCEEDED);
      }
      this.logger.info("ending", { meta: true });
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
          await sleep(5000);
          t.logger.info("doing a nested thing");
        });
      });
      await Promise.all([
        t.task("parallel 1", async t => {
          t.logger.info("waiting");
          await sleep(1000);
          t.logger.info("done");
        }),
        t.task("parallel 2", async t => {
          t.logger.info("waiting longer");
          await sleep(3000);
          t.logger.info("done");
        })
      ]);
    });
  }
}
