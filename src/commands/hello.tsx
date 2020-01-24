import { Command, flags } from "@oclif/command";
import winston from "winston";
import logform from "logform";
import Transport from "winston-transport";
import React from "react";
import { render, Color, Box, Text, Instance } from "ink";
import sleep from "sleep-promise";
import Spinner from "ink-spinner";
import colors from "colors/safe";

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
          {status === TaskStatus.FAILED && <Color red>{"✖️ "}</Color>}
          {status === TaskStatus.PENDING && <Color gray>{"… "}</Color>}
          {title && <Text>{title}</Text>}
        </Box>
      )}

      {logs && logs.length ? (
        <Box flexDirection="column" marginLeft={2}>
          {logs
            .map(
              log => treeLogFormatter.transform(log)?.[Symbol.for("message")]
            )
            .filter(m => m)
            .map((message, i) => (
              <Box key={i}>
                {"🗒️ "} {message}
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
      if (!info.taskEvent) {
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
interface TaskLogEventStatusChange {
  statusChange: { oldStatus?: TaskStatus; newStatus: TaskStatus };
}
interface TaskLogEventTitleChange {
  titleChange: { oldTitle: string; newTitle: string };
}

type TaskLogEvent = TaskLogEventStatusChange | TaskLogEventTitleChange;

type TaskLogInfo = logform.TransformableInfo & {
  task: Task;
  taskEvent?: TaskLogEvent;
};

class Task {
  public readonly logger: winston.Logger;
  private _subtasks: Task[] = [];
  private _status!: TaskStatus; // ! is our way of convincing TypeScript that we initialize it via setStatus
  private _originalTitle: string | null;
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
    if (parent) {
      parent._subtasks.push(this);
    }
    this._originalTitle = title;
    this._title = title;
    this.logger = logger.child({
      task: this
    });

    // This needs to be last, since it sends a message that triggers
    // Ink refresh.
    this.setStatus(TaskStatus.PENDING);
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
  // setTitle updates the title for Ink view, but not for the normal log view's path.
  // For the normal log view, it logs logRecord instead.
  setTitle(newTitle: string, logRecord: winston.LogEntry) {
    const oldTitle = this._title;
    this._title = newTitle;
    this.logger.log({
      ...logRecord,
      taskEvent: {
        titleChange: {
          newTitle,
          oldTitle
        }
      }
    });
  }
  isRoot() {
    return this.parent === null;
  }
  path(): string[] {
    if (this._originalTitle === null || this.parent === null) {
      return [];
    }
    return [...this.parent.path(), this._originalTitle];
  }
  rootTask(): Task {
    return this.parent === null ? this : this.parent.rootTask();
  }

  private setStatus(newStatus: TaskStatus) {
    const oldStatus = this._status;
    if (oldStatus !== newStatus) {
      this._status = newStatus;
      this.logger.log({
        level: "task",
        message: "status-change",
        taskEvent: {
          statusChange: {
            newStatus,
            oldStatus
          }
        }
      });
    }
  }

  async run<T>(body: TaskBody<T>): Promise<T> {
    this.setStatus(TaskStatus.RUNNING);
    try {
      return await body(this);
    } catch (e) {
      this.setStatus(TaskStatus.FAILED);
      throw e;
    } finally {
      if (this._status !== TaskStatus.FAILED) {
        this.setStatus(TaskStatus.SUCEEDED);
      }
    }
  }

  async task<U>(subTitle: string, subBody: TaskBody<U>) {
    const subTask = new Task(this.logger, subTitle, this);
    return await subTask.run(subBody);
  }

  async pendingTask<U>(
    subTitle: string,
    pendingUntil: Promise<unknown>[],
    subBody: TaskBody<U>
  ) {
    const subTask = new Task(this.logger, subTitle, this);
    await Promise.all(pendingUntil);
    return await subTask.run(subBody);
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
    output: flags.string({
      char: "o",
      default: "ink",
      options: ["ink", "json", "json-pretty", "logs", "logs-monochrome"]
    })
  };

  async run() {
    const { flags } = this.parse(Hello);
    const name = flags.name || "world";

    let transport: Transport;
    const customLevels = {
      levels: {
        error: 0,
        warn: 1,
        info: 2,
        task: 3,
        debug: 4
      },
      colors: {
        error: "red",
        warn: "yellow",
        info: "green",
        task: "magenta",
        debug: "blue"
      }
    };

    switch (flags.output) {
      case "ink":
        transport = new WinstonInkTransport({});
        break;
      case "logs":
      case "logs-monochrome": {
        const formats = [
          winston.format(info => {
            if (info.task instanceof Task) {
              const event = info as TaskLogInfo;
              if (event.task.isRoot()) {
                return false;
              }
              let color: ((s: string) => string) | undefined;
              if (event.taskEvent) {
                if ("statusChange" in event.taskEvent) {
                  switch (event.taskEvent.statusChange.newStatus) {
                    case TaskStatus.RUNNING:
                      color = colors.magenta;
                      event.message = "Starting!";
                      break;
                    case TaskStatus.SUCEEDED:
                      color = colors.green;
                      event.message = "✔ Success!";
                      break;
                    case TaskStatus.FAILED:
                      color = colors.red;
                      event.message = "✖️ Failed!";
                      break;
                    case TaskStatus.PENDING:
                      // Don't log anything for a pending task.
                      return false;
                    default:
                      throw Error(`unknown end status ${event.task.status}`);
                  }
                }
                // Don't specially handle title change: we expect title changes to come with a log record.
              }
              event.message = `[${event.task.path().join(" -> ")}] ${
                event.message
              }`;
              if (color) {
                event.message = color(event.message);
              }
            }
            return info;
          })(),
          winston.format.cli({ levels: customLevels.levels })
        ];
        if (flags.output === "logs-monochrome") {
          formats.push(winston.format.uncolorize());
        }
        transport = new winston.transports.Console({
          format: winston.format.combine(...formats)
        });
        break;
      }
      case "json":
      case "json-pretty":
        transport = new winston.transports.Console({
          format: winston.format.combine(
            winston.format(info => {
              if (info.task instanceof Task) {
                info.task = info.task.path();
              }
              return info;
            })(),
            winston.format.json({
              space: flags.output === "json-pretty" ? 2 : undefined
            })
          )
        });
        break;
      default:
        throw Error("invalid output format");
    }

    const logger = winston.createLogger({
      transports: [transport],
      // XXX one big problem with using Winston to update Ink is that if we set
      //     the log level to something that blocks the metadata updates, Ink breaks???
      //     maybe we just don't support setting log levels in ink mode.
      level: "task",
      levels: customLevels.levels
    });
    winston.addColors(customLevels.colors);

    logger.info(`hello ${name} from ./src/commands/hello.ts`);

    if (flags.force) logger.warn(`The --force is with you, ${name}.`);

    try {
      try {
        await runTasks(logger, async t => {
          await t.task("A tree of tasks", async t => {
            t.logger.info("If a task logs...");
            t.logger.warn("... it shows up at the right spot in the tree");
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
              function appendTitle<T>(t: Task, result: T): T {
                t.setTitle(`${t.title}: ${result}!`, {
                  level: "info",
                  message: `Result is ${result}!`
                });
                return result;
              }
              const t1 = t.task("Calculate a number", async t => {
                await sleep(2000);
                return appendTitle(t, 123);
              });
              const t2 = t.pendingTask("Square it", [t1], async t => {
                const t1Result = await t1;
                await sleep(2000);
                return appendTitle(t, t1Result * t1Result);
              });
              const t3 = t.pendingTask("Negate it", [t2], async t => {
                const t2Result = await t2;
                await sleep(2000);
                return appendTitle(t, -t2Result);
              });
              await Promise.all([t1, t2, t3]);
            }
          );

          await t.task("Tasks can fail...", async t => {
            await t.task(
              "... and they make their parents fail too.",
              async t => {
                t.logger.warn("I'm going to fail soon!");
                await sleep(500);
                throw new Error("oh no");
              }
            );
          });

          await t.task("This task never shows up", async t => {});
        });
      } finally {
        if (transport instanceof WinstonInkTransport) {
          transport.unmount();
        }
      }
    } catch (e) {
      // XXX currently this error isn't displaying in ink mode --- probably should move it before
      //     unmount and make sure that non-task logs show up somewhere?
      logger.error(`Command failed: ${e.message}`, { error: e });
      this.exit(1);
    }
  }
}
