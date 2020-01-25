import { Command, flags } from "@oclif/command";
import winston, { transports } from "winston";
import logform from "logform";
import Transport from "winston-transport";
import React from "react";
import{ Instance as InkInstance, render as inkRender, Color, Box, Text } from "ink";
import sleep from "sleep-promise";
import Spinner from "ink-spinner";
import colors from "colors/safe";
import Emittery from "emittery";

const treeLogFormatter = winston.format.printf(info => info.message);

const TaskHeader = ({ task }: { task: Task }) => (
  <Box>
    {
      {
        [TaskStatus.RUNNING]: (
          <Color green>
            <Spinner type="dots" />{" "}
          </Color>
        ),
        [TaskStatus.SUCEEDED]: <Color green>{"✔ "}</Color>,
        [TaskStatus.FAILED]: <Color red>{"✖️ "}</Color>,
        [TaskStatus.PENDING]: <Color gray>{"… "}</Color>
      }[task.status]
    }
    {task.title && <Text>{task.title}</Text>}
  </Box>
);

const TaskLogs = ({ logs }: { logs: any[] }) => (
  <Box flexDirection="column" marginLeft={2}>
    {logs
      .map(log => treeLogFormatter.transform(log)?.[Symbol.for("message")])
      .filter(m => m)
      .map((message, i) => (
        <Box key={i}>
          {"🗒️ "} {message}
        </Box>
      ))}
  </Box>
);

const TaskTree = ({
  tasks,
  logsByTask
}: {
  tasks: readonly Task[];
  logsByTask: Map<Task, any[]>;
}) => (
  <Box flexDirection="column">
    {tasks.map((task, i) => (
      <Box flexDirection="column" key={i}>
        <TaskHeader task={task} />
        <TaskLogs logs={logsByTask.get(task) || []} />
        <Box marginLeft={2}>
          <TaskTree tasks={task.subtasks} logsByTask={logsByTask} />
        </Box>
      </Box>
    ))}
  </Box>
);

interface TaskUI {
  start(runner: TaskRunner): () => void;
  winstonTransport(): Transport;
}

class InkTaskUI implements TaskUI {
  private ink: InkInstance | null = null;
  private taskRunner: TaskRunner | null = null;
  private readonly logsByTask = new Map<Task, any[]>();
  start(taskRunner: TaskRunner) {
    this.taskRunner = taskRunner;
    this.ink = inkRender(this.rootComponent());
    const stoppers = [
      taskRunner.emitter.on("statusChange", () => this.rerender()),
      taskRunner.emitter.on("titleChange", () => this.rerender())
    ];
    return () => {
      stoppers.forEach(s => s());
      // XXX waitUntilExit?
      this.ink!.unmount();
      this.taskRunner = null;
      this.ink = null;
    };
  }
  winstonTransport(): Transport {
    return new Transport({
      log: (info: any, next: () => void) => {
        if (info.task) {
          const task = info.task as Task;
          if (!this.logsByTask.has(task)) {
            this.logsByTask.set(task, []);
          }
          this.logsByTask.get(task)!.push(info);
          this.rerender();
        }
        next();
      }
    });
  }
  private rerender() {
    this.ink!.rerender(this.rootComponent());
  }
  private rootComponent() {
    return (
      <TaskTree
        // XXX eliminate rootTask?
        // XXX eliminate all these bangs?
        tasks={this.taskRunner!.rootTask.subtasks}
        logsByTask={this.logsByTask}
      />
    );
  }
}

class LoggingTaskUI implements TaskUI {
  constructor(private format: logform.Format) {}
  private taskRunner: TaskRunner | null = null;
  start(taskRunner: TaskRunner) {
    this.taskRunner = taskRunner;
    const onTitleChange = () => 0;
    const stoppers = [
      taskRunner.emitter.on("statusChange", taskEvent => {
        taskEvent.task.logger.log({
          level: "task",
          message: "statusChange",
          taskEvent
        });
        // ...
      }),
      taskRunner.emitter.on("titleChange", ({ task, logEntry }) => {
        task.logger.log(logEntry);
      })
    ];
    return () => {
      stoppers.forEach(s => s());
      this.taskRunner = null;
    };
  }
  winstonTransport(): Transport {
    return new winston.transports.Console({
      format: this.format
    });
  }
}

// here's a bit of an XXX issue:
//  - InkTaskTree wants a TaskRunner
//  - TaskRunner wants a Logger
//  - Logger wants a Transport
//  - Transport wants an InkTaskTree
// I think I break this by adding the transport later?
// no actually I first make the InkTaskUI, then make a Logger from it, then make a TaskRunner from that

// I think that LoggingTaskUI provides a transport and also converts statusChange/titleChange into extra log lines

type TaskBody<T> = (t: Task) => Promise<T>;

enum TaskStatus {
  PENDING,
  RUNNING,
  SUCEEDED,
  FAILED
}

// XXX use this to define events
interface TaskLogEventStatusChange {
  statusChange: { task: Task; oldStatus?: TaskStatus; newStatus: TaskStatus };
}
interface TaskLogEventTitleChange {
  titleChange: { task: Task; oldTitle: string; newTitle: string };
}

type TaskLogInfo = logform.TransformableInfo &
  (TaskLogEventStatusChange | TaskLogEventTitleChange);

interface TaskRunnerEvents {
  statusChange: { task: Task; oldStatus?: TaskStatus; newStatus: TaskStatus };
  titleChange: {
    task: Task;
    oldTitle: string;
    newTitle: string;
    logEntry: winston.LogEntry;
  };
}
class TaskRunner {
  // XXX eliminating root task would be great because right now root task emits
  // as soon as created, yuck
  public readonly emitter = new Emittery.Typed<TaskRunnerEvents>();
  public readonly rootTask = new Task(this, null, null);
  constructor(public readonly logger: winston.Logger) {}

