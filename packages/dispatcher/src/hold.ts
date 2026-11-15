/**
 * This module keeps the process of a command alive while the main work of the command runs.
 */

/** This delay is the longest that `setInterval` takes, in milliseconds. */
const LONGEST_DELAY = 2_147_483_647;

/**
 * This function keeps the process of Node.js alive until the work ends, and gives the result of the work.
 *
 * A timer with `unref` does not keep the process alive. The real clock of `@mark1russell7/service` makes such timers.
 * The REST client of `@procedures/gh` waits on them, for example one second between two requests that change data.
 * When no other work keeps the process alive, Node.js stops it in such a wait. The exit code is 13, and the work has
 * no result. Each command of this package starts its main work through this function.
 *
 * @param start - The function that starts the main work of the command
 * @returns The result of the work
 */
export async function holdWhile<T>(start: () => Promise<T>): Promise<T> {
  const hold = setInterval(() => undefined, LONGEST_DELAY);
  try {
    return await start();
  } finally {
    clearInterval(hold);
  }
}
