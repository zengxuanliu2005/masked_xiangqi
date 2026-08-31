export interface AgentReporter {
  line(message?: string): void;
  raw(message: string): void;
}

export class ConsoleAgentReporter implements AgentReporter {
  line(message = ""): void {
    process.stdout.write(`${message}\n`);
  }

  raw(message: string): void {
    process.stdout.write(message);
  }
}

export class MemoryAgentReporter implements AgentReporter {
  output = "";

  line(message = ""): void {
    this.output += `${message}\n`;
  }

  raw(message: string): void {
    this.output += message;
  }
}
