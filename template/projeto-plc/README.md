# Compressor Básico — PLC Codex

Projeto portátil em Structured Text baseado na IEC 61131-3 e na organização do
documento `Automacao.pdf` da HBR. É um simulador de engenharia, não um controlador
de segurança certificado.

## Estrutura

```text
types/       DUTs e estruturas
globals/     IO, PROCESSO, CONTROLE, SUPERVISAO e RETENTIVOS
blocks/      FB_InstrumentoAnalogico, FB_Motor e FB_Valvula
programs/    Main, responsável pela ordem fixa do scan
routines/    13 rotinas funcionais da especificação Automacao.pdf
panel/       bancada de comandos e visão P&ID
tests/       cenários de partida e trip
runtime/     compilação STruC++, servidor e exportador
export/      PLCopenXML e ST consolidado gerados
```

Somente as pastas declaradas em `source_directories` no `plc.toml` pertencem ao
projeto ativo. A referência extraída do XML original fica fora deste repositório,
em `../referencias-mastertool/`.

## Estados do compressor

| Estado | Função |
|---:|---|
| 0 | Desligado |
| 1 | Verificação de permissivos |
| 10 | Ligação dos auxiliares |
| 11 | Manutenção |
| 20 | Alívio automático |
| 30 | Em carga |
| 40 | Alívio manual |
| 100 | Parada segura por trip |

O trip possui prioridade absoluta. A saída de S100 exige emergência saudável e
pulso explícito de RESET.

## Compilação e valores online

Ao clicar em Play, `runtime/build.py` reúne os DUTs, funções, FBs, GVLs e
programas em uma unidade IEC. O compilador matiec (`iec2c`) valida o ST e gera C;
o GCC cria o executável nativo `.plcsim/build/plc-runtime`. Esse processo executa
o programa indicado por `[[task]].program` no `plc.toml` (`Main`, neste teste)
no intervalo configurado e mantém os valores na memória, protegidos contra
acesso simultâneo.

Após a compilação, `runtime/generate_variable_catalog.py` deriva a árvore online
diretamente das declarações em `types/`, `blocks/`, `globals/` e no programa de
entrada. Portanto `/api/variables` não possui uma lista manual nem aliases: uma
tag como `InputsDigitais.PermissivoCliente` tem exatamente o caminho declarado
no ST.

O painel escreve entradas pela API local `/api/set`; a alteração entra na memória
imediatamente e é consumida no próximo scan. `/api/state` fornece o resumo do
equipamento e `/api/variables` fornece a árvore completa. O clique é refletido
localmente sem esperar a rede. Depois disso, o runtime envia estado e variáveis
continuamente por SSE, acompanhando o scan, sem polling do navegador. O VS Code
atualiza as decorações do ST a cada 200 ms. Não há banco de dados nesta versão:
ao parar o processo, seus valores online são descartados.

O runtime publica duas páginas independentes. A bancada de comandos usa a porta
principal (`panel_port`, 8100) e contém IHM, porta física, interface do cliente e
campo, além de uma faixa superior configurável de monitoramento operacional. Ela
nunca prepara permissivos nem executa sequências automaticamente. A
visão de processo usa a porta seguinte (`pid_port`, 8101) e apresenta o fluxo do
equipamento com variáveis posicionadas sobre um P&ID simplificado.

As duas páginas oferecem temas claro e escuro e navegação direta entre Comandos
e P&ID. Valores `REAL/LREAL` usam duas casas decimais por padrão; a precisão pode
ser configurada globalmente em `display.realPrecision` ou por item com
`precision` nos arquivos JSON do painel.

## Modos online no VS Code

A seção `PLCs em execução` concentra o estado, número do scan, rotinas e comandos
de cada runtime:

