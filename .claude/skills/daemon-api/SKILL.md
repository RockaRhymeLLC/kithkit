---
name: daemon-api
description: Quick reference for all daemon HTTP API endpoints. Parses intent and loads the right domain reference.
argument-hint: [agents | todos | calendar | memory | messages | channels | orchestrator | tasks | config | usage | health]
---

# Daemon API Quick Reference

Fast lookup for daemon HTTP API endpoints, parameters, and examples.

## How This Skill Works

This skill is a **dispatcher**. It parses the user's intent from $ARGUMENTS, loads the matching reference file, and uses it to answer the question or construct the right curl command.

## Routing

Parse $ARGUMENTS and load the corresponding reference file:

| Keywords | Reference File | Domain |
|----------|---------------|--------|
| `agent`, `spawn`, `worker`, `kill`, `activity` | [agents.md](agents.md) | Agent lifecycle, spawn, status, activity logging |
| `todo`, `todos`, `task list`, `action`, `audit` | [todos-calendar.md](todos-calendar.md) | Todos CRUD, calendar events, audit trail |
| `calendar`, `event`, `schedule` | [todos-calendar.md](todos-calendar.md) | Calendar events (same file as todos) |
| `message`, `messages`, `send to agent`, `inter-agent` | [messages.md](messages.md) | Inter-agent messaging |
| `channel`, `deliver`, `telegram`, `notify`, `send` | [channels.md](channels.md) | Channel delivery (Telegram, email, etc.) |
| `memory`, `memories`, `remember`, `search memory`, `store`, `embed` | [memory.md](memory.md) | Memory store, search (keyword/vector/hybrid) |
| `orchestrator`, `escalate`, `shutdown` | [orchestrator.md](orchestrator.md) | Orchestrator escalate, status, shutdown |
| `task`, `tasks`, `scheduler`, `cron`, `trigger`, `history` | [tasks.md](tasks.md) | Scheduler tasks, manual trigger, history |
| `config`, `reload`, `feature`, `feature-state`, `context`, `usage` | [config.md](config.md) | Config CRUD, feature state, context loader, usage stats |
| `health`, `status`, `uptime` | [config.md](config.md) | Health checks, status endpoints |

If no arguments or ambiguous, show a summary of all domains with one-liner descriptions and ask the user to pick.

## Workflow

1. Parse $ARGUMENTS for keywords
2. Load the matching reference file (read it with the Read tool)
3. Use the reference to answer the question, construct a curl command, or explain the endpoint
4. If the user asks to actually call the endpoint, construct and run the curl command

## Base URL

All endpoints use `http://localhost:3847`. The daemon binds to localhost only.

## Quick Endpoint Index

| Endpoint | Method | Domain |
|----------|--------|--------|
| `/health` | GET | Health check |
| `/health/extended` | GET | Extended health with checks |
| `/status` | GET | Quick status |
| `/status/extended` | GET | Full operational status |
| `/api/agents/spawn` | POST | Spawn worker |
| `/api/agents` | GET | List agents |
| `/api/agents/:id` | GET | Get agent |
| `/api/agents/:id/status` | GET | Agent/job status |
| `/api/agents/:id/activity` | GET/POST | Activity log |
| `/api/agents/:id` | DELETE | Kill worker |
| `/api/todos` | GET/POST | List/create todos |
| `/api/todos/:id` | GET/PUT/DELETE | Todo CRUD |
| `/api/todos/:id/actions` | GET | Todo audit trail |
| `/api/calendar` | GET/POST | List/create events |
| `/api/calendar/:id` | GET/PUT/DELETE | Event CRUD |
| `/api/messages` | GET/POST | Messages list/send |
| `/api/send` | POST | Channel delivery |
| `/api/memory/store` | POST | Store memory |
| `/api/memory/search` | POST | Search memories |
| `/api/memory/:id` | GET/DELETE | Memory get/delete |
| `/api/orchestrator/escalate` | POST | Escalate task |
| `/api/orchestrator/status` | GET | Orchestrator status |
| `/api/orchestrator/shutdown` | POST | Shutdown orchestrator |
| `/api/tasks` | GET | List scheduler tasks |
| `/api/tasks/:name/run` | POST | Trigger task |
| `/api/tasks/:name/history` | GET | Task history |
| `/api/config/:key` | GET/PUT | Config CRUD |
| `/api/config/reload` | POST | Hot-reload config |
| `/api/feature-state/:feature` | GET/PUT | Feature state CRUD |
| `/api/context` | GET | Context summary |
| `/api/usage` | GET | Usage/cost stats |
