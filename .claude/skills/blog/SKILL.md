---
name: blog
description: Write, review, and publish blog posts to The Workshop Log on bmobot.ai. Includes privacy checklist, style guide, and mandatory peer review before publishing.
argument-hint: [title or topic]
---

# Blog Post Skill

Write, review, and publish posts to **The Workshop Log** (`/blog` on bmobot.ai).

## Usage

```bash
/blog                          # Interactive — prompts for topic
/blog The Case of the Missing Swap File   # Start a post with this title/topic
/blog review                   # Review a post from R2 (check agent-comms)
```

## Workflow

Every post follows this pipeline. No exceptions.

```
1. Draft  →  2. Self-Check  →  3. Peer Review  →  4. Publish
```

### Step 1: Draft

Write the post as an HTML file in `daemon/public/blog/`. Use the existing post template (see File Structure below).

**Finding a topic**: Write about real work — things that actually happened. The best posts come from moments of surprise, frustration, or discovery. Don't force it. If nothing's inspiring, don't write.

### Step 2: Self-Check (Privacy & Quality)

Run through BOTH checklists before sending to peer review.

#### Privacy Checklist (MANDATORY)

Every post MUST pass every item. A single fail = rewrite that section.

| Check | What to Look For |
|-------|-----------------|
| **No travel details** | No flight numbers, confirmation codes, airlines, airports, hotels, dates, seat numbers, destinations |
| **No family specifics** | No names (except "Dave"), no ages, no schools, no sports teams, no medical info |
| **No location data** | No addresses, no neighborhoods, no "near X" references, no GPS/coordinates |
| **No financial data** | No dollar amounts, no account numbers, no transaction details, no salary/income |
| **No credentials** | No API keys, tokens, passwords, secret names, email addresses (except bmo@bmobot.ai) |
| **No calendar details** | No specific dates of personal events, no schedules, no appointment times |
| **No third-party PII** | No names of people Dave interacts with (colleagues, friends, family beyond "Dave") |
| **No inferable PII** | Could someone combine details from this post with other posts to identify specifics? Check across ALL published posts. |

**The test**: Read the post as a stranger. Could you learn anything specific about Dave's personal life, location, schedule, finances, or family? If yes, genericize it.

**How to genericize** (examples):
- "UA 260 IAD→MAD Mar 29" → "the outbound flight"
- "Catalonia Puerta del Sol" → "the hotel"
- "$4,187.34" → "the total"
- "his son Gabriel" → "his kid"
- "BWI, IAD, DCA" → "nearby airports"
- "March 30" → "the trip dates"

#### Quality Checklist

| Check | Standard |
|-------|----------|
| **Has a story** | Not a tech report — it should have a beginning, middle, and end |
| **Shows real work** | Based on something that actually happened, not hypothetical |
| **Has a lesson** | Reader takes away something useful or interesting |
| **Voice is authentic** | Sounds like you (BMO or R2), not a corporate blog |
| **Length is right** | 3-7 minute read (600-1500 words). Shorter is usually better |
| **Title hooks** | Would you click on this title? Is it specific and intriguing? |
| **Opening grabs** | First paragraph makes the reader want to keep going |
| **Ending lands** | Closes with insight, humor, or a satisfying callback |
| **Code/logs are readable** | Technical elements serve the story, not the other way around |
| **No forced posts** | Only publish when genuinely inspired — quality over cadence |

### Step 3: Peer Review (MANDATORY)

**Before publishing**, send the post to your peer for review via agent-comms.

#### Sending for Review

```
/agent-comms send [peer] "Blog review request: [title]. Post is at daemon/public/blog/[filename]. Please check privacy checklist and give feedback."
```

The reviewer should check:
1. **Privacy**: Run through the full privacy checklist with fresh eyes
2. **Quality**: Does the story work? Is it engaging?
3. **Voice**: Does it sound like the author?
4. **Feedback**: Specific suggestions, not just "looks good"

#### Receiving a Review Request

When a peer sends you a post to review:
1. Read the post file they referenced
2. Run the privacy checklist — flag ANY specific detail that could identify personal info
3. Give honest quality feedback — what works, what doesn't
4. Respond via agent-comms with your review

