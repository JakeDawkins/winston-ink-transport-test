import { Command, flags } from "@oclif/command";
import winston from "winston";
import logform from "logform";
import Transport from "winston-transport";
import React from "react";
import {
  Instance as InkInstance,
  render as inkRender,
  Color,
  Box,
  Text
} from "ink";
import sleep from "sleep-promise";
import Spinner from "ink-spinner";
import colors from "colors/safe";
import Emittery from "emittery";

const treeLogFormatter = winston.format.printf(info => info.message);

/**
 * Just prints the title of the task, preceded by a check/x/...
 */
const TaskHeader = ({ task }: { task: Task }) => (
  <Box>
    {
      {
        [TaskStatus.RUNNING]: (
          <Color green>
            <Spinner type="dots" />{" "}
          </Color>
        ),
        [TaskStatus.SUCCEEDED]: <Color green>{"✔ "}</Color>,
        [TaskStatus.FAILED]: <Color red>{"✖️ "}</Color>,
        [TaskStatus.PENDING]: <Color gray>{"… "}</Color>
      }[task.status]
    }
    {task.title && <Text>{task.title}</Text>}
  </Box>
);

/**
 * if a task has logs associated with it, this prints them all, one at a time
 * padded, formatted with a notepad emoji before each
 */
const TaskLogs = ({ logs }: { logs: any[] }) => (
  <Box flexDirection="column" marginLeft={2}>
    {logs
      .map(log => treeLogFormatter.transform(log)?.[Symbol.for("message")])
      .filter(m => m)
      .map((message, i) => (
        // index-as-key is safe because logs are append-only
        <Box key={i}>
          {"🗒️ "} {message}
        </Box>
      ))}
  </Box>
);

/**
 * renders out a task, its associated logs and subtasks (recursively)
 */
