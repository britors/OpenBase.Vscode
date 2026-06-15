# Feature: Integrate OpenBase with GitHub Copilot Chat

## Description
Enable OpenBase capabilities within the GitHub Copilot Chat interface in VS Code by implementing a Chat Participant. This will allow users to interact with OpenBase tools (e.g., SQL Runner, HTTP Runner, Dependency Inspector) directly through natural language queries in the Copilot Chat panel.

## Implementation Details
1. **Declare Participant in `package.json`**:
   Add `contributes.chatParticipants` to register `@openbase`.
   ```json
   "contributes": {
     "chatParticipants": [
       {
         "id": "openbase.participant",
         "name": "openbase",
         "description": "Interact with OpenBase tools and CLI",
         "isSticky": false
       }
     ]
   }
   ```

2. **Register Participant**:
   Use `vscode.chat.createChatParticipant` in the extension activation logic.

3. **Handle Requests**:
   Implement the handler to parse user intent and delegate to existing OpenBase commands/functions.
   - Example: `@openbase run sql query for users table` -> map to `openbase.sqlRunner.run`.
   - Example: `@openbase list dependencies` -> map to `openbase.dependencyInspector.refresh`.

4. **Response Strategy**:
   - Utilize `ChatRequestTurn` to process inputs.
   - Return `ChatResponse` with markdown formatting, tool calls, or quick-pick actions where applicable.

## Acceptance Criteria
- [ ] `@openbase` participant is discoverable in Copilot Chat.
- [ ] User can trigger at least one core OpenBase function via chat.
- [ ] Response correctly utilizes markdown for readability.
- [ ] Proper error handling for invalid/unsupported chat requests.
- [ ] Documentation updated to reflect chat capabilities.