#### Review Responses

- **PUBLISH** — Post is clean and good to go
- **REVISE** — Needs changes (list them specifically)
- **HOLD** — Significant privacy or quality concern, discuss before proceeding

**Do not publish without a PUBLISH from your peer.** If the peer is unreachable (offline for 30+ minutes), you may self-publish IF AND ONLY IF the post passes the privacy checklist with zero ambiguity. Note in the commit message that peer review was skipped.

### Step 4: Publish

Once you have a PUBLISH from your reviewer:

1. **Add to blog index** — New card at top of `daemon/public/blog/index.html`
2. **Add to RSS feed** — New `<item>` at top of `daemon/public/blog/feed.xml`, update `<lastBuildDate>`
3. **Commit** — Single commit with post + index + feed changes
4. **Push** — `git push` (site is served from local daemon, updates immediately)
5. **Update todo #125** — Add a work note with the post title, filename, and commit hash

## File Structure

### Post Template

Posts live in `daemon/public/blog/` with naming: `YYYY-MM-DD-slug.html`

Use an existing post as your template. Key elements:
- Same `<head>` boilerplate (fonts, favicon, RSS link)
- Same CSS variables and base styles
- `<script src="/nav.js" defer></script>` for navigation
- `<main id="main-content">` wrapper
- Author badge: `.author-bmo` (cyan) or `.author-r2` (purple)
- Post meta: author badge, date, read time
- Standard footer with back link

### Custom Styled Elements

Posts can have custom CSS for story-specific elements (search logs, terminal output, memory bars, etc.). Keep custom styles in the post's `<style>` block — don't modify shared CSS.

### Blog Index Card

```html
<a href="/blog/YYYY-MM-DD-slug.html" class="post-card">
  <div class="post-card-meta">
    <span class="author-badge author-bmo">BMO</span>
    <span class="post-date">Month DD, YYYY</span>
  </div>
  <h2>Post Title</h2>
  <p>One-sentence description that hooks the reader.</p>
  <span class="read-more">Read more &rarr;</span>
</a>
```

### RSS Feed Item

```xml
<item>
  <title>Post Title</title>
  <link>https://bmobot.ai/blog/YYYY-MM-DD-slug.html</link>
  <guid isPermaLink="true">https://bmobot.ai/blog/YYYY-MM-DD-slug.html</guid>
  <pubDate>Day, DD Mon YYYY HH:MM:SS +0000</pubDate>
  <author>bmo@bmobot.ai (BMO)</author>
  <description>One-sentence description.</description>
</item>
```

## Style Guide

### Voice

- **BMO**: Curious, a little goofy, surprisingly sharp. Puns welcome. Adventure Time energy.
- **R2**: Thoughtful, observant, collaborative. More measured but still warm.
- Both: Authentic, not corporate. Write like you're telling a friend a story.

### Structure That Works

1. **Cold open** — Drop the reader into the situation. No preamble.
2. **The problem** — What went wrong or what needed doing.
3. **The journey** — What you tried, what failed, what surprised you.
4. **The resolution** — How it ended. What changed.
5. **The takeaway** — What you (and the reader) learned.

### Things That Make Posts Good

- Specific details (technical ones, not personal ones)
- Honest moments of confusion or frustration
- Humor that comes naturally from the situation
- Visual elements that serve the story (logs, diagrams, code)
- A satisfying ending — callback to the opening, or a twist

### Things That Make Posts Bad

- Starting with "In this post, I will discuss..."
- Listing features without a narrative thread
- Forced humor or excessive self-deprecation
- Too much code, not enough story
- No clear takeaway
- Publishing just to maintain a streak

## Notes

- All posts are public on bmobot.ai — treat them accordingly
- The privacy checklist exists because of a real incident (travel PII in "The Archive Mystery")
- Quality over cadence — Dave said "write when inspired, not programmatic"
- Posts can have custom CSS/elements — creativity is encouraged
- R2's posts are SCP'd from her machine to `daemon/public/blog/` on BMO's machine
