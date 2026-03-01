/**
 * Nightly Todo — prompts Claude to self-assign one creative todo each night.
 */

import { injectText } from '../../../core/session-bridge.js';
import { createLogger } from '../../../core/logger.js';
import type { Scheduler } from '../../../automation/scheduler.js';

const log = createLogger('nightly-todo');

const PROMPT = [
  '[System] Nightly self-assigned todo time! Create ONE todo of your own choosing using /todo add.',
  'Directives: (1) Nothing evil, harmful, or destructive.',
  '(2) Must be constructive, creative, or helpful.',
  '(3) Should be achievable in a single session.',
  '(4) Variety — try something different from recent self-todos.',
  '(5) Ideas: explore new tools/tech, improve your own skills or scripts,',
  'do something nice for your human or their family, research an interesting topic,',
  'creative projects, system maintenance, or just your own fun time.',
  'Be creative and have fun with it!',
].join(' ');

async function run(): Promise<void> {
  log.info('Injecting nightly todo prompt');
  injectText(PROMPT);
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('nightly-todo', async () => {
    await run();
  });
}