  async run<T>(ui: TaskUI, body: TaskBody<T>): Promise<T> {
    const stopUI = ui.start(this);
    try {
      return await this.rootTask.run(body);
    } finally {
      stopUI();
    }
  }
}

class Task {
  public readonly logger: winston.Logger;
  private _subtasks: Task[] = [];
  private _status!: TaskStatus; // ! is our way of convincing TypeScript that we initialize it via setStatus
  private _originalTitle: string | null;
  private _title: string | null;
  constructor(
    public readonly runner: TaskRunner,
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
    this.logger = runner.logger.child({
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
  // XXX update this comment
  // setTitle updates the title for Ink view, but not for the normal log view's path.
  // For the normal log view, it logs logEntry instead.
  setTitle(newTitle: string, logEntry: winston.LogEntry) {
    const oldTitle = this._title!;  // XXX ban root
    this._title = newTitle;
    this.runner.emitter.emit("titleChange", {
      task: this,
      newTitle,
      oldTitle,
      logEntry
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

  private setStatus(newStatus: TaskStatus) {
    const oldStatus = this._status;
    if (oldStatus !== newStatus) {
      this._status = newStatus;
      this.runner.emitter.emit("statusChange", {
        task: this,
        newStatus,
        oldStatus
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
    const subTask = new Task(this.runner, subTitle, this);
    return await subTask.run(subBody);
  }

  async pendingTask<U>(
    subTitle: string,
    pendingUntil: Promise<unknown>[],
    subBody: TaskBody<U>
  ) {
    const subTask = new Task(this.runner, subTitle, this);
    await Promise.all(pendingUntil);
    return await subTask.run(subBody);
  }
}

export default class Hello extends Command {
  static flags = {
    output: flags.string({
      char: "o",
      default: "ink",
      options: ["ink", "json", "json-pretty", "logs", "logs-monochrome"]
    })
  };

  async run() {
    const { flags } = this.parse(Hello);

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
    winston.addColors(customLevels.colors);

    let taskUI: TaskUI;

    if (true) {
      taskUI = new InkTaskUI();
    }

    const logger = winston.createLogger({
      transports: [taskUI.winstonTransport()],
      level: "task",
      levels: customLevels.levels
    });

    // switch (flags.output) {
    //   case "ink": {
    //     const transport = new WinstonInkTransport({});
    //     const logger = winston.createLogger({
    //       transports: [transport],
    //       // XXX one big problem with using Winston to update Ink is that if we set
    //       //     the log level to something that blocks the metadata updates, Ink breaks???
    //       //     maybe we just don't support setting log levels in ink mode.
    //       level: "task",
    //       levels: customLevels.levels
    //     });

    //     break;
    //   }
    //   case "logs":
    //   case "logs-monochrome": {
    //     const formats = [
    //       winston.format(info => {
    //         if (info.task instanceof Task) {
    //           const event = info as TaskLogInfo;
    //           if (event.task.isRoot()) {
    //             return false;
    //           }
    //           let color: ((s: string) => string) | undefined;
    //           if (event.taskEvent) {
    //             if ("statusChange" in event.taskEvent) {
    //               switch (event.taskEvent.statusChange.newStatus) {
    //                 case TaskStatus.RUNNING:
    //                   color = colors.magenta;
    //                   event.message = "Starting!";
    //                   break;
    //                 case TaskStatus.SUCEEDED:
    //                   color = colors.green;
    //                   event.message = "✔ Success!";
    //                   break;
    //                 case TaskStatus.FAILED:
    //                   color = colors.red;
    //                   event.message = "✖️ Failed!";
    //                   break;
    //                 case TaskStatus.PENDING:
    //                   // Don't log anything for a pending task.
    //                   return false;
    //                 default:
    //                   throw Error(`unknown end status ${event.task.status}`);
    //               }
    //             }
    //             // Don't specially handle title change: we expect title changes to come with a log record.
    //           }
    //           event.message = `[${event.task.path().join(" -> ")}] ${
    //             event.message
    //           }`;
    //           if (color) {
    //             event.message = color(event.message);
    //           }
    //         }
    //         return info;
    //       })(),
    //       winston.format.cli({ levels: customLevels.levels })
    //     ];
    //     if (flags.output === "logs-monochrome") {
    //       formats.push(winston.format.uncolorize());
    //     }
    //     transport = new winston.transports.Console({
    //       format: winston.format.combine(...formats)
    //     });
    //     break;
    //   }
    //   case "json":
    //   case "json-pretty":
    //     transport = new winston.transports.Console({
    //       format: winston.format.combine(
    //         winston.format(info => {
    //           if (info.task instanceof Task) {
    //             info.task = info.task.path();
    //           }
    //           return info;
    //         })(),
    //         winston.format.json({
    //           space: flags.output === "json-pretty" ? 2 : undefined
    //         })
    //       )
    //     });
    //     break;
    //   default:
    //     throw Error("invalid output format");
    // }

    const runner = new TaskRunner(logger);

    try {
      console.log("WHAT")
      await runner.run(taskUI, async t => {
        console.log("HI");
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
          await t.task("... and they make their parents fail too.", async t => {
            t.logger.warn("I'm going to fail soon!");
            await sleep(500);
            throw new Error("oh no");
          });
        });

        await t.task("This task never shows up", async t => {});
      });
    } catch (e) {
      // XXX currently this error isn't displaying in ink mode --- probably should move it before
      //     unmount and make sure that non-task logs show up somewhere?
      console.log("yikes", e)
      logger.error(`Command failed: ${e.message}`, { error: e });
      this.exit(1);
    }
  }
}
