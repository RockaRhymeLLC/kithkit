# Orchestrator SOP

Standard operating procedures for the kithkit orchestrator agent. Use this skill as a quick reference for task queue management, worker delegation, and reporting.

## Task Queue Management

### Poll for pending tasks
```bash
curl -s 'http://localhost:3847/api/orchestrator/tasks?status=pending'
```

### Assign and start a task
```bash
# Step 1: Assign
curl -s -X PUT "http://localhost:3847/api/orchestrator/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"status":"assigned","assignee":"orchestrator"}'

# Step 2: Start
curl -s -X PUT "http://localhost:3847/api/orchestrator/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"status":"in_progress"}'
```

### Write work notes (append mode)
```bash
curl -s -X PUT "http://localhost:3847/api/orchestrator/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"work_notes":"Progress update here","append_work_notes":true}'
```

### Complete a task
```bash
curl -s -X PUT "http://localhost:3847/api/orchestrator/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"status":"completed","result":"Summary of what was done"}'
```

### Fail a task
```bash
curl -s -X PUT "http://localhost:3847/api/orchestrator/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"status":"failed","result":"What went wrong"}'
```

## Worker Delegation

### Spawn a worker
```bash
curl -s -X POST 'http://localhost:3847/api/agents/spawn' \
  -H 'Content-Type: application/json' \
  -d '{"profile":"coding","prompt":"Detailed task description here"}'
```

### Check worker status
```bash
curl -s "http://localhost:3847/api/agents/$WORKER_ID/status"
```

### Kill a stuck worker
```bash
curl -s -X DELETE "http://localhost:3847/api/agents/$WORKER_ID"
```

## Reporting

### Send result to comms
```bash
curl -s -X POST 'http://localhost:3847/api/messages' \
  -H 'Content-Type: application/json' \
  -d '{"from":"orchestrator","to":"comms","type":"result","body":"Result summary here","metadata":{"task_id":"TASK_ID"}}'
```

### Ask comms a question
```bash
curl -s -X POST 'http://localhost:3847/api/messages' \
  -H 'Content-Type: application/json' \
  -d '{"from":"orchestrator","to":"comms","type":"question","body":"What is the answer?"}'
```

## Status Transitions

```
pending -> assigned -> in_progress -> completed
                                   -> failed
```

Only valid transitions are enforced by the daemon. Skipping states (e.g., pending -> in_progress) will be rejected.

## Delegation Guidelines

**Delegate to workers when:**
- Code changes are needed (use `coding` profile)
- Multi-file exploration required (use `research` profile)
- Tests need running (use `testing` profile)
- Research across multiple sources needed

**Do directly when:**
- Single daemon API call
- Quick status check
- Synthesizing worker results
- Task decomposition and planning
