import { Command, flags } from "@oclif/command";
import winston from "winston";
import Transport from "winston-transport";
import React, { Component } from "react";
import { render, Color } from "ink";

class WinstonInkTransport extends Transport {
  constructor(opts: any) {
    super(opts);
  }

  log({ level, message }: any) {
    render(
      <Color
        red={level === "error"}
        yellow={level === "warn"}
        cyan={level === "info"}
      >
        {level}: {message}
      </Color>
    );
  }
}

const logger = winston.createLogger({
  transports: [
    // new winston.transports.Console({
    //   format: winston.format.json()
    // }),
    new WinstonInkTransport({ level: "info" }),
    new WinstonInkTransport({ level: "warn" })
  ]
});

export default class Hello extends Command {
  static description = "describe the command here";

  static flags = {
    help: flags.help({ char: "h" }),
    // flag with a value (-n, --name=VALUE)
    name: flags.string({ char: "n", description: "name to print" }),
    // flag with no value (-f, --force)
    force: flags.boolean({ char: "f" })
  };

  async run() {
    const { args, flags } = this.parse(Hello);

    const name = flags.name || "world";
    logger.info(`hello ${name} from ./src/commands/hello.ts`);

    if (flags.force) {
      logger.warn(`you input --force`);
    }
  }
}
