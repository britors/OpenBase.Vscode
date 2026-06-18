# Contribuição

Obrigado por querer contribuir com o OpenBase VS Code Extension! Este guia descreve o fluxo básico para colaborar, configurar o ambiente e enviar alterações.

## Como contribuir

1. Abra uma issue descrevendo o bug, sugestão ou melhoria.
2. Crie um branch a partir de `main` com um nome claro, por exemplo:
   - `fix/ajustar-atalho-de-comando`
   - `feature/integracao-chat`
3. Faça as alterações necessárias.
4. Teste localmente e confirme que o projeto compila.
5. Abra um pull request com uma descrição clara do que foi alterado e por quê.

## Configuração do ambiente

```bash
git clone https://github.com/britors/OpenBase.Vscode.git
cd OpenBase.Vscode
npm install
```

> É recomendado usar o Visual Studio Code para desenvolver esta extensão.

## Compilar o projeto

Execute o comando abaixo para gerar os artefatos de build:

```bash
npm run compile
```

O script usa o TypeScript Compiler (`tsc`) com a configuração definida em `tsconfig.json`.

## Executar no VS Code

1. Abra o projeto no VS Code.
2. Pressione `F5` para iniciar o `Extension Development Host`.

## Estilo de código

- Use TypeScript consistente com o restante do projeto.
- Prefira `camelCase` para nomes de variáveis e funções.
- Mantenha as alterações pequenas e focadas sempre que possível.

## Boas práticas

- Atualize o `README.md` se houver mudanças na experiência de uso ou nos comandos disponíveis.
- Adicione comentários úteis quando a lógica for complexa.
- Verifique se os nomes de comando e contribuições no `package.json` permanecem consistentes.

## Agradecimentos

Obrigado por ajudar a melhorar o OpenBase! Cada contribuição torna a extensão mais robusta e útil para toda a comunidade.
