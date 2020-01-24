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
  task: Task | null;
  logsByTask: Map<Task, any[]>;
}) => {
  if (task == null) {
    return <Box>Initializing...</Box>;
  }

  const { title, status, subtasks, parent } = task;
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
          {status === TaskStatus.PENDING && <Color gray>{"… "}</Color>}
          {title && <Text>{title}</Text>}
        </Box>
      )}

      {logs && logs.length ? (
        <Box flexDirection="column" marginLeft={2}>
          {logs.map((log, i) => (
            // XXX filter out if transform returns falsey
            <Box key={i}>
              {"🗒️ "} {treeLogFormatter.transform(log)[Symbol.for("message")]}
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
  private logsByTask = new Map<Task, any[]>();
  constructor(opts: any) {
    super(opts);
    this.ink = render(<TaskTree task={null} logsByTask={this.logsByTask} />);
  }

  log(info: any, cb: any) {
    if (info.task) {
      if (!info.meta) {
        const task = info.task as Task;
        if (!this.logsByTask.has(task)) {
          this.logsByTask.set(task, []);
        }
        this.logsByTask.get(task)!.push(info);
      }
      this.ink.rerender(
        <TaskTree task={info.task.rootTask()} logsByTask={this.logsByTask} />
      );
    }
    cb();
  }

  unmount() {
    this.ink.unmount();
  }
}

type TaskBody<T> = (t: Task) => Promise<T>;

enum TaskStatus {
  PENDING,
  RUNNING,
  SUCEEDED,
  FAILED
}

class Task {
  public readonly logger: winston.Logger;
  private _subtasks: Task[] = [];
  private _status: TaskStatus = TaskStatus.PENDING;
  private _title: string | null;
  constructor(
    logger: winston.Logger,
    title: string | null,
    public readonly parent: Task | null
  ) {
    if (title === null && parent !== null) {
      throw Error("Non-root tasks must have a title");
    }
    if (title != null && parent == null) {
      throw Error("Root tasks may not have a title");
    }
    this._title = title;
    this.logger = logger.child({
      task: this
    });
  }
  get subtasks(): ReadonlyArray<Task> {
    return this._subtasks;
  }
  get status(): TaskStatus {
    return this._status;
  }
  get title(): string | null {
    return this._title;
  }
  setTitle(title: string) {
    this._title = title;
    // Not sure how to best display this in CLI style logs.
    this.logger.info("title change", { meta: true });
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
  rootTask(): Task {
    return this.parent === null ? this : this.parent.rootTask();
  }

  private setStatus(status: TaskStatus) {
    this._status = status;
    this.logger.info("status change", { meta: true });
  }

  async run<T>(body: TaskBody<T>): Promise<T> {
    this.setStatus(TaskStatus.RUNNING);
    this.logger.info("starting", { meta: true });
    try {
      return await body(this);
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
    const subTask = new Task(this.logger, subTitle, this);
    this._subtasks.push(subTask);
    return await subTask.run(subBody);
  }

  async wait<U>(p: Promise<U>): Promise<U> {
    this.setStatus(TaskStatus.PENDING);
    try {
      return await p;
    } finally {
      this.setStatus(TaskStatus.RUNNING);
    }
  }
}

async function runTasks<T>(
  logger: winston.Logger,
  body: TaskBody<T>
): Promise<T> {
  return await new Task(logger, null, null).run(body);
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

    const inkTransport: WinstonInkTransport | null = flags.ink
      ? new WinstonInkTransport({})
      : null;

    const logger = winston.createLogger({
      transports: [
        inkTransport ??
          new winston.transports.Console({
            format: winston.format.combine(
              winston.format(info => {
                if (info.task instanceof Task && !info.task.isRoot()) {
                  info.message = `[${info.task.path().join(" -> ")}] ${
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

    try {
      await runTasks(logger, async t => {
        await t.task("A tree of tasks", async t => {
          t.logger.info("If a task logs,");
          t.logger.warn("it shows up at the right spot in the tree")
        });
        await t.task("These run sequentially", async t => {
          await t.task("... and can be nested", async t => {
            await sleep(300);
          });
          await t.task("... like this!", async t => {
            await sleep(500);
            await t.task("So deep!", async t => {});
          });
        });

        await t.task("Tasks can run in parallel", async t => {
          await Promise.all([
            t.task("And end in...", async t => {
              t.logger.info("Waiting a while");
              await sleep(5000);
              t.logger.info("Done!");
            }),
            t.task("...either order", async t => {
              t.logger.info("Waiting a bit");
              await sleep(2000);
              t.logger.info("Done!");
            })
          ]);
        });

        await t.task(
          "Tasks can run sequentially with later tasks 'pending', and change their titles",
          async t => {
            function appendTitle<T>(t: Task, toAppend: T): T {
              t.setTitle(`${t.title}: ${toAppend}!`);
              return toAppend;
            }
            const t1 = t.task("Calculate a number", async t => {
              await sleep(2000);
              return appendTitle(t, 123);
            });
            const t2 = t.task("Square it", async t => {
              const t1Result = await t.wait(t1);
              await sleep(2000);
              return appendTitle(t, t1Result * t1Result);
            });
            const t3 = t.task("Negate it", async t => {
              const t2Result = await t.wait(t2);
              await sleep(2000);
              return appendTitle(t, -t2Result);
            });
            await Promise.all([t1, t2, t3]);
          }
        );

        await t.task("Tasks can fail...", async t => {
          await t.task("... and they make their parents fail too.", async t => {
            t.logger.warn("I'm going to fail soon!");
            await sleep(500);
            throw new Error("oh no");
          });
        });

        await t.task("This task never shows up", async t => {});
      });
    } finally {
      if (flags.ink) {
        inkTransport?.unmount();
      }
    }
  }
}
