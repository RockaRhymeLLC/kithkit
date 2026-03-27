# Spec Workflow Reference

Detailed step-by-step instructions for creating and updating specifications.

## Creation Workflow

### Step 1: Parse the Feature Name
- Extract the feature name from arguments
- Normalize to slug format: `telegram-integration`, `state-manager`
- Generate filename: `specs/YYYYMMDD-[feature-name].spec.md`
- Example: `/spec telegram-bot` → `specs/20260127-telegram-bot.spec.md`

### Step 2: Read the Template
```typescript
const templatePath = 'templates/spec.template.md';
const template = await readFile(templatePath);
```

### Step 3: Interview the User

Use AskUserQuestion to gather information for each section:

#### Goal Section
**Ask**: "In one sentence, what problem does this feature solve?"
- Capture one clear sentence
- Focus on the problem, not the solution

#### Requirements

**Must Have**:
**Ask**: "What are the must-have requirements? (List them one by one, or type 'done' when finished)"
- Repeat until user says "done"
- Each requirement becomes a checkbox: `- [ ] Requirement text`

**Should Have**:
**Ask**: "Any should-have requirements? (nice to have but not critical)"
- Optional enhancements
- Lower priority than must-haves

**Won't Have**:
**Ask**: "Anything that's explicitly out of scope for now?"
- Clarify what we're NOT building
- Prevents scope creep

#### Constraints

**Security**:
**Ask**: "Are there any specific security constraints or requirements?"
- Authentication, authorization, encryption, etc.
- If none: document as "None specified"

**Performance**:
**Ask**: "Are there any performance requirements?"
- Response times, throughput, resource limits
- If none: document as "None specified"

**Compatibility**:
**Ask**: "Are there any compatibility requirements? (platforms, dependencies, etc.)"
- OS, runtime versions, dependencies
- Example: "Node.js 18+", "macOS only"

#### Success Criteria

**Ask**: "How will we know this feature is complete and working? What observable behaviors should we see?"
- Gather 2-5 specific, measurable criteria
- Format as numbered list
- Examples:
  1. User can send message via Telegram and receive response
  2. Assistant saves state before context clear
  3. Credentials are encrypted at rest

#### User Stories

**Ask**: "Can you describe 1-2 scenarios where this feature would be used?"

For each scenario:
- **Ask**: "What's the context? (Given...)"
- **Ask**: "What action happens? (When...)"
- **Ask**: "What's the expected outcome? (Then...)"

Format as:
```markdown
### Scenario 1: [Title]
- **Given**: [context]
- **When**: [action]
- **Then**: [expected outcome]
```

#### Technical Considerations

**Ask**: "Any technical notes, dependencies, or architectural considerations we should be aware of?"
- Libraries to use
- Integration points
- Architecture decisions
- Technical constraints

#### Documentation Impact

**Ask**: "Will this feature require updates to any docs?"
- Check if it adds new skills, config options, behaviors, or integrations
- Identify which docs will need updating: `CLAUDE.md`, specific `SKILL.md` files, `README.md`, `cc4me.config.yaml`
- Format as checklist: `- [ ] CLAUDE.md — [reason]`
- If none expected, document as "None expected"
- This list feeds into `/validate` post-build to verify docs were actually updated

#### Open Questions

**Ask**: "Are there any open questions or uncertainties we need to resolve before planning?"
- Unresolved decisions
- Areas needing research
- Questions for stakeholders
- Format as checklist: `- [ ] Question?`

### Step 4: Create the Specification File

- Use template structure
- Fill in all sections with gathered information
- Replace placeholders:
  - `[YYYY-MM-DD]` → today's date (2026-01-27)
  - `[Feature Name]` → formatted feature name
- Convert user responses to well-formatted markdown
- Maintain consistent formatting (checkboxes, numbered lists, headers)

### Step 5: Save and Confirm

```typescript
import { ContextTracker } from '../../src/context/tracker';
import { HistoryLogger } from '../../src/history/logger';

// Save file
const specPath = `specs/${date}-${featureName}.spec.md`;
await writeFile(specPath, content);

// Update context
const tracker = new ContextTracker('.claude/state/context.json');
tracker.setActiveSpec(specPath);

// Log creation
const logger = new HistoryLogger('.claude/history/commands.log');
logger.log('/spec', specPath, `Created spec for ${featureName}`);

// Confirm to user
console.log(`✓ Created: ${specPath}`);
console.log(`Next steps:
  1. Review and refine the spec if needed
  2. Resolve any open questions
  3. Run \`/plan ${specPath}\` to create implementation plan`);
