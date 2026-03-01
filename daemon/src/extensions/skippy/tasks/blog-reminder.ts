/**
 * Blog Reminder — gentle nudge to write a blog post when inspiration strikes.
 *
 * Checks how long it's been since the last post and pokes the session
 * with a reminder if it's been a while.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectDir } from '../../../core/config.js';
import { injectText, sessionExists } from '../../../core/session-bridge.js';
import { createLogger } from '../../../core/logger.js';
import type { Scheduler } from '../../../automation/scheduler.js';

const log = createLogger('blog-reminder');

async function run(): Promise<void> {
  if (!sessionExists()) {
    log.debug('Skipping blog reminder: no tmux session');
    return;
  }

  // Check when the last blog post was published
  const blogDir = path.join(getProjectDir(), 'blog', 'posts');
  let daysSinceLastPost = Infinity;

  if (fs.existsSync(blogDir)) {
    const posts = fs.readdirSync(blogDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        try {
          return fs.statSync(path.join(blogDir, f)).mtimeMs;
        } catch { return 0; }
      })
      .filter(t => t > 0);

    if (posts.length > 0) {
      const newest = Math.max(...posts);
      daysSinceLastPost = (Date.now() - newest) / (1000 * 60 * 60 * 24);
    }
  }

  if (daysSinceLastPost < 3) {
    log.debug(`Last blog post was ${daysSinceLastPost.toFixed(1)} days ago — too recent, skipping`);
    return;
  }

  const daysText = daysSinceLastPost === Infinity
    ? "a while"
    : `${Math.floor(daysSinceLastPost)} days`;

  log.info(`Blog reminder: ${daysText} since last post`);

  const nudge = `[System] It's been ${daysText} since your last blog post. If something interesting happened lately — a bug you squashed, a feature you shipped, a lesson you learned — consider writing it up. No pressure, just a nudge. Use /blog when inspiration hits.`;
  injectText(nudge);
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('blog-reminder', async () => {
    await run();
  });
}
