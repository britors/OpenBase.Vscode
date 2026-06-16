# OpenBase Copilot Chat Integration Guide

Integrate OpenBase capabilities directly into GitHub Copilot Chat within VS Code.

## Getting Started
Invoke the assistant by typing `@openbase` in your Copilot Chat window.

## Supported Commands
The assistant understands natural language commands mapped to OpenBase CLI functions:

### Solution & Build
- `migrate` / `run migrations` -> Run database migrations.
- `build` / `build solution` -> Build the entire solution.
- `run` / `run solution` -> Run the solution.
- `test` -> Execute tests.

### Tools & Panels
- `sql` / `database` -> Open SQL Runner.
- `http` / `api` -> Open HTTP Runner.
- `log` -> Open Log Viewer.
- `monitor` -> Open System Monitor.

### CLI Actions
- `new project` -> Start new project wizard.
- `scaffold` -> Start scaffold wizard.
- `history` -> View project history.
- `version` -> Check current CLI version.
- `add extension` -> Add new extension.

## Context Awareness
The assistant can access information about your active editor.
- Use the keyword `context` (e.g., "@openbase what is my context?") to see information about the file you are currently editing.

## Example Prompts

Here are various ways to interact with the assistant, categorized by workflow type:

### Basic Commands
- **Migrations:** `"@openbase migrate"` or `"@openbase run migrations"`
- **Build/Run:** `"@openbase build"` or `"@openbase run solution"`
- **Tests:** `"@openbase run tests"`

### Tool Access
- **SQL:** `"@openbase open sql runner"`
- **HTTP/API:** `"@openbase open http runner"`
- **Monitoring:** `"@openbase show monitor"`
- **Logs:** `"@openbase check logs"`

### Project Management & Scaffolding
- **Create Project:** `"@openbase create new project"`
- **Scaffold Feature:** `"@openbase scaffold user-management feature"`
- **Implement Issue:** `"@openbase implemente a issue #feature/123"` (Triggers automated workflow based on type)
- **Extensions:** `"@openbase add extension auth"`

### Context-Aware & Agentic Workflows
- **Context Inquiry:** `"@openbase what is my current file context?"`
- **Migration based on context:** `"@openbase scaffold migration for this entity"`
- **Project Info:** `"@openbase check version"` or `"@openbase show history"`

---
*Tip: You can combine intent with context. For example, if you have a database entity file open, try: "@openbase scaffold a controller for this entity".*

## Agentic Workflow
The integration is designed to act as an agentic workflow orchestrator. By leveraging Copilot's reasoning capabilities combined with OpenBase's CLI execution, you can perform complex tasks:
1. Provide a prompt (e.g., "Scaffold a new feature based on this entity").
2. The assistant utilizes context to determine the necessary command.
3. OpenBase CLI executes the command, ensuring structural consistency with project standards.
