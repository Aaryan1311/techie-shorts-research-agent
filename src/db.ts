import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  log: ["warn", "error"],
});

let keepAliveInterval: NodeJS.Timeout | null = null;

export function startKeepAlive(): void {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      // Connection lost, Prisma will auto-reconnect on next query
    }
  }, 60_000); // ping every 60 seconds
}

export function stopKeepAlive(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

export default prisma;
