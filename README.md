# OpenBase CLI — VS Code Extension

![Publish](https://github.com/britors/OpenBase.Vscode/actions/workflows/publish.yml/badge.svg)

VS Code extension that exposes [OpenBase CLI](https://github.com/britors/OpenBase.CLI) commands directly from the editor.

## Prerequisites

The OpenBase CLI must be installed globally:

```bash
dotnet tool install -g w3ti.OpenBase.CLI
```

> Requires .NET SDK 10 or later.

## Installation

### From the Marketplace

Search for **OpenBase CLI** in the VS Code Extensions panel (`Ctrl+Shift+X`) and click **Install**.

### Manual install (.vsix)

1. Download the latest `.vsix` file from the [Releases](https://github.com/britors/OpenBase.Vscode/releases) page.
2. Open the Extensions panel (`Ctrl+Shift+X`).
3. Click the `...` menu (top-right) → **Install from VSIX...**.
4. Select the downloaded file.

## Commands

All commands are available via the **Command Palette** (`Ctrl+Shift+P`). Commands marked with † also appear in the **Explorer context menu** when right-clicking a folder.

| Command | Description |
|---|---|
| `OpenBase: New Project` † | Create a new OpenBase project |
| `OpenBase: Scaffold` † | Generate full CRUD for an entity |
| `OpenBase: Scaffold Update` † | Update scaffold files from current DB schema |
| `OpenBase: Specialist` † | Generate specialist methods for an entity |
| `OpenBase: Procedure` † | Generate a stored procedure wrapper |
| `OpenBase: Add Extension` † | Add an extension (JWT, Cache, Health Checks) |
| `OpenBase: List Extensions` | List available extensions |
| `OpenBase: Build` | Build the project (Debug or Release) |
| `OpenBase: Debug` | Build (Debug) and launch the VS Code debugger |
| `OpenBase: Run` | Run the project |
| `OpenBase: Update CLI` | Update OpenBase CLI to the latest version |
| `OpenBase: History` | Show command history |
| `OpenBase: Version` | Show installed CLI version |

## Usage

### New Project

1. Open the Command Palette (`Ctrl+Shift+P`) → **OpenBase: New Project**
2. Fill in the project name, database template, server, credentials and optional license keys
3. Select the destination folder (skipped if a single workspace is open)
4. The output panel opens and shows the progress of `openbase new`
5. When done, choose to open the created folder in the current window or a new one

### Scaffold

1. Open the Command Palette → **OpenBase: Scaffold**
2. Enter the entity name in PascalCase (e.g. `Product`)
3. The CLI runs interactively in the terminal (code-first or model-first)

### Debug

1. Open the Command Palette → **OpenBase: Debug** (or use the **Debug** tab in the sidebar panel)
2. Select the configuration (`Debug` or `Release`) and optionally skip the build step
3. The extension builds the project with `openbase build`, locates the API `.csproj` to resolve the output DLL, then starts the VS Code debugger (`coreclr`)
4. Breakpoints in the API project are hit normally; the browser opens automatically when the app is ready

> Requires the **C# Dev Kit** or **C# (OmniSharp)** extension installed in VS Code.

### Add Extension

1. Open the Command Palette → **OpenBase: Add Extension**
2. Select the extension type (`jwt`, `cache`, `healthchecks`)
3. If applicable, select the provider (e.g. `redis` for cache)

## Development

```bash
# Clone the repository
git clone https://github.com/britors/OpenBase.Vscode.git
cd OpenBase.Vscode

# Install dependencies
npm install

# Compile
npm run compile

# Press F5 in VS Code to launch the Extension Development Host
```

## CI/CD

Every push to `main` automatically publishes a new version to the VS Code Marketplace via GitHub Actions.

## Related

- [OpenBase CLI](https://github.com/britors/OpenBase.CLI) — the underlying CLI tool
- [OpenBase VS extension](https://github.com/britors/OpenBase.CLI/issues/110) — Visual Studio 2025 extension (planned)