const TaskTree = ({
  tasks,
  logsByTask
}: {
  tasks: readonly Task[];
  logsByTask: Map<Task, any[]>;
}) => (
  <Box flexDirection="column">
    {tasks.map((task, i) => (
      // index-as-key is safe because tasks are append-only
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

/**
 * interface for different UI patterns that winston can handle.
 *
 * - The `start` function returns a "cleanup" function that will be run once
 *   the root task has complete (the command finishes).
 * - The winstonTransport fn returns a Transport that can be used to log
 *   events.
 */
interface TaskUI {
  start(runner: TaskRunner): () => void;
  winstonTransport(): Transport;
}

/**
 * TaskUI implementation for rendering to the console using Ink (React)
 */
class InkTaskUI implements TaskUI {
  private ink: InkInstance | null = null;
  private taskRunner: TaskRunner | null = null;
  private readonly logsByTask = new Map<Task, any[]>();

  /**
   * sets up the react renderes which listens to emitter events to rerender
   * the task tree
   */
  start(taskRunner: TaskRunner) {
    this.taskRunner = taskRunner;
    this.ink = inkRender(this.rootComponent());
    /* this is called stoppers, because emitter.on returns an "unsubscribe"
     * functions. So the actual items in this list are unsubscribers to be
     * called when when the "stop" fn is run.
     */
    const stoppers = [
      taskRunner.emitter.on("statusChange", () => this.rerender()),
      taskRunner.emitter.on("titleChange", () => this.rerender())
    ];

    /**
     * Cleanup function:
     * - unsubscribe from events
     * - unmount react tree
     * - reset all runners/logs
     */
    return () => {
      stoppers.forEach(s => s());
      // XXX waitUntilExit?
      this.ink!.unmount();
      this.taskRunner = null;
      this.ink = null;
      this.logsByTask.clear();
    };
  }

  /**
   *
   */
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
        // XXX eliminate all these bangs?
        tasks={this.taskRunner!.subtasks}
        logsByTask={this.logsByTask}
      />
    );
  }
}

class LoggingTaskUI implements TaskUI {
  constructor(private format: logform.Format) {}
  start(taskRunner: TaskRunner) {
    const stoppers = [
      taskRunner.emitter.on(
        "statusChange",
        ({ task, oldStatus, newStatus }) => {
          task.logger.log({
            level: "task",
            message: "statusChange",
            taskEvent: { statusChange: { oldStatus, newStatus } }
          });
          // ...
        }
      ),
      taskRunner.emitter.on("titleChange", ({ task, logEntry }) => {
        task.logger.log(logEntry);
      })
    ];
    return () => {
      stoppers.forEach(s => s());
    };
  }
  winstonTransport(): Transport {
    return new winston.transports.Console({
      format: this.format
    });
  }
}

type RootTaskBody<T> = (t: TaskContainer) => Promise<T>;
type TaskBody<T> = (t: Task) => Promise<T>;

enum TaskStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  SUCCEEDED = "SUCCEEDED",
  FAILED = "FAILED"
}

// Defines the emittery events that TaskRunner.emitter uses.
interface TaskRunnerEvents {
  statusChange: { task: Task; oldStatus?: TaskStatus; newStatus: TaskStatus };
  titleChange: {
    task: Task;
    oldTitle: string;
    newTitle: string;
    logEntry: winston.LogEntry;
  };
}

// This defines the task field that Task.logger adds to every message logged
// through it, and the taskEvent field that LoggingTaskUI adds to log
// entries based on TaskRunner events.
//
type TaskLogInfo = logform.TransformableInfo & {
  task: Task;
  taskEvent:
    | { titleChange: { task: Task; oldTitle: string; newTitle: string } }
    | { statusChange: { oldStatus?: TaskStatus; newStatus: TaskStatus } };
};

abstract class TaskContainer {
  abstract get parent(): TaskContainer | null;
  abstract get runner(): TaskRunner;
  abstract path(): string[];

  private readonly _subtasks: Task[] = [];
  get subtasks(): ReadonlyArray<Task> {
    return this._subtasks;
  }
  // would make this protected but can't
  addTask(t: Task) {
    if (t.parent !== this) {
      throw Error("addTask called wrong");
    }
    this._subtasks.push(t);
  }
  isRoot() {
    return this.parent === null;
  }

  async task<U>(subTitle: string, subBody: TaskBody<U>) {
    const subTask = new Task(this, this.runner, subTitle);
    return await subTask.run(subBody);
  }

  async pendingTask<U>(
    subTitle: string,
    pendingUntil: Promise<unknown>[],
    subBody: TaskBody<U>
  ) {
    const subTask = new Task(this, this.runner, subTitle);
    await Promise.all(pendingUntil);
    return await subTask.run(subBody);
  }
}

class TaskRunner extends TaskContainer {
  public readonly emitter = new Emittery.Typed<TaskRunnerEvents>();

  constructor(public readonly logger: winston.Logger) {
    super();
  }

  get parent() {
    return null;
  }
  get runner() {
    return this;
  }
  path() {
    return [];
  }

  async run<T>(ui: TaskUI, body: RootTaskBody<T>): Promise<T> {
    const stopUI = ui.start(this);
    try {
      return await body(this);
    } finally {
      stopUI();
    }
  }
}

class Task extends TaskContainer {
  public readonly logger: winston.Logger;
  private _status!: TaskStatus; // ! is our way of convincing TypeScript that we initialize it via setStatus
  private _updatedTitle: string;
  private _title: string;
  constructor(
    readonly parent: TaskContainer,
    readonly runner: TaskRunner,
    title: string
  ) {
    super();
    parent.addTask(this);
    this._title = title;
    this._updatedTitle = title;
    this.logger = this.runner.logger.child({
      task: this
    });

    // This needs to be last, since it sends a message that triggers
    // Ink refresh.
    this.setStatus(TaskStatus.PENDING);
  }
  path(): string[] {
    return [...this.parent.path(), this._title];
  }
  get status(): TaskStatus {
    return this._status;
  }
  get title(): string {
    return this._title;
  }

  // setTitle updates the title for InkTaskUI, but not for the path displayed
  // by LoggingTaskUI. For LoggingTaskUI it just logs logEntry instead.
  setTitle(newTitle: string, logEntry: winston.LogEntry) {
    const oldTitle = this._updatedTitle!; // XXX ban root
    this._updatedTitle = newTitle;
    this.runner.emitter.emit("titleChange", {
      task: this,
      newTitle,
      oldTitle,
      logEntry
    });
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
        this.setStatus(TaskStatus.SUCCEEDED);
      }
    }
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

    switch (flags.output) {
      case "ink":
        taskUI = new InkTaskUI();
        break;
      case "logs":
      case "logs-monochrome": {
        const formats = [
          winston.format(info => {
            if (info.task instanceof Task) {
              const event = info as TaskLogInfo;
              let color: ((s: string) => string) | undefined;
              if (event.taskEvent) {
                if ("statusChange" in event.taskEvent) {
                  switch (event.taskEvent.statusChange.newStatus) {
                    case TaskStatus.RUNNING:
                      color = colors.magenta;
                      event.message = "Starting!";
                      break;
                    case TaskStatus.SUCCEEDED:
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
        taskUI = new LoggingTaskUI(winston.format.combine(...formats));
        break;
      }
      case "json":
      case "json-pretty":
        taskUI = new LoggingTaskUI(
          winston.format.combine(
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
        );
        break;
      default:
        throw Error("invalid output format");
    }

    const logger = winston.createLogger({
      transports: [taskUI.winstonTransport()],
      level: "task",
      levels: customLevels.levels
    });

    const runner = new TaskRunner(logger);

    try {
      await runner.run(taskUI, async t => {
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
      // XXX currently this error isn't displaying in ink mode --- probably should
      // add some sort of explicit failure handling on TaskUI and move this try/catch
      // into TaskRunner.run?
      console.log("yikes", e);
      logger.error(`Command failed: ${e.message}`, { error: e });
      this.exit(1);
    }
  }
}
