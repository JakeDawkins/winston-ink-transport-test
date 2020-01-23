import { Command, flags } from "@oclif/command";
import winston from "winston";
import Transport from "winston-transport";
import React from "react";
import { render, Color } from "ink";

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
    waitUntilExit().then(cb);
  }
}

const logger = winston.createLogger({
  transports: [
    // new winston.transports.Console({
    //   format: winston.format.json()
    // }),
    new WinstonInkTransport({})
  ],
  exitOnError: false
});

export default class Hello extends Command {
  static flags = {
    name: flags.string({ char: "n", description: "name to print" }),
    force: flags.boolean({ char: "f" })
  };

  async run() {
    const { flags } = this.parse(Hello);
    const name = flags.name || "world";

    logger.info(`hello ${name} from ./src/commands/hello.ts`);

    if (flags.force) logger.warn(`The --force is with you, ${name}.`);
  }
}