```

## Update Workflow

### Step 1: Parse the Command

Extract description from arguments:
- `/spec add breakfast feature` → description = "add breakfast feature"
- `/spec security: must encrypt` → description = "security: must encrypt"

### Step 2: Determine Target Spec File

#### Check Context First
```typescript
const tracker = new ContextTracker('.claude/state/context.json');
const activeSpec = tracker.getActiveSpec();
```

If `activeSpec` is set → use that file

#### Infer from Conversation
If no activeSpec:
1. Review recent conversation for spec file references
2. List files in `specs/` directory
3. Match description semantically to spec titles
   - "breakfast" might match "agent-assistant-harness" if that spec mentions breakfast
   - "telegram" matches "telegram-integration"

#### Ask User if Ambiguous
If multiple matches or no clear match:
```typescript
const specs = listSpecFiles('specs/');
// Use AskUserQuestion to present options
```

### Step 3: Categorize the Description

Use natural language understanding to determine the section:

| Keywords | Category | Target Section |
|----------|----------|----------------|
| "add", "must", "require", "need", "critical" | Must Have Requirement | `### Must Have` |
| "nice to have", "should", "could", "optional" | Should Have Requirement | `### Should Have` |
| "won't have", "out of scope", "not now" | Won't Have | `### Won't Have (for now)` |
| "security", "auth", "encrypt", "secure", "protect" | Security Constraint | `### Security` |
| "performance", "fast", "speed", "latency", "response time" | Performance Constraint | `### Performance` |
| "compatibility", "platform", "environment", "requires", "depends on" | Compatibility Constraint | `### Compatibility` |
| "success criteria", "done when", "complete when", "working when" | Success Criteria | `## Success Criteria` |
| "user story", "given", "when", "then", "scenario" | User Story | `## User Stories / Scenarios` |

**Default**: If unclear, categorize as Must Have requirement

### Step 4: Update the Spec File

#### For Requirements
```markdown
### Must Have
- [ ] Existing requirement 1
- [ ] Breakfast feature  ← NEW
- [ ] Another existing requirement
```

**Steps**:
1. Read spec file
2. Find appropriate section (`### Must Have` or `### Should Have`)
3. Add new line: `- [ ] <description>`
4. Use Edit tool to preserve all existing content

#### For Constraints
```markdown
### Security
- Must encrypt all credentials
- Must authenticate Telegram users  ← NEW
```

**Steps**:
1. Read spec file
2. Find constraint section (`### Security`, `### Performance`, `### Compatibility`)
3. If section says "None specified" → replace with constraint
4. Otherwise → append to existing constraints
5. Use Edit tool

#### For Success Criteria
```markdown
## Success Criteria

1. User can send request via Telegram
2. Assistant responds within 5 seconds  ← NEW
3. State persists across restarts
```

**Steps**:
1. Read spec file
2. Find `## Success Criteria` section
3. Determine next number in sequence
4. Add numbered item
5. Use Edit tool

#### For User Stories
```markdown
### Scenario 3: Quick Lookup  ← NEW
- **Given**: User needs information quickly
- **When**: User asks "What's my wife's clothing size?"
- **Then**: Assistant retrieves from memory and responds instantly
```

**Steps**:
1. Read spec file
2. Find `## User Stories / Scenarios` section
3. Determine next scenario number
4. Parse Given/When/Then from description (or structure it appropriately)
5. Add new scenario
6. Use Edit tool

### Step 5: Update Context Tracker
```typescript
tracker.setActiveSpec(specPath);
```

### Step 6: Log to History
```typescript
const logger = new HistoryLogger('.claude/history/commands.log');
logger.log('/spec', path.basename(specPath), `Added requirement "${description}"`);
```

### Step 7: Confirm to User
```
✓ Added requirement "Breakfast feature" to Must Have section
  File: specs/20260127-agent-assistant-harness.spec.md
```

## Error Handling

### Creation Workflow Errors
- **Spec already exists**: Ask if should open for editing or choose different name
- **Template missing**: Report error, suggest creating template
- **User cancels interview**: Save partial spec as draft, mark status: "Incomplete"

### Update Workflow Errors
- **Target file doesn't exist**: Ask user to create spec first or select different file
- **Section missing**: Add the section if appropriate, or notify user of structure issue
- **Edit tool fails**: Report error clearly, suggest manual edit
- **ContextTracker fails**: Complete the update anyway, warn user about context not being saved
- **HistoryLogger fails**: Complete the update anyway, warn about missing audit log

## Best Practices

### For Creation
1. **Be thorough**: Don't skip sections, even if "None" - document that explicitly
2. **Clarify vague requirements**: Ask follow-up questions for clarity
3. **Keep user-focused**: Specs describe behavior and outcomes, not implementation
4. **Document uncertainties**: Capture open questions explicitly
5. **One feature per spec**: Keep specs focused and coherent

### For Updates
1. **Preserve existing content**: Never remove or modify existing items, only add
2. **Maintain formatting**: Keep markdown structure intact (checkboxes, lists, headers)
3. **Be smart about categorization**: Use context clues from the description
4. **Ask when unsure**: If can't confidently infer target file, ask the user
5. **Keep it fast**: This is a quick update tool for rapid iteration

## Integration Points

**Context Tracker** (`../../src/context/tracker.ts`):
- Stores activeSpec for quick reference
- Persists across conversation turns
- Enables smart inference

**History Logger** (`../../src/history/logger.ts`):
- Logs all spec changes
- Audit trail for compliance
- Helps track evolution of requirements

**Validation** (`.claude/skills/validate/`):
- Specs are validated before moving to plan phase
- Ensures completeness and consistency
- Catches missing requirements

**Templates** (`templates/spec.template.md`):
- Provides structure for new specs
- Ensures consistency across features
- Can be customized for project needs
