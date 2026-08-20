# Avaliacao: STruC++ como alternativa ao MATIEC

Medido em 2026-08-20 com **STruC++ v0.6.3** (binario oficial `strucpp-linux-x64`,
Autonomy Logic) contra o projeto `4817_funcional_A.xml` ja importado.

O toolchain atual usa MATIEC (`iec2c`, versao 0.1, do OpenPLC). Ele rejeita
construcoes correntes no codigo Altus, e por isso o projeto anterior precisou de
uma camada de traducao escrita a mao com 86 transformacoes.

## O que o STruC++ resolve sozinho

Cada linha abaixo foi compilada isoladamente com `strucpp <arquivo>.st -o saida.cpp`.

| Construcao | MATIEC | STruC++ | Transformacoes que deixam de ser necessarias |
|---|---|---|---|
| `ARRAY [0..31] OF TON` com `t[i](IN := x)` e `t[i].Q` | rejeita | **aceita** | `matiec.indexed-ton-array.bank` e `.support` |
| Comentario `//` de linha | rejeita | **aceita** | `iec.comment.line-to-block` (14 ocorrencias) |
| `PROGRAM` chamando outro `PROGRAM` | rejeita | **aceita** | `matiec.program-as-fb` (17 ocorrencias) |
| `UPPER_BOUND(array, 1)` | rejeita | **aceita** | `matiec.upper-bound.constant` (5) |
| `END_IF` sem ponto e virgula | rejeita | **aceita** | `iec.control-statement.semicolon` (14) |
| `REAL := 0` e `BOOL := 1` | rejeita | **aceita** | `iec.real-literal.explicit` (3) |

## O que continua sendo necessario

**Acesso qualificado pela GVL.** `Field.Valvula[i].failToClose` falha nos dois
compiladores: `error: Undeclared variable 'FIELD'`. O nome da GVL nao e namespace
em IEC. A traducao para struct (`altus.qualified-gvl.struct-view`, 21 ocorrencias)
continua obrigatoria, e foi confirmada funcional no STruC++.

Ela nao e cosmetica. Compilando o projeto real com stubs para os tipos de
biblioteca, sobraram exatamente dois erros:

```
error: Type mismatch for VAR_EXTERNAL 'AO' in program 'MAINPRG':
       expected '__INLINE_ARRAY_INT' but found '__INLINE_ARRAY_REAL'
```

Tres GVLs declaram membros homonimos com tipos e tamanhos diferentes:

| GVL | membro | tipo |
|---|---|---|
| `Field` | `AO` | `ARRAY [0..48] OF INT` |
| `SField` | `AI`, `AO` | `ARRAY [0..31] OF REAL` |
| `RField` | `AI`, `AO` | `ARRAY [0..31] OF INT` |

Achatadas num unico espaco de nomes, elas colidem. Uma struct por GVL resolve.

**Tipos de biblioteca do fabricante.** `LibDataTypes.QUALITY` e os `T_DIAG_NX*`
nao existem fora do MasterTool. Alem de precisarem de stub, o ponto no nome do
tipo nao e aceito pelo parser e precisa ser achatado.

## Custo da troca

O `runtime/main.c` linka a saida do MATIEC (`Config0.c`, `Res0.c`,
`iec_std_lib.h`) e o `instrument_debug.py` injeta pontos de parada no `POUS.c`
usando as diretivas `#line`. O STruC++ gera C++17 com uma classe por POU
(`class ALARMESVALVULAS`, `class Program_MAINPRG : public ProgramBase`) e runtime
header-only proprio, incluindo REPL e runner de teste. Trocar de compilador
significa reescrever essa integracao e a instrumentacao de depuracao.

## Licenca

Compilador em GPL-3.0; o runtime C++ tem a excecao de biblioteca de runtime, que
permite distribuir o programa compilado sob qualquer licenca — o mesmo arranjo do
GCC. Adocao em produto da HBR precisa de validacao juridica e de seguranca antes,
como qualquer ferramenta externa.

## Referencias

- https://github.com/Autonomy-Logic/STruCpp
- https://github.com/Autonomy-Logic/xml2st — transpilador PLCopen XML para ST,
  fork do Beremiz; vale como referencia para o conversor LD/FBD do importador.

## Medicao das GVLs do 4817_funcional_A

O XML traz **25 GVLs** com membros, organizadas em trincas: a imagem que a logica
usa, a versao simulada com prefixo `S` e a fisica com prefixo `R`.

`Field`/`SField`/`RField`, `Saida`/`SSaida`/`RSaida`,
`SaidaAnalogica`/`SSaidaAnalogica`/`RSaidaAnalogica`, mais `cmd`, `Reten`,
`Status`, `IHM`, `Estado`, `NETcmd`, `TREND` e `Debug`.