- **Ao vivo:** executa automaticamente em ciclos de 10 ms.
- **Pausar:** termina o scan atual e congela o relógio lógico.
- **Próximo scan:** executa exatamente um ciclo completo.
- **Passo de rotina:** pausa na entrada de cada um dos 13 arquivos de rotina.
- **Passo de linha:** pausa antes de uma instrução ST e avança uma linha por clique.

O build usa o mapa de linhas do matiec e instrumenta somente o C intermediário em
`.plcsim/`. A linha atual e as linhas executadas aparecem diretamente nos arquivos
ST, que permanecem inalterados.

Todas as variáveis publicadas aceitam `Escrever uma vez`. A ação `Forçar` reaplica
o valor durante a execução, mesmo quando o ST tenta sobrescrevê-lo; `Remover força`
devolve o controle ao programa.

## Teste no VS Code

Use o ícone PLC Codex, clique em Play e abra **Comandos**. Na tela:

1. ative Emergência saudável;
2. ative Permissivo cliente;
3. pressione RESET;
4. pressione LIGA;
5. observe `0 → 1 → 10 → 20 → 30`;
6. desligue Emergência saudável para validar o trip S100;
7. abra **P&ID** para acompanhar motor, válvula, pressão e temperatura.

A seção `Depuração ao vivo` é o painel dinâmico recomendado. Ela atualiza apenas
os valores que mudaram, possui busca e pastas aninhadas por DB/estrutura e permite
escrever, forçar e liberar variáveis. Os controles de execução ficam no cartão
do respectivo PLC, evitando duplicação. Não há recarga da página nem reconstrução
da árvore do VS Code.

Com o runtime ativo, qualquer arquivo `.st` aberto mostra valores online ao lado
das linhas, como uma decoração do editor. Esses valores não alteram nem sujam o
arquivo-fonte. O botão `Variáveis` da tela Equipamento abre a lista crua completa.

## Exportar para MasterTool/CODESYS

Execute `PLC Codex: Exportar PLCopenXML` ou:

```bash
./runtime/export.sh
```

São gerados:

```text
export/Compressor_PLC_Codex.xml
export/Compressor_Completo.st
```

No MasterTool IEC XE/CODESYS, faça a importação em uma cópia do projeto original
usando `Project/Projeto → Import PLCopenXML`. Importe DUTs, GVLs, FBs e o programa
`Main`. Mantenha no projeto original a configuração do dispositivo Altus, módulos,
bibliotecas proprietárias e mapeamento físico; associe depois as variáveis de
`00_GVL_IO` aos canais reais.

Se a versão do fabricante rejeitar algum elemento XML, use
`Compressor_Completo.st` ou os arquivos individuais para criar os objetos e colar
as declarações/implementações. Essa alternativa é deliberadamente mantida para não
prender o projeto a um fabricante.

Os pontos de pausa, APIs e mapas de depuração não entram no ST consolidado nem no
PLCopenXML; a instrumentação existe apenas no diretório de build ignorado pelo Git.

## Objetos recuperados do projeto original

`../referencias-mastertool/` contém os 21 POUs encontrados em
`4817_COBRA_20260304_OK_9.xml`, incluindo `SIMULACAO`, `Interlocks`,
`Controle_motores`, espelhamentos e alarmes. As 18 rotinas ST estão em `pous/`.
As três rotinas Ladder (`UserPrg`, `StartPrg` e `horimetros`) têm suas redes
preservadas nos arquivos `.ld.xml`, pois não existe texto ST equivalente no XML.

Essa pasta é intencionalmente apenas uma referência navegável: o build continua
usando somente `types/`, `functions/`, `blocks/`, `globals/` e `programs/`. Para
refazer a extração de outro PLCopenXML:

```bash
python3 runtime/import_plcopenxml.py caminho/projeto.xml ../referencias-mastertool
```

## Teste automatizado

```bash
python3 tests/test_runtime.py
```

O teste compila e executa o ST real, valida recuperação de trip, partida, entrada
em carga, parada imediata por emergência e disponibilidade das variáveis online.
