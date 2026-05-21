# OpenBase CLI — VS Code Extension

VS Code extension that exposes [OpenBase CLI](https://github.com/britors/OpenBase.CLI) commands directly from the editor.

## Prerequisites

The OpenBase CLI must be installed globally:

```bash
dotnet tool install -g w3ti.OpenBase.CLI
```

> Requires .NET SDK 10 or later.

## Installation

### From the Marketplace _(coming soon)_

Search for **OpenBase CLI** in the VS Code Extensions panel (`Ctrl+Shift+X`) and click **Install**.

### Manual install (.vsix)

1. Download the latest `.vsix` file from the [Releases](https://github.com/britors/OpenBase.VsCode/releases) page.
2. Open the Extensions panel (`Ctrl+Shift+X`).
3. Click the `...` menu (top-right) → **Install from VSIX...**.
4. Select the downloaded file.

## Usage

### New Project

Creates a new OpenBase project with the configured database template.

**Via Command Palette:**

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **OpenBase: New Project**.

**Via Explorer context menu:**

Right-click any folder in the Explorer panel → **OpenBase: New Project**.

**Steps:**

| Step | Description |
|------|-------------|
| 1 | Enter the project name |
| 2 | Select the database template (`sqlserver`, `pgsql` or `oracle`) |
| 3 | Select the destination folder (skipped if a single workspace is open) |
| 4 | An integrated terminal opens and runs `openbase new` — follow the prompts to complete configuration |

## Development

```bash
# Clone the repository
git clone https://github.com/britors/OpenBase.VsCode.git
cd OpenBase.VsCode

# Install dependencies
npm install

# Compile
npm run compile

# Press F5 in VS Code to launch the Extension Development Host
```

## Related

- [OpenBase CLI](https://github.com/britors/OpenBase.CLI) — the underlying CLI tool
- [OpenBase VS extension](https://github.com/britors/OpenBase.CLI/issues/110) — Visual Studio 2025 extension (planned)