**37 nomes de membro se repetem em mais de uma GVL.** Alem das trincas, ha
colisao entre familias: `ALIVIO_MANUAL` esta em `cmd` e `IHM`,
`COMPRESSOR_LIGADO` em `Saida` e `Status`, `ESTADO_COMPRESSOR` em `Status` e
`IHM`. Achatar tudo num `VAR_GLOBAL` unico e impossivel.

Varrendo `programs/` e `blocks/` sem comentarios: **908 referencias a membro de
GVL, todas na forma qualificada** (`field.DI[0]`, `Reten.ResumoTrip`). Zero
referencias sem o nome da GVL. Os quatro casos que pareciam soltos eram
`field.Transmissor[i].AlarmEnable`, ou seja campo de struct, nao GVL.

Consequencia: gerar uma struct por GVL e uma variavel global com o nome dela
resolve tudo sem tocar em nenhuma linha da logica. A conversao e mecanica.

Casos de borda testados no STruC++, todos aceitos:

| Caso | Resultado |
|---|---|
| membro `Range` cujo tipo tambem se chama `Range` | aceita (no MATIEC exigia renomear) |
| GVL sem membros virando struct vazia | aceita |
| tipo de biblioteca com o ponto achatado (`LibDataTypes_QUALITY`) | aceita |

## Por que o nome da GVL nao cabe no ST

O requisito e que os fontes em `programs/`, `blocks/` e `globals/` sejam copiaveis
direto para o MasterTool, Siemens ou Rockwell. Isso limita o que pode ser escrito
neles, e a limitacao nao e do nosso ferramental nem do compilador: e da linguagem.

No XML exportado pelo MasterTool a GVL aparece como atributo de um objeto:

```
project > instances > configurations > configuration > resource > globalVars
   atributos: {'name': 'Field'}
   filhos: ['addData', 'variable']
```

Nao existe corpo ST em nenhuma `globalVars` do XML — verificado no
`4817_funcional_A.xml`. O nome da gaveta e propriedade do objeto na arvore do
projeto, nunca texto dentro do ST. Em ST, `VAR_GLOBAL` e anonimo por definicao.

Por isso `Field.AO` nao se resolve a partir do ST sozinho: o texto diz "o AO de
Field", mas nenhum arquivo ST declara que existe algo chamado `Field`.

Sintaxes testadas no STruC++, todas rejeitadas, porque nenhuma existe na norma:

| Tentativa | Resultado |
|---|---|
| `VAR_GLOBAL Field ... END_VAR` | `Expected Colon, found identifier AO` |
| `NAMESPACE Field ... END_NAMESPACE` | `Expected EOF, found NAMESPACE` |
| `CONFIGURATION Field` com `VAR_GLOBAL` | `Undeclared variable 'FIELD'` |
| `RESOURCE Field` com `VAR_GLOBAL` | `Expected END_RESOURCE, found VAR_GLOBAL` |

Consequencia de projeto: pedir suporte a GVL nomeada no compilador nao resolveria,
porque exigiria inventar sintaxe fora da norma — e ST com sintaxe inventada deixa
de ser copiavel para o MasterTool, que era o requisito inicial.

A traducao para struct fica onde ja esta previsto no contrato de `platform/`: na
copia descartavel em `.plcsim/generated/src`. Os fontes oficiais seguem sendo uma
GVL por arquivo, e a struct gerada recebe o mesmo nome da gaveta, de modo que
`SField.AI[0]` e o que se le tanto no fonte quanto na depuracao e no painel.

## Compilacao completa do 4817 no STruC++

Alcancada em 2026-08-20. `Compilation successful!`, 773 KB de C++, zero erros e
dois avisos de conversao implicita que ja existem no codigo do fabricante.

Foi necessario, alem do achatamento das GVLs e do VAR_EXTERNAL em toda POU:

1. **Mover as 4 instancias de TIMER_RET** da GVL `Reten` para dentro do
   `horimetros`, como `VAR RETAIN`. O STruC++ v0.6.3 nao chama instancia de FB
   declarada como global: *"Calling a shared function-block global is not yet
   supported — scalar globals only for now."* Sao os horimetros dos 4 motores;
   nada na logica le os acumulados, entao a mudanca nao afeta o processo.
2. **Substituir as 3 chamadas de biblioteca do fabricante** por variaveis do
   proprio projeto: `SysTimeCore.SysTimeGetUs`, `GetDateAndTime` e
   `NextoStandard.GetDayOfWeek`. Quem preenche muda por PLC.
3. **Deixar os 9 structs de diagnostico de hardware fora** do executavel
   portatil. Eles estao alocados em `%QB` e nao entram na simulacao.

Os passos 1 a 3 ainda estao feitos por script avulso; falta leva-los para o
importador e para o build.
