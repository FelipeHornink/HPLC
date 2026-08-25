# HPLC — PLC Codex Simulator

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.85-007ACC.svg)](https://code.visualstudio.com/)
[![IEC 61131-3](https://img.shields.io/badge/IEC%2061131--3-Structured%20Text-555.svg)](https://en.wikipedia.org/wiki/IEC_61131-3)

Extensão do VS Code que transforma uma pasta de **Structured Text** (IEC 61131-3) num
soft-PLC rodando de verdade: compila, executa com scan de tempo fixo, e serve no navegador
uma **bancada de comandos** e uma **visão P&ID** ligadas às tags do programa. Serve para
projetar, simular e testar a lógica de um equipamento antes de existir hardware.

É um simulador de engenharia. **Não é controlador de segurança certificado** e não deve
comandar processo real.

## Como funciona

```
types/ globals/ blocks/ programs/ routines/     seus fontes em ST
              ↓  runtime/build.py               junta na ordem do scan, resolve (* @ROUTINE *)
      .plcsim/build/project.st                  um único ST consolidado
              ↓  STruC++                        gera C++
              ↓  g++ + runtime/main.cpp         binário do PLC
      plc-runtime                               scan de 10 ms + servidor HTTP
              ↓
   :8100 bancada de comandos   :8101 visão P&ID   /api/* leitura e escrita de tag
```

O runtime expõe cada variável global do programa por HTTP, então a bancada é só uma página
lendo e escrevendo tag — sem nada compilado dentro dela. Editar a tela não recompila o PLC.

## Requisitos

| | |
|---|---|
| VS Code | ≥ 1.85 |
| Python 3 | monta o projeto e gera o catálogo de variáveis |
| g++ | compila o C++ gerado (C++17) |
| [STruC++](https://github.com/Autonomy-Logic/STruCpp/releases) | compilador ST → C++, esperado em `~/.local/strucpp` |

O STruC++ **não vai neste repositório**: é projeto de terceiros (GPL-3 com exceção de
runtime) e você baixa o binário oficial. Em Windows sem WSL2, `setup-windows.ps1` prepara a
máquina (Git for Windows + MSYS2, que é o toolchain local com os headers POSIX de socket que
o runtime usa).

## Instalação

Este repositório guarda o **bundle da extensão já montado** — `empacotar.sh` zipa no layout
`.vsix` e instala:

```bash
git clone git@github.com:FelipeHornink/HPLC.git
cd HPLC
./empacotar.sh          # gera dist/plc-codex-<versao>.vsix e instala no VS Code
```

Depois, no VS Code: **Developer: Reload Window**.

## Primeiros passos

1. `PLC Codex: Novo Projeto PLC` — nasce a estrutura completa a partir do template
2. `PLC Codex: Build` — compila
3. `PLC Codex: Play` — sobe o runtime
4. `PLC Codex: Abrir Comandos` — a bancada no navegador

Na barra lateral ficam três painéis: **Projetos PLC** (árvore de projetos e rotinas),
**PLCs em execução** (o que está de pé, com play/stop) e **Depuração ao vivo** (todas as
tags, com escrita e força).

## A bancada

A tela é configurada em `panel/painel.json` — quais tags aparecem, em que quadro, com que
rótulo e unidade. Nenhuma tag é adivinhada por nome.

- **Quadros**: monitoramento da operação, IHM (com abas), porta do painel, interface com o
  cliente, campo/equipamento e comunicação.
- **Simulação por ponto**: cada item pode declarar `"simulation_flag"` com a tag que liga a
  simulação daquele ponto e a tag do valor simulado. A linha então mostra três controles — a
  marca que liga/desliga, o **valor simulado** e o **valor físico**, lado a lado, com
  destaque no que o programa está usando naquele instante.
- **Barra de simulação**: mostra a rotina de simulação do projeto lida do disco, linha a
  linha, com o valor que cada uma escreve e seta de subindo/descendo.
- **Tendências**: marque tags com ☆ na lista de variáveis para plotar.
- **Editar tela** e **Editar P&ID**: monta os quadros e posiciona os objetos do P&ID pelo
  próprio navegador, gravando de volta no JSON do projeto.

## Anatomia de um projeto

```text
types/       DUTs e estruturas
globals/     listas VAR_GLOBAL por camada (IO, processo, controle, supervisão…)
blocks/      FUNCTION_BLOCK reutilizáveis
programs/    Main, com a ordem fixa do scan
routines/    as rotinas, incluídas no Main por (* @ROUTINE arquivo.st *)
panel/       bancada (painel.json) e visão P&ID (pid.json)
tests/       cenários de teste do equipamento
runtime/     build, servidor, exportador e validadores
plc.toml     nome, portas, diretórios de fonte e a [[task]] (intervalo do scan)
io.toml      mapa de I/O físico do equipamento
modbus.toml  mapa Modbus TCP/IP, quando houver
```

`(* @ROUTINE *)` é expandido recursivamente: uma rotina pode chamar sub-rotinas, o que
permite manter o `Main` com exatamente os steps do padrão da sua engenharia, sem que
adaptações de equipamento virem steps novos.

## PLCopen XML

- `PLC Codex: Importar PLCopenXML` traz um projeto de fabricante (inclusive lógica em Ladder,
  convertida para ST) para a estrutura acima.
- `PLC Codex: Exportar PLCopenXML` gera o XML da aplicação (só a lógica, formato da norma),
  o XML completo (para voltar ao projeto de origem) e o ST consolidado.

O export foi validado importando no **CODESYS 3.5 SP22**. A receita e os defeitos de
interoperabilidade encontrados estão em [`docs/EXPORT-PARA-OUTROS-CPS.md`](docs/EXPORT-PARA-OUTROS-CPS.md).

## Testes

`PLC Codex: Executar Cenários de Teste` roda a bateria do projeto contra um runtime próprio,
em porta separada: partida, trip, intertravamento, abuso de operador, comunicação e a
disciplina da simulação. O projeto de exemplo já vem com cenários.

## Limitações conhecidas

- **Este repositório não é o código-fonte da extensão**: `extension.js` é o bundle pronto.
  Correções aqui precisam ser portadas para o fonte oficial.
- **Passo de linha está inerte** desde a troca do MATIEC para o STruC++: o C++ gerado não tem
  ponto de depuração, então *Passo de rotina* e *Passo de linha* não param onde prometem.
  Passo de scan funciona.
- O STruC++ 0.6.3 tem três defeitos de geração que o build contorna — o porquê da troca de
  compilador e a medição estão em [`docs/AVALIACAO-STRUCPP.md`](docs/AVALIACAO-STRUCPP.md).
- Cada projeto carrega a **sua própria cópia** de `runtime/`: projeto antigo continua com o
  build antigo até você atualizar a pasta.

## Estrutura do repositório

```text
extension.js            bundle da extensão
package.json            comandos, views e menus
syntaxes/               gramática TextMate do ST (iec-st)
template/projeto-plc/   projeto modelo completo, com runtime e testes
docs/                   avaliação do compilador e receita de export
empacotar.sh            reempacota como .vsix e instala
setup-windows.ps1       prepara máquina Windows sem WSL2
```

## Licença

[MIT](LICENSE). O compilador STruC++ é externo, não é distribuído aqui, e tem licença
própria (GPL-3 com exceção de runtime).

---

**English summary** — HPLC (PLC Codex Simulator) is a VS Code extension that turns a folder
of IEC 61131-3 Structured Text into a running soft-PLC: it compiles the sources through
STruC++ and g++, runs them on a fixed-interval scan, and serves a browser-based control bench
and P&ID view wired to the program's tags. It also imports and exports PLCopen XML (validated
against CODESYS 3.5 SP22) and runs scenario test suites. Engineering simulator only — not a
certified safety controller. UI and docs are in Brazilian Portuguese.
