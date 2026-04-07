// Códigos de cor ANSI
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const COLORS = {
  info: "\x1b[36m", // Ciano
  success: "\x1b[32m", // Verde
  warn: "\x1b[33m", // Amarelo
  error: "\x1b[31m", // Vermelho
  debug: "\x1b[90m", // Cinza
};

type LogLevel = "info" | "warn" | "error" | "debug" | "success";

class Logger {
  private getTimestamp(): string {
    const now = new Date();
    return now.toLocaleTimeString("pt-BR", { hour12: false });
  }

  private formatMessage(level: LogLevel, context: string, message: string): string {
    const timestamp = `${DIM}[${this.getTimestamp()}]${RESET}`;
    const levelColor = COLORS[level];
    const contextTag = `${BOLD}[${context}]${RESET}`;
    
    // Mantém o alinhamento visual básico do log
    return `${timestamp} ${levelColor}${level.toUpperCase().padEnd(5)}${RESET} ${contextTag} ${message}`;
  }

  info(context: string, message: string, ...args: any[]) {
    console.log(this.formatMessage("info", context, message), ...args);
  }

  success(context: string, message: string, ...args: any[]) {
    console.log(this.formatMessage("success", context, message), ...args);
  }

  warn(context: string, message: string, ...args: any[]) {
    console.warn(this.formatMessage("warn", context, message), ...args);
  }

  error(context: string, message: string, error?: any) {
    console.error(this.formatMessage("error", context, message));
    if (error) {
      if (error instanceof Error) {
        console.error(`${COLORS.error}${error.stack || error.message}${RESET}`);
      } else {
        console.error(error);
      }
    }
  }

  debug(context: string, message: string, ...args: any[]) {
    if (process.env.DEBUG === "true") {
      console.log(this.formatMessage("debug", context, message), ...args);
    }
  }
}

export const logger = new Logger();
