# OpenBase - Ferramentas de Produtividade

![OpenBase for VS Code](https://raw.githubusercontent.com/britors/OpenBase.Vscode/main/banner.png)


VS Code extension that exposes [OpenBase CLI](https://github.com/britors/OpenBase.CLI) commands directly from the editor.

## Funcionalidades Principais

*   **Copilot Chat Integration**: Interaja com o OpenBase via `@openbase` no chat (ex: `@openbase implemente a issue #feature/123`).
*   **Quick Access**: Acesso rápido a todos os comandos via `OpenBase: Quick Access` na Paleta de Comandos.
*   **Status Bar**: Indicador de atividade na barra de status inferior.
*   **Walkthrough**: Tutorial interativo para novos usuários ("Começando com OpenBase").
*   **Runners Integrados**: SQL Runner (com ER Diagram), HTTP Runner (com suporte a env vars), Migration Runner.
*   **Exploradores**: Solution Explorer e Dependency Inspector (com atualização automática).

## Prerequisites

The OpenBase CLI must be installed globally:

```bash
dotnet tool install -g w3ti.OpenBase.CLI
openbase install
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
| Quick Access | Open access to all primary OpenBase commands |
| New Project † | Create a new OpenBase project |
| Scaffold † | Generate full CRUD for an entity |
| Scaffold Update † | Update scaffold files from current DB schema |
| Specialist † | Generate specialist methods for an entity |
| Procedure † | Generate a stored procedure wrapper |
| Add Extension † | Add an extension (JWT, Cache, Health Checks) |
| List Extensions | List available extensions |
| Build | Build the project (Debug or Release) |
| Debug | Build (Debug) and launch the VS Code debugger |
| Run | Run the project |
| Update CLI | Update OpenBase CLI to the latest version |
| History | Show command history |
| Version | Show installed CLI version |
| SQL Runner | Open SQL Runner |
| HTTP Runner | Open HTTP Runner |
| Monitor | Open Monitor |

## Usage

### Copilot Chat
Use `@openbase` no painel do GitHub Copilot Chat para interagir.
Comandos suportados incluem:
- `migrate`: Executa migrações pendentes.
- `build` / `run`: Compila ou executa a solução.
- `test`: Executa os testes do projeto.
- `sql` / `http` / `log` / `monitor`: Abre as ferramentas integradas.
- `scaffold` / `new project`: Inicia assistentes de geração de código.
- `context`: Mostra o contexto do arquivo atual.
- `implemente a issue #tipo/id`: Fluxo automatizado para resolução de issues.

Exemplo: `@openbase implemente a issue #feature/101`

### New Project
1. Open the Command Palette (`Ctrl+Shift+P`) → **New Project**
2. Fill in the details and follow the instructions in the output panel.

### Debug
1. Open the Command Palette → **Debug** (or use the **Solution Explorer** sidebar).
2. Requires **C# Dev Kit** or **C# (OmniSharp)**.

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
